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
 *  3. 全部目标回执摘要一致 → 在单事务内预占生效代次并进入 activating；
 *     代次单调递增且与发布一一对应。
 *  4. 仅当全部目标采集器【实际生效】的发布编号、摘要、代次均与本次发布一致
 *     （以设备 GET /active 回报为准并落库 activations），发布才翻转为 published；
 *     此前页面与接口一律不得显示已发布。
 *  5. 任一设备暂存摘要不符 → failed，永不推进代次（判负为终态）。
 *  6. 存在尚未完成生效（activating）的发布时，后续发布不得越过其生效顺序。
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
    promoteToActivating: db.prepare(
      `UPDATE releases SET status = 'activating', generation = ?
       WHERE id = ? AND status = 'staging'`
    ),
    markPublished: db.prepare(
      `UPDATE releases SET status = 'published', published_at = ?
       WHERE id = ? AND status = 'activating'`
    ),
    markGenerationPublished: db.prepare(
      'UPDATE generations SET published_at = ? WHERE release_id = ?'
    ),
    currentGeneration: db.prepare(
      `SELECT g.generation, g.release_id, g.published_at, r.release_key
       FROM generations g JOIN releases r ON r.id = g.release_id
       WHERE r.status = 'published'
       ORDER BY g.generation DESC LIMIT 1`
    ),
    unfinishedIds: db.prepare(
      `SELECT id FROM releases WHERE status IN ('staging', 'activating') ORDER BY id`
    ),
    hasActivating: db.prepare(
      `SELECT 1 AS x FROM releases WHERE status = 'activating' LIMIT 1`
    ),
    insertActivation: db.prepare(
      `INSERT OR IGNORE INTO activations (release_id, device_id, generation, digest, activated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    activations: db.prepare('SELECT * FROM activations WHERE release_id = ? ORDER BY device_id'),
  }

  // 单进程内串行化所有推进/核对流程，避免并发评估与激活互相踩踏。
  let chain = Promise.resolve()
  const serialize = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
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
      digest: a.digest,
      generation: a.generation,
      activatedAt: a.activated_at,
      confirmedAt: a.confirmed_at,
      matches: a.digest === row.digest && a.generation === row.generation,
    }))
    return {
      id: row.id,
      releaseKey: row.release_key,
      digest: row.digest,
      params: row.params,
      targets,
      status: row.status, // 汇总阶段：staging | activating | published | failed
      generation: row.generation, // 生效代次（预占后可见；未预占为 null）
      createdAt: row.created_at,
      publishedAt: row.published_at,
      receipts,
      activations,
      summary: {
        expected: targets.length,
        received: receipts.length,
        matched: receipts.filter((r) => r.matches).length,
        activated: activations.filter((a) => a.matches).length,
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

  /** 记录一台设备“实际生效”的确认（首个已确认事实为准）。 */
  function recordActivation(releaseId, deviceId, generation, digest, activatedAt) {
    q.insertActivation.run(releaseId, deviceId, generation, digest, activatedAt, now())
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
   * 暂存阶段评估：全部目标回执齐备后，
   *  全匹配 → 单事务内预占代次并进入 activating（尚不是 published）；
   *  任一不符 → failed，代次不动。
   * 已有发布处于 activating 时不得预占新代次（不得越过尚未完成的生效顺序）。
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
      if (q.hasActivating.get()) return // 前序发布尚未完成生效，保持 staging 等待
      const generation = q.maxGeneration.get().g + 1
      const ts = now()
      q.insertGeneration.run(generation, id, ts)
      q.promoteToActivating.run(generation, id)
    })
  }

  /**
   * 生效阶段推进：逐台核对设备【实际生效】内容。
   *  - 设备已生效且 releaseId/digest/generation 与本次发布一致 → 落 activations 确认；
   *  - 设备未生效/生效内容不符 → 幂等重发 activate 后再次核对；
   *  - 设备暂存内容丢失或不符 → 先幂等补暂存再激活；
   *  - 设备不可达/拒绝 → 保持 activating，等待下轮核对。
   * 全部目标确认一致后，单事务翻转为 published；任一不符都不得翻转。
   */
  async function driveActivation(row) {
    const targets = JSON.parse(row.targets)
    for (const deviceId of targets) {
      try {
        const active = await simulator.getActive(deviceId)
        if (matchesActive(active, row)) {
          recordActivation(row.id, deviceId, active.generation, active.digest, active.activatedAt)
          continue
        }
        // 实际生效不符：先确认暂存内容可用，再激活，最后以设备回报为准核对
        const held = await simulator.getStage(deviceId, row.id)
        if (!held || held.digest !== row.digest) {
          await stageAndRecord(row, deviceId)
        }
        await simulator.activate(deviceId, {
          releaseId: row.id,
          digest: row.digest,
          generation: row.generation,
        })
        const confirmed = await simulator.getActive(deviceId)
        if (matchesActive(confirmed, row)) {
          recordActivation(row.id, deviceId, confirmed.generation, confirmed.digest, confirmed.activatedAt)
        }
      } catch { /* 设备不可达/拒绝：保持 activating，下轮再核 */ }
    }

    const confirmed = new Map(q.activations.all(row.id).map((a) => [a.device_id, a]))
    const allConfirmed = targets.every(
      (t) => confirmed.has(t) && confirmed.get(t).digest === row.digest && confirmed.get(t).generation === row.generation
    )
    if (!allConfirmed) return
    tx(db, () => {
      const cur = q.byId.get(row.id)
      if (cur.status !== 'activating') return
      const ts = now()
      q.markPublished.run(ts, row.id)
      q.markGenerationPublished.run(ts, row.id)
    })
  }

  function matchesActive(active, row) {
    return (
      active != null &&
      active.releaseId === row.id &&
      active.digest === row.digest &&
      active.generation === row.generation
    )
  }

  /** 推进单个发布至其可达的下一阶段（暂存核对 → 预占代次 → 逐台生效确认）。 */
  async function advanceRelease(id) {
    const row = q.byId.get(id)
    if (!row) throw new ApiError(404, 'RELEASE_NOT_FOUND', `发布编号 ${id} 不存在`)
    if (row.status === 'published' || row.status === 'failed') return

    if (row.status === 'staging') {
      const targets = JSON.parse(row.targets)
      const recorded = new Set(q.receipts.all(id).map((r) => r.device_id))
      for (const deviceId of targets) {
        if (recorded.has(deviceId)) continue
        try {
          const held = await simulator.getStage(deviceId, id)
          if (held) {
            recordReceipt(id, deviceId, held.digest, held.stagedAt) // 补记
          } else {
            await stageAndRecord(row, deviceId) // 设备迟到/未收：幂等重发
          }
        } catch { /* 设备暂不可达，保持 staging，下轮再核 */ }
      }
      evaluate(id)
    }

    const promoted = q.byId.get(id)
    if (promoted.status === 'activating') {
      await driveActivation(promoted)
    }
  }

  /**
   * 按发布编号顺序推进所有未完结发布。
   * 遇仍处于 activating 的发布即停止：后续发布不得越过尚未完成的生效顺序。
   */
  async function advanceAll() {
    for (const { id } of q.unfinishedIds.all()) {
      await advanceRelease(id)
      if (q.byId.get(id).status === 'activating') break
    }
  }

  /** 创建发布意图并同步暂存；同标识重传返回与当前恢复阶段一致的原结果，异载荷抛 409。 */
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
      // 同标识同载荷：先按序推进恢复（中断后续核/补齐未完成设备），再返回当前真实状态
      await serialize(advanceAll)
      return { release: toDto(q.byId.get(existing.id)), duplicate: true }
    }

    let id
    try {
      id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        const raced = q.byKey.get(releaseKey)
        if (raced && raced.digest === digest) {
          await serialize(advanceAll)
          return { release: toDto(q.byId.get(raced.id)), duplicate: true }
        }
        throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在且载荷不同`)
      }
      throw err
    }

    const row = q.byId.get(id)
    for (const deviceId of targets) {
      await stageAndRecord(row, deviceId)
    }
    await serialize(advanceAll)
    return { release: toDto(q.byId.get(id)), duplicate: false }
  }

  /**
   * 核对并补记单个发布：先按序推进其前序未完结发布（保证生效顺序不被越过），
   * 再推进该发布本身（缺失回执补记/补发 → 预占代次 → 逐台生效确认）。
   */
  async function reconcileRelease(id) {
    if (!q.byId.get(id)) throw new ApiError(404, 'RELEASE_NOT_FOUND', `发布编号 ${id} 不存在`)
    await serialize(async () => {
      for (const { id: other } of q.unfinishedIds.all()) {
        if (other > id) break
        await advanceRelease(other)
        if (q.byId.get(other).status === 'activating') break // 前序/本发布尚未完成生效，后续不得越过
      }
    })
    return toDto(q.byId.get(id))
  }

  /** 重启后（以及周期性）对所有未完结发布按序核对补记与生效补齐。 */
  async function reconcileAll() {
    const ids = q.unfinishedIds.all().map((r) => r.id)
    await serialize(advanceAll)
    const reconciled = ids.map((id) => {
      const row = q.byId.get(id)
      return { id, status: row.status, generation: row.generation }
    })
    return { reconciled }
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
   * 测试钩子：复现“逐台最终切换过程中进程退出”的崩溃窗口。
   * 回执齐备、代次已预占（activating），仅前 activateCount 台目标完成实际切换，
   * 且生效确认一律不落库——重启后必须重新核对并补齐其余设备。
   */
  async function simulateCrashDuringActivate(input) {
    const { releaseKey, targets, params } = validate(input)
    const activateCount = Number(input?.activateCount) || 0
    const digest = digestParams(params)
    if (q.byKey.get(releaseKey)) {
      throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在`)
    }
    const id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    const row = q.byId.get(id)
    for (const deviceId of targets) {
      await stageAndRecord(row, deviceId)
    }
    evaluate(id)
    const promoted = q.byId.get(id)
    if (promoted.status !== 'activating') return toDto(promoted) // 前置条件不满足时如实返回
    const limit = Math.max(0, Math.min(Number(activateCount) || 0, targets.length))
    for (const deviceId of targets.slice(0, limit)) {
      try {
        await simulator.activate(deviceId, {
          releaseId: id,
          digest,
          generation: promoted.generation,
        })
      } catch { /* 崩溃演练只关心已切换成功的部分 */ }
    }
    // —— 此处即“进程退出”：部分设备已切换，但 activations 未落库 ——
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
    simulateCrashDuringActivate,
    currentGeneration,
    knownDevices: () => [...knownDevices],
  }
}
