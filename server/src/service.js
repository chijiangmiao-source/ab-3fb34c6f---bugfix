import { digestParams } from './digest.js'
import { tx } from './db.js'

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_PARAMS_BYTES = 64 * 1024

/**
 * 发布状态机核心。通过依赖注入 db 与 simulator，便于单元测试。
 *
 * 不变式：
 *  1. release_key 唯一；同标识同载荷 → 返回原结果；同标识异载荷 → 409 冲突。
 *  2. 回执先由设备模拟器确认（幂等暂存），再落库；落库前崩溃由 reconcile 补记。
 *  3. 仅当全部目标回执摘要与发布摘要一致时，才在单事务中原子推进生效代次，
 *     发布随之进入 activating（逐台最终切换进行中）。
 *  4. 任一设备暂存摘要不符 → failed，永不推进代次，判负为终态。
 *  5. 仅当全部目标采集器确认实际生效的发布编号、摘要、代次均与本发布一致时，
 *     发布才由 activating 置为 published；在此之前页面与接口一律不得显示已发布。
 *  6. 任一时刻至多一个发布处于 activating：前序发布未完成生效前，
 *     后续发布不得获得代次、不得越过尚未完成的生效顺序。
 *  7. 进程在最终切换途中退出：activations 表记录已确认设备，重启后
 *     reconcile 继续核对并补齐未完成设备，代次不重复推进。
 */
