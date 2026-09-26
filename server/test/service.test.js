import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createService, ApiError } from '../src/service.js'
import { digestParams } from '../src/digest.js'

const DEVICES = ['collector-1', 'collector-2']

/** 内存版设备模拟器：与真实模拟器同语义（幂等暂存 / 异摘要 409 / 可核对）。 */
function fakeSimulator({ failOn = [] } = {}) {
  const stages = new Map()
  const calls = { stage: 0, getStage: 0 }
  const key = (d, r) => `${d}:${r}`
  return {
    stages,
    calls,
    async stage(deviceId, { releaseId, digest }) {
      calls.stage += 1
      if (failOn.includes(deviceId)) {
        const err = new Error('device unreachable')
        err.status = 503
        throw err
      }
      const existing = stages.get(key(deviceId, releaseId))
      if (existing) {
        if (existing.digest === digest) return { ...existing, idempotent: true }
        const err = new Error('STAGE_CONFLICT')
        err.status = 409
        throw err
      }
      const rec = { deviceId, releaseId, digest, stagedAt: new Date().toISOString() }
      stages.set(key(deviceId, releaseId), rec)
      return { ...rec, idempotent: false }
    },
    async getStage(deviceId, releaseId) {
      calls.getStage += 1
      return stages.get(key(deviceId, releaseId)) ?? null
    },
    corrupt(deviceId, releaseId, digest) {
      const k = key(deviceId, releaseId)
      stages.set(k, { ...stages.get(k), digest })
    },
  }
}

function setup(sim = fakeSimulator()) {
  const db = openDb(':memory:')
  const service = createService({ db, simulator: sim, knownDevices: DEVICES })
  return { db, service, sim }
}

const REQ = { releaseKey: 'optics-v1', targets: DEVICES, params: 'gain=1.5\nbias=0.02' }

test('摘要为参数文本的 sha256', () => {
  assert.equal(
    digestParams('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
})

test('全部回执匹配时原子推进为已发布并赋予生效代次', async () => {
  const { service } = setup()
  const { release, duplicate } = await service.createRelease(REQ)
  assert.equal(duplicate, false)
  assert.equal(release.status, 'published')
  assert.equal(release.generation, 1)
  assert.equal(release.receipts.length, 2)
  assert.ok(release.receipts.every((r) => r.matches))
  assert.equal(service.currentGeneration().generation, 1)
})

test('同标识同载荷重传返回原结果，代次不重复推进', async () => {
  const { service } = setup()
  const first = await service.createRelease(REQ)
  const again = await service.createRelease(REQ)
  assert.equal(again.duplicate, true)
  assert.equal(again.release.id, first.release.id)
  assert.equal(again.release.generation, 1)
  assert.equal(service.currentGeneration().generation, 1)
})

test('同标识异载荷必须冲突（409）', async () => {
  const { service } = setup()
  await service.createRelease(REQ)
  await assert.rejects(
    service.createRelease({ ...REQ, params: 'gain=9.9' }),
    (err) => err instanceof ApiError && err.status === 409 && err.code === 'RELEASE_KEY_CONFLICT'
  )
  assert.equal(service.currentGeneration().generation, 1)
})

test('设备迟到：先保持 staging，核对补记后再推进', async () => {
  const sim = fakeSimulator({ failOn: ['collector-2'] })
  const { db, service } = setup(sim)
  const { release } = await service.createRelease(REQ)
  assert.equal(release.status, 'staging')
  assert.equal(release.generation, null)
  assert.equal(service.currentGeneration().generation, null)

  // 设备恢复（模拟器不再失败，且保留 collector-1 已暂存内容），reconcile 幂等重发并推进
  const sim2 = fakeSimulator()
  sim2.stages = sim.stages
  const service2 = createService({ db, simulator: sim2, knownDevices: DEVICES })
  const healed = await service2.reconcileRelease(release.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
})

test('崩溃窗口：设备已暂存但回执未落库，重启核对后补记并发布', async () => {
  const { service, sim } = setup()
  const crashed = await service.simulateCrashAfterStage(REQ)
  assert.equal(crashed.status, 'staging')
  assert.equal(crashed.receipts.length, 0) // 回执确实未落库
  assert.equal(sim.stages.size, 2) // 但设备侧已暂存

  const stageCallsBefore = sim.calls.stage
  const healed = await service.reconcileRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.receipts.length, 2)
  assert.ok(healed.receipts.every((r) => r.matches))
  assert.equal(sim.calls.stage, stageCallsBefore) // 纯核对补记，未重复暂存
})

test('任一设备摘要不符：保持未发布且代次不得推进', async () => {
  const { service, sim } = setup()
  const ok = await service.createRelease(REQ)
  assert.equal(ok.release.generation, 1)

  const crashed = await service.simulateCrashAfterStage({ ...REQ, releaseKey: 'optics-v2' })
  sim.corrupt('collector-2', crashed.id, 'deadbeef'.repeat(8))

  const judged = await service.reconcileRelease(crashed.id)
  assert.equal(judged.status, 'failed')
  assert.equal(judged.generation, null)
  assert.equal(judged.receipts.filter((r) => !r.matches).length, 1)
  assert.equal(service.currentGeneration().generation, 1) // 代次未动

  // 判负是终态：再次核对不得翻案
  const again = await service.reconcileRelease(crashed.id)
  assert.equal(again.status, 'failed')
})

test('代次单调递增且与发布一一对应', async () => {
  const { service } = setup()
  await service.createRelease(REQ)
  await service.createRelease({ ...REQ, releaseKey: 'optics-v2', params: 'gain=2.0' })
  await service.createRelease({ ...REQ, releaseKey: 'optics-v3', params: 'gain=2.5' })
  const cur = service.currentGeneration()
  assert.equal(cur.generation, 3)
  assert.equal(cur.releaseKey, 'optics-v3')
})

test('入参校验', async () => {
  const { service } = setup()
  await assert.rejects(service.createRelease({ ...REQ, releaseKey: '坏 key!' }), (e) => e.status === 400)
  await assert.rejects(service.createRelease({ ...REQ, targets: [] }), (e) => e.status === 400)
  await assert.rejects(service.createRelease({ ...REQ, params: '' }), (e) => e.status === 400)
  await assert.rejects(
    service.createRelease({ ...REQ, targets: ['ghost-device'] }),
    (e) => e.status === 400 && e.code === 'UNKNOWN_DEVICE'
  )
})
