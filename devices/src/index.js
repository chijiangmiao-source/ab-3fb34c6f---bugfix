import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import Database from 'better-sqlite3'

/**
 * 采集器设备模拟器（独立进程、独立持久化卷）。
 * 语义：同一台设备对同一发布编号幂等暂存——
 *   同摘要重发 → 返回原暂存回执；
 *   异摘要     → 409 冲突，设备保留首次内容；
 * 设备内容不随后端进程重启而丢失，供后端重启后核对补记。
 */
const PORT = Number(process.env.PORT || 9000)
const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
const TEST_HOOKS = process.env.TEST_HOOKS === '1'

fs.mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(path.join(DATA_DIR, 'devices.db'))
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS stages (
  device_id  TEXT    NOT NULL,
  release_id INTEGER NOT NULL,
  digest     TEXT    NOT NULL,
  params     TEXT    NOT NULL,
  staged_at  TEXT    NOT NULL,
  PRIMARY KEY (device_id, release_id)
);

CREATE TABLE IF NOT EXISTS active_versions (
  device_id    TEXT    PRIMARY KEY,
  release_id   INTEGER NOT NULL,
  digest       TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  activated_at TEXT    NOT NULL
)`)

const q = {
  get: db.prepare('SELECT * FROM stages WHERE device_id = ? AND release_id = ?'),
  insert: db.prepare(
    'INSERT INTO stages (device_id, release_id, digest, params, staged_at) VALUES (?, ?, ?, ?, ?)'
  ),
  active: db.prepare('SELECT * FROM active_versions WHERE device_id = ?'),
  activate: db.prepare(
    `INSERT INTO active_versions (device_id, release_id, digest, generation, activated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       release_id = excluded.release_id,
       digest = excluded.digest,
       generation = excluded.generation,
       activated_at = excluded.activated_at`
  ),
  corrupt: db.prepare('UPDATE stages SET digest = ?, params = ? WHERE device_id = ? AND release_id = ?'),
}

const toDto = (row) => ({
  deviceId: row.device_id,
  releaseId: row.release_id,
  digest: row.digest,
  stagedAt: row.staged_at,
})

const activeDto = (row) => ({
  deviceId: row.device_id,
  releaseId: row.release_id,
  digest: row.digest,
  generation: row.generation,
  activatedAt: row.activated_at,
})

const app = express()
app.use(express.json({ limit: '256kb' }))

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'optics-device-simulator', time: new Date().toISOString() })
})

app.post('/devices/:deviceId/stage', (req, res) => {
  const { deviceId } = req.params
  const { releaseId, digest, params } = req.body ?? {}
  if (!Number.isInteger(releaseId) || releaseId <= 0 || typeof digest !== 'string' || typeof params !== 'string') {
    return res.status(400).json({ error: 'INVALID_STAGE_REQUEST' })
  }
  const existing = q.get.get(deviceId, releaseId)
  if (existing) {
    if (existing.digest === digest) {
      return res.status(200).json({ ...toDto(existing), idempotent: true })
    }
    return res.status(409).json({ error: 'STAGE_CONFLICT', staged: toDto(existing) })
  }
  const stagedAt = new Date().toISOString()
  q.insert.run(deviceId, releaseId, digest, params, stagedAt)
  return res.status(201).json({ deviceId, releaseId, digest, stagedAt, idempotent: false })
})

app.post('/devices/:deviceId/activate', (req, res) => {
  const { deviceId } = req.params
  const { releaseId, digest, generation } = req.body ?? {}
  if (!Number.isInteger(releaseId) || releaseId <= 0 || typeof digest !== 'string' || !Number.isInteger(generation) || generation <= 0) {
    return res.status(400).json({ error: 'INVALID_ACTIVATION_REQUEST' })
  }
  const staged = q.get.get(deviceId, releaseId)
  if (!staged || staged.digest !== digest) {
    return res.status(409).json({ error: 'ACTIVATION_NOT_STAGED' })
  }
  const current = q.active.get(deviceId)
  if (current && current.generation > generation) {
    return res.status(409).json({ error: 'ACTIVATION_SUPERSEDED', active: activeDto(current) })
  }
  if (current && current.release_id === releaseId && current.digest === digest && current.generation === generation) {
    return res.status(200).json({ ...activeDto(current), idempotent: true })
  }
  const activatedAt = new Date().toISOString()
  q.activate.run(deviceId, releaseId, digest, generation, activatedAt)
  return res.status(201).json({ deviceId, releaseId, digest, generation, activatedAt, idempotent: false })
})

app.get('/devices/:deviceId/stages/:releaseId', (req, res) => {
  const releaseId = Number(req.params.releaseId)
  const row = q.get.get(req.params.deviceId, releaseId)
  if (!row) return res.status(404).json({ error: 'NOT_STAGED' })
  return res.json(toDto(row))
})

app.get('/devices/:deviceId/active', (req, res) => {
  const row = q.active.get(req.params.deviceId)
  if (!row) return res.status(404).json({ error: 'NO_ACTIVE_VERSION' })
  return res.json(activeDto(row))
})

if (TEST_HOOKS) {
  // 测试钩子：篡改某台设备已暂存的内容，模拟“设备内容不一致”
  app.post('/test-hooks/corrupt', (req, res) => {
    const { deviceId, releaseId, digest } = req.body ?? {}
    const existing = q.get.get(deviceId, Number(releaseId))
    if (!existing) return res.status(404).json({ error: 'NOT_STAGED' })
    const badDigest = typeof digest === 'string' && digest ? digest : `corrupted-${existing.digest}`
    q.corrupt.run(badDigest, '-- corrupted payload --', deviceId, Number(releaseId))
    return res.json({ deviceId, releaseId: Number(releaseId), digest: badDigest })
  })
}

app.listen(PORT, () => {
  console.log(`设备模拟器已启动: http://0.0.0.0:${PORT}`)
})