export function createService({ db, simulator, knownDevices = [], now = () => new Date().toISOString() }) {
  const q = {
    insertRelease: db.prepare(
      `INSERT INTO releases (release_key, digest, params, targets, status, created_at)
       VALUES (?, ?, ?, ?, 'staging', ?)`
    ),
    byKey: db.prepare('SELECT * FROM releases WHERE release_key = ?'),
    byId: db.prepare('SELECT * FROM releases WHERE id = ?'),
    list: db.prepare('SELECT * FROM releases ORDER BY id DESC'),
    insertReceipt: db.prepare(
      `INSERT OR IGNORE INTO receipts (release_id, device_id, digest, staged_at, recorded_at)
       VALUES (?, ?, ?, ?, ?)`
    ),
    receipts: db.prepare('SELECT * FROM receipts WHERE release_id = ? ORDER BY device_id'),
    markFailed: db.prepare(`UPDATE releases SET status = 'failed' WHERE id = ? AND status = 'staging'`),
    maxGeneration: db.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM generations'),
    insertGeneration: db.prepare(
      'INSERT INTO generations (generation, release_id, published_at) VALUES (?, ?, ?)'
    ),
    markActivating: db.prepare(
      `UPDATE releases SET status = 'activating', generation = ?
       WHERE id = ? AND status = 'staging'`
    ),
    markPublished: db.prepare(
      `UPDATE releases SET status = 'published', published_at = ?
       WHERE id = ? AND status = 'activating'`
    ),
    activatingCount: db.prepare(`SELECT COUNT(*) AS c FROM releases WHERE status = 'activating'`),
    activatingIds: db.prepare(
      `SELECT id FROM releases WHERE status = 'activating' ORDER BY generation, id`
    ),
    stagingIds: db.prepare(`SELECT id FROM releases WHERE status = 'staging' ORDER BY id`),
    upsertActivation: db.prepare(
      `INSERT INTO activations (release_id, device_id, active_release_id, digest, generation, activated_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id, device_id) DO UPDATE SET
         active_release_id = excluded.active_release_id,
         digest            = excluded.digest,
         generation        = excluded.generation,
         activated_at      = excluded.activated_at,
         recorded_at       = excluded.recorded_at`
    ),
    activation: db.prepare('SELECT * FROM activations WHERE release_id = ? AND device_id = ?'),
    activations: db.prepare('SELECT * FROM activations WHERE release_id = ? ORDER BY device_id'),
    currentGeneration: db.prepare(
      `SELECT g.generation, g.release_id, r.release_key, r.published_at
       FROM generations g JOIN releases r ON r.id = g.release_id
       WHERE r.status = 'published'
       ORDER BY g.generation DESC LIMIT 1`
    ),
  }

  function validate(input) {
    const { releaseKey, targets, params } = input ?? {}
    if (typeof releaseKey !== 'string' || !KEY_RE.test(releaseKey)) {
      throw new ApiError(400, 'INVALID_RELEASE_KEY', '发布标识需为 1-64 位，以字母或数字开头，可含 . _ -')
    }
    if (typeof params !== 'string' || params.length === 0) {
      throw new ApiError(400, 'INVALID_PARAMS', '参数文本不能为空')
    }
    if (Buffer.byteLength(params, 'utf8') > MAX_PARAMS_BYTES) {
      throw new ApiError(400, 'PARAMS_TOO_LARGE', '参数文本超过 64KB 限制')
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ApiError(400, 'INVALID_TARGETS', '目标采集器至少选择一台')
    }
    const uniq = [...new Set(targets)]
    for (const t of uniq) {
      if (typeof t !== 'string' || t.length === 0 || t.length > 64) {
        throw new ApiError(400, 'INVALID_TARGETS', '目标采集器标识非法')
      }
      if (knownDevices.length > 0 && !knownDevices.includes(t)) {
        throw new ApiError(400, 'UNKNOWN_DEVICE', `未知采集器: ${t}`, { knownDevices })
      }
    }
    return { releaseKey, targets: uniq, params }
  }

  /** 设备报告的生效信息是否与本发布完全一致（发布编号 + 摘要 + 代次）。 */
  function activationMatches(observed, row) {
    return (
      observed != null &&
      observed.releaseId === row.id &&
      observed.digest === row.digest &&
      observed.generation === row.generation
    )
  }

  function activationConfirmed(row, deviceId) {
    const a = q.activation.get(row.id, deviceId)
    return (
      a != null &&
      a.active_release_id === row.id &&
      a.digest === row.digest &&
      a.generation === row.generation
    )
  }

  function toDto(row) {
    const targets = JSON.parse(row.targets)
    const receipts = q.receipts.all(row.id).map((r) => ({
      deviceId: r.device_id,
      digest: r.digest,
      stagedAt: r.staged_at,
      recordedAt: r.recorded_at,
      matches: r.digest === row.digest,
    }))
    const activations = q.activations.all(row.id).map((a) => ({
      deviceId: a.device_id,
      releaseId: a.active_release_id, // 设备实际生效的发布编号
      digest: a.digest, // 设备实际生效的摘要
      generation: a.generation, // 设备实际生效的代次
      activatedAt: a.activated_at,
      recordedAt: a.recorded_at,
      matches:
        a.active_release_id === row.id && a.digest === row.digest && a.generation === row.generation,
    }))
    return {
      id: row.id,
      releaseKey: row.release_key,
      digest: row.digest,
      params: row.params,
      targets,
      status: row.status, // 汇总阶段：staging | activating | published | failed
      generation: row.generation, // 生效代次（未指派为 null）
      createdAt: row.created_at,
      publishedAt: row.published_at,
      receipts,
      activations,
      summary: {
        expected: targets.length,
        received: receipts.length,
        matched: receipts.filter((r) => r.matches).length,
        confirmed: activations.filter((a) => a.matches).length,
      },
    }
  }

  function getRelease(id) {
    const row = q.byId.get(id)
    if (!row) throw new ApiError(404, 'RELEASE_NOT_FOUND', `发布编号 ${id} 不存在`)
    return toDto(row)
  }

  function listReleases() {
    return q.list.all().map(toDto)
  }

  /** 记录一台设备的回执（INSERT OR IGNORE：首个已确认事实为准）。 */
  function recordReceipt(releaseId, deviceId, digest, stagedAt) {
    q.insertReceipt.run(releaseId, deviceId, digest, stagedAt, now())
  }

  /** 记录设备报告的生效信息（UPSERT：每次核对以最新观察为准，是否一致在读取时判定）。 */
  function recordActivation(releaseId, deviceId, observed) {
    q.upsertActivation.run(
      releaseId,
      deviceId,
      observed.releaseId,
      observed.digest,
      observed.generation,
      observed.activatedAt,
      now()
    )
  }

  /** 向单台设备幂等暂存并落回执；设备已持异载荷时记录其实际摘要（将由 evaluate 判负）。 */
  async function stageAndRecord(row, deviceId) {
    try {
      const staged = await simulator.stage(deviceId, {
        releaseId: row.id,
        digest: row.digest,
        params: row.params,
      })
      recordReceipt(row.id, deviceId, staged.digest, staged.stagedAt)
    } catch (err) {
      if (err.status === 409) {
        // 设备上同一发布编号已是其他载荷：核对其实际内容并如实落回执
        try {
          const held = await simulator.getStage(deviceId, row.id)
          if (held) recordReceipt(row.id, deviceId, held.digest, held.stagedAt)
        } catch { /* 设备不可达，留待 reconcile */ }
      }
      // 网络类失败不落回执，保持 staging，等待 reconcile 补记
    }
  }

  /**
   * 汇总评估（staging 分支）：
   *  全部目标回执齐备且全匹配 → 单事务原子推进代次并置 activating；
   *  任一不符 → failed，代次不动；
   *  另有发布尚在生效切换中 → 保持 staging，不得越过其生效顺序。
   */
  function evaluate(id) {
    const row = q.byId.get(id)
    if (!row || row.status !== 'staging') return
    const targets = JSON.parse(row.targets)
    const byDevice = new Map(q.receipts.all(id).map((r) => [r.device_id, r]))
    if (!targets.every((t) => byDevice.has(t))) return // 仍有设备未回执，保持 staging

    const allMatch = targets.every((t) => byDevice.get(t).digest === row.digest)
    if (!allMatch) {
      q.markFailed.run(id)
      return
    }
    tx(db, () => {
      const cur = q.byId.get(id)
      if (cur.status !== 'staging') return // 并发下已被推进
      if (q.activatingCount.get().c > 0) return // 前序发布尚未完成生效，保持暂存等待
      const generation = q.maxGeneration.get().g + 1
      const ts = now()
      q.insertGeneration.run(generation, id, ts)
      q.markActivating.run(generation, id)
    })
  }

  /**
   * 推进一个 activating 发布的逐台最终切换：
   *  已确认设备跳过；未确认设备先核对其当前实际生效内容，
   *  不一致则下发切换指令，并把设备实际报告如实落库。
   *  全部目标确认一致 → 单事务置 published（终态），返回是否本次完成。
   */
  async function activateRelease(row) {
    const targets = JSON.parse(row.targets)
    for (const deviceId of targets) {
      if (activationConfirmed(row, deviceId)) continue
      let observed = null
      try {
        observed = await simulator.getActive(deviceId)
      } catch { /* 设备暂不可达，随后尝试切换 */ }
      if (!activationMatches(observed, row)) {
        try {
          observed = await simulator.activate(deviceId, {
            releaseId: row.id,
            digest: row.digest,
            generation: row.generation,
          })
        } catch {
          // 设备拒绝（如生效内容被更高代次占据、暂存内容不符）或不可达：
          // 核对其实际生效内容并如实落库，发布保持 activating，不得认定为完成
          try {
            observed = await simulator.getActive(deviceId)
          } catch { observed = null }
        }
      }
      if (observed) recordActivation(row.id, deviceId, observed)
    }
    const allConfirmed = targets.every((t) => activationConfirmed(row, t))
    if (!allConfirmed) return false
    tx(db, () => {
      const cur = q.byId.get(row.id)
      if (cur.status !== 'activating') return // 并发下已被推进
      q.markPublished.run(now(), row.id)
    })
    return true
  }

  /**
   * 生效管道：任一时刻至多一个发布处于逐台切换。
   * 先驱动当前 activating 发布；其全部目标确认生效后，
   * 再按创建顺序让回执已齐备的 staging 发布依次获得代次并进入切换。
   */
  async function drainPipeline() {
    for (;;) {
      const activating = q.activatingIds.all()
      if (activating.length > 0) {
        const done = await activateRelease(q.byId.get(activating[0].id))
        if (!done) return // 仍有设备未确认，保持 activating，下轮再核
        continue
      }
      let promoted = false
      for (const { id } of q.stagingIds.all()) {
        evaluate(id)
        if (q.byId.get(id).status === 'activating') {
          promoted = true
          break
        }
      }
      if (!promoted) return
    }
  }

  /** 对 staging 发布逐台核对并补记缺失回执；设备未暂存则幂等补发。 */
  async function backfillReceipts(row) {
    const targets = JSON.parse(row.targets)
    const recorded = new Set(q.receipts.all(row.id).map((r) => r.device_id))
    for (const deviceId of targets) {
      if (recorded.has(deviceId)) continue
      try {
        const held = await simulator.getStage(deviceId, row.id)
        if (held) {
          recordReceipt(row.id, deviceId, held.digest, held.stagedAt) // 补记
        } else {
          await stageAndRecord(row, deviceId) // 设备迟到/未收：幂等重发
        }
      } catch { /* 设备暂不可达，保持 staging，下轮再核 */ }
    }
  }

  /** 创建发布意图并同步暂存；同标识重传先推动恢复再返回与当前阶段一致的结果。 */
  async function createRelease(input) {
    const { releaseKey, targets, params } = validate(input)
    const digest = digestParams(params)

    const existing = q.byKey.get(releaseKey)
    if (existing) {
      if (existing.digest !== digest) {
        throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在且载荷不同`, {
          existingReleaseId: existing.id,
          existingDigest: existing.digest,
        })
      }
      // 同标识同载荷：幂等。若发布尚未完结（暂存中/生效中），
      // 本次重传一并驱动核对补齐，返回与当前恢复阶段一致的结果。
      const release = await reconcileRelease(existing.id)
      return { release, duplicate: true }
    }

    let id
    try {
      id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        const raced = q.byKey.get(releaseKey)
        if (raced && raced.digest === digest) {
          return { release: await reconcileRelease(raced.id), duplicate: true }
        }
        throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在且载荷不同`)
      }
      throw err
    }

    const row = q.byId.get(id)
    for (const deviceId of targets) {
      await stageAndRecord(row, deviceId)
    }
    evaluate(id)
    await drainPipeline()
    return { release: toDto(q.byId.get(id)), duplicate: false }
  }

  /**
   * 核对并补齐单个发布：
   *  staging    —— 补记缺失回执并评估；
   *  activating —— 继续逐台最终切换，全部确认一致才置 published；
   *  已完结（published/failed）—— 直接返回现状（幂等）。
   */
  async function reconcileRelease(id) {
    const row = q.byId.get(id)
    if (!row) throw new ApiError(404, 'RELEASE_NOT_FOUND', `发布编号 ${id} 不存在`)
    if (row.status === 'staging') {
      await backfillReceipts(row)
      evaluate(id)
    }
    await drainPipeline()
    return toDto(q.byId.get(id))
  }

  /** 重启后（以及周期性）对所有未完结发布做核对补齐：先补回执，再驱动生效管道。 */
  async function reconcileAll() {
    const pending = [...q.stagingIds.all(), ...q.activatingIds.all()].map((r) => r.id)
    for (const id of q.stagingIds.all().map((r) => r.id)) {
      const row = q.byId.get(id)
      if (!row || row.status !== 'staging') continue
      await backfillReceipts(row)
      evaluate(id)
    }
    await drainPipeline()
    return {
      reconciled: pending.map((id) => {
        const r = q.byId.get(id)
        return { id: r.id, status: r.status, generation: r.generation }
      }),
    }
  }

  /**
   * 测试钩子：复现“设备暂存成功但回执落库前进程退出”的崩溃窗口。
   * 意图已提交、设备已暂存，但不写任何回执、不做评估。
   */
  async function simulateCrashAfterStage(input) {
    const { releaseKey, targets, params } = validate(input)
    const digest = digestParams(params)
    if (q.byKey.get(releaseKey)) {
      throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在`)
    }
    const id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    for (const deviceId of targets) {
      try {
        await simulator.stage(deviceId, { releaseId: id, digest, params })
      } catch { /* 崩溃演练只关心已暂存成功的部分 */ }
    }
    // —— 此处即“进程退出”：回执未落库 ——
    return toDto(q.byId.get(id))
  }

  /**
   * 测试钩子：复现“全部回执匹配、代次已指派，进程在逐台最终切换途中退出”的崩溃窗口。
   * 回执齐备并已进入 activating，但仅前 n-1 台目标完成切换并落确认，
   * 最后一台保持旧生效版本（或尚无生效版本）。
   */
  async function simulateCrashDuringActivation(input) {
    const { releaseKey, targets, params } = validate(input)
    const digest = digestParams(params)
    if (q.byKey.get(releaseKey)) {
      throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在`)
    }
    const id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    const row = q.byId.get(id)
    for (const deviceId of targets) {
      await stageAndRecord(row, deviceId)
    }
    evaluate(id) // 回执齐备 → 指派代次并进入 activating
    const cur = q.byId.get(id)
    if (cur.status === 'activating') {
      const partial = targets.slice(0, Math.max(0, targets.length - 1))
      for (const deviceId of partial) {
        try {
          const observed = await simulator.activate(deviceId, {
            releaseId: id,
            digest,
            generation: cur.generation,
          })
          recordActivation(id, deviceId, observed)
        } catch { /* 崩溃演练只关心已切换成功的部分 */ }
      }
    }
    // —— 此处即“进程退出”：剩余目标尚未完成最终切换 ——
    return toDto(q.byId.get(id))
  }

  function currentGeneration() {
    const row = q.currentGeneration.get()
    if (!row) return { generation: null, releaseId: null, releaseKey: null, publishedAt: null }
    return {
      generation: row.generation,
      releaseId: row.release_id,
      releaseKey: row.release_key,
      publishedAt: row.published_at,
    }
  }

  return {
    createRelease,
    getRelease,
    listReleases,
    reconcileRelease,
    reconcileAll,
    simulateCrashAfterStage,
    simulateCrashDuringActivation,
    currentGeneration,
    knownDevices: () => [...knownDevices],
  }
}
