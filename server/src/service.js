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
 *  3. 仅当全部目标回执摘要与发布摘要一致时，才在单事务中原子推进生效代次。
 *  4. 任一设备摘要不符 → failed，永不推进代次。
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
    publish: db.prepare(
      `UPDATE releases SET status = 'published', generation = ?, published_at = ?
       WHERE id = ? AND status = 'staging'`
    ),
    currentGeneration: db.prepare(
      `SELECT g.generation, g.release_id, g.published_at, r.release_key
       FROM generations g JOIN releases r ON r.id = g.release_id
       ORDER BY g.generation DESC LIMIT 1`
    ),
    stagingIds: db.prepare(`SELECT id FROM releases WHERE status = 'staging' ORDER BY id`),
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
    return {
      id: row.id,
      releaseKey: row.release_key,
      digest: row.digest,
      params: row.params,
      targets,
      status: row.status, // 汇总阶段：staging | published | failed
      generation: row.generation, // 生效代次（未发布为 null）
      createdAt: row.created_at,
      publishedAt: row.published_at,
      receipts,
      summary: {
        expected: targets.length,
        received: receipts.length,
        matched: receipts.filter((r) => r.matches).length,
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
   * 汇总评估：全部目标回执齐备后，
   *  全匹配 → 单事务原子推进代次并置 published；
   *  任一不符 → failed，代次不动。
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
      const generation = q.maxGeneration.get().g + 1
      const ts = now()
      q.insertGeneration.run(generation, id, ts)
      q.publish.run(generation, ts, id)
    })
  }

  async function activatePublishedRelease(row) {
    if (!row || row.status !== 'published' || row.generation == null || typeof simulator.activate !== 'function') {
      return
    }
    const targets = JSON.parse(row.targets)
    for (const deviceId of targets) {
      try {
        await simulator.activate(deviceId, {
          releaseId: row.id,
          digest: row.digest,
          generation: row.generation,
        })
      } catch {}
    }
  }

  /** 创建发布意图并同步暂存；同标识重传返回原结果，异载荷抛 409。 */
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
      return { release: toDto(existing), duplicate: true }
    }

    let id
    try {
      id = Number(q.insertRelease.run(releaseKey, digest, params, JSON.stringify(targets), now()).lastInsertRowid)
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        const raced = q.byKey.get(releaseKey)
        if (raced && raced.digest === digest) return { release: toDto(raced), duplicate: true }
        throw new ApiError(409, 'RELEASE_KEY_CONFLICT', `发布标识 ${releaseKey} 已存在且载荷不同`)
      }
      throw err
    }

    const row = q.byId.get(id)
    for (const deviceId of targets) {
      await stageAndRecord(row, deviceId)
    }
    evaluate(id)
    const finalized = q.byId.get(id)
    await activatePublishedRelease(finalized)
    return { release: toDto(finalized), duplicate: false }
  }

  /**
   * 核对并补记单个发布：对每张缺失回执，先向模拟器核对已暂存内容；
   * 设备确未暂存则幂等补发；设备摘要不符则如实落回执，由 evaluate 判负。
   */
  async function reconcileRelease(id) {
    const row = q.byId.get(id)
    if (!row) throw new ApiError(404, 'RELEASE_NOT_FOUND', `发布编号 ${id} 不存在`)
    if (row.status !== 'staging') return toDto(row)

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
    const finalized = q.byId.get(id)
    await activatePublishedRelease(finalized)
    return toDto(finalized)
  }

  /** 重启后（以及周期性）对所有未完结发布做核对补记。 */
  async function reconcileAll() {
    const ids = q.stagingIds.all().map((r) => r.id)
    const reconciled = []
    for (const id of ids) {
      reconciled.push(await reconcileRelease(id))
    }
    return { reconciled: reconciled.map((r) => ({ id: r.id, status: r.status, generation: r.generation })) }
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
    currentGeneration,
    knownDevices: () => [...knownDevices],
  }
}
