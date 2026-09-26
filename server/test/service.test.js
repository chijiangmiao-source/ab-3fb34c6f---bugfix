import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createService, ApiError } from '../src/service.js'
import { digestParams } from '../src/digest.js'

const DEVICES = ['collector-1', 'collector-2']

/**
 * 内存版设备模拟器：与真实模拟器同语义
 * （幂等暂存 / 异摘要 409 / 可核对 / 生效切换需暂存匹配且代次不得回退）。
 * fail.stage / fail.activate 可在测试途中增删，模拟设备拒绝或迟到；
 * 通过 state 共享 stages/active，可在“重启”后保留设备侧内容。
 */
function fakeSimulator({ failOn = [], failActivateOn = [], state } = {}) {
  const stages = state?.stages ?? new Map()
  const active = state?.active ?? new Map()
  const calls = { stage: 0, getStage: 0, activate: 0, getActive: 0 }
  const fail = { stage: new Set(failOn), activate: new Set(failActivateOn) }
  const key = (d, r) => `${d}:${r}`
  const err = (status, message) => Object.assign(new Error(message), { status })
  return {
    stages,
    active,
    calls,
    fail,
    async stage(deviceId, { releaseId, digest }) {
      calls.stage += 1
      if (fail.stage.has(deviceId)) throw err(503, 'device unreachable')
      const existing = stages.get(key(deviceId, releaseId))
      if (existing) {
        if (existing.digest === digest) return { ...existing, idempotent: true }
        throw err(409, 'STAGE_CONFLICT')
      }
      const rec = { deviceId, releaseId, digest, stagedAt: new Date().toISOString() }
      stages.set(key(deviceId, releaseId), rec)
      return { ...rec, idempotent: false }
    },
    async getStage(deviceId, releaseId) {
      calls.getStage += 1
      return stages.get(key(deviceId, releaseId)) ?? null
    },
    async activate(deviceId, { releaseId, digest, generation }) {
      calls.activate += 1
      if (fail.activate.has(deviceId)) throw err(503, 'device unreachable')
      const staged = stages.get(key(deviceId, releaseId))
      if (!staged || staged.digest !== digest) throw err(409, 'ACTIVATION_NOT_STAGED')
      const current = active.get(deviceId)
      if (current && current.generation > generation) throw err(409, 'ACTIVATION_SUPERSEDED')
      if (current && current.releaseId === releaseId && current.digest === digest && current.generation === generation) {
        return { ...current, idempotent: true }
      }
      const rec = { deviceId, releaseId, digest, generation, activatedAt: new Date().toISOString() }
      active.set(deviceId, rec)
      return { ...rec, idempotent: false }
    },
    async getActive(deviceId) {
      calls.getActive += 1
      return active.get(deviceId) ?? null
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

test('全部回执匹配且全部设备确认生效后才是已发布并赋予生效代次', async () => {
  const { service } = setup()
  const { release, duplicate } = await service.createRelease(REQ)
  assert.equal(duplicate, false)
  assert.equal(release.status, 'published')
  assert.equal(release.generation, 1)
  assert.equal(release.receipts.length, 2)
  assert.ok(release.receipts.every((r) => r.matches))
  assert.equal(release.summary.confirmed, 2)
  assert.ok(release.activations.every((a) => a.matches))
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
  const sim2 = fakeSimulator({ state: sim })
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

test('中断于最终切换前：重启后核对补齐，全部设备确认才显示已发布', async () => {
  const sim = fakeSimulator({ failActivateOn: DEVICES })
  const { db, service } = setup(sim)
  const { release } = await service.createRelease(REQ)
  assert.equal(release.status, 'activating') // 代次已指派，但最终切换未开始
  assert.equal(release.generation, 1)
  assert.equal(release.summary.confirmed, 0)
  assert.equal(sim.active.size, 0)
  assert.equal(service.currentGeneration().generation, null) // 未确认不得显示生效代次

  // 重建服务（模拟重启），设备恢复健康：启动核对补齐未完成设备
  sim.fail.activate.clear()
  const service2 = createService({ db, simulator: sim, knownDevices: DEVICES })
  assert.equal(service2.getRelease(release.id).status, 'activating') // 重启后读取仍不得显示已发布
  await service2.reconcileAll()
  const healed = service2.getRelease(release.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
  assert.equal(healed.summary.confirmed, DEVICES.length)
  for (const d of DEVICES) {
    const a = await sim.getActive(d)
    assert.equal(a.releaseId, release.id)
    assert.equal(a.digest, release.digest)
    assert.equal(a.generation, 1)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)
})

test('中断于部分目标切换后：重启与同标识重传最终只产生一个发布结果和一个代次', async () => {
  const sim = fakeSimulator({ failActivateOn: ['collector-2'] })
  const { db, service } = setup(sim)
  const first = await service.createRelease(REQ)
  assert.equal(first.release.status, 'activating')
  const gen = first.release.generation
  assert.equal(first.release.summary.confirmed, 1) // collector-1 已确认，collector-2 拒绝

  // 重建服务（模拟重启），设备仍拒绝：同标识重传只能得到与恢复阶段一致的结果
  const service2 = createService({ db, simulator: sim, knownDevices: DEVICES })
  const dup1 = await service2.createRelease(REQ)
  assert.equal(dup1.duplicate, true)
  assert.equal(dup1.release.id, first.release.id)
  assert.equal(dup1.release.status, 'activating')
  assert.equal(dup1.release.generation, gen)
  assert.equal(service2.currentGeneration().generation, null)

  // 设备恢复，周期核对补齐；再次重传得到同一已发布结果
  sim.fail.activate.clear()
  await service2.reconcileAll()
  const dup2 = await service2.createRelease(REQ)
  assert.equal(dup2.duplicate, true)
  assert.equal(dup2.release.status, 'published')
  assert.equal(dup2.release.generation, gen)

  // 只产生一个发布结果和一个代次，且所有目标实际生效信息一致
  assert.equal(db.prepare('SELECT * FROM releases WHERE release_key = ?').all(REQ.releaseKey).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)
  for (const d of DEVICES) {
    const a = await sim.getActive(d)
    assert.equal(a.releaseId, first.release.id)
    assert.equal(a.digest, first.release.digest)
    assert.equal(a.generation, gen)
  }
})

test('最终切换途中崩溃：部分设备已切换，重启核对后按实际状态补齐', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const crashed = await service.simulateCrashDuringActivation(REQ)
  assert.equal(crashed.status, 'activating')
  assert.equal(crashed.generation, 1)
  assert.equal(crashed.summary.confirmed, 1) // 仅 collector-1 已确认
  assert.equal(await sim.getActive('collector-2'), null) // 最后一台尚未切换

  // 重建服务（模拟重启）：读取仍不得显示已发布，启动核对补齐未完成设备
  const service2 = createService({ db, simulator: sim, knownDevices: DEVICES })
  assert.equal(service2.getRelease(crashed.id).status, 'activating')
  assert.equal(service2.currentGeneration().generation, null)
  await service2.reconcileAll()
  const healed = service2.getRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
  assert.equal(healed.summary.confirmed, 2)
  const a2 = await sim.getActive('collector-2')
  assert.equal(a2.releaseId, crashed.id)
  assert.equal(a2.digest, crashed.digest)
  assert.equal(a2.generation, 1)
})

test('设备侧已生效但确认未落库：重启核对如实补记，不重复切换', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const crashed = await service.simulateCrashDuringActivation(REQ)
  assert.equal(crashed.status, 'activating')
  // 崩溃前最后一台其实已在设备侧完成切换，只是确认未落库
  await sim.activate('collector-2', {
    releaseId: crashed.id,
    digest: crashed.digest,
    generation: crashed.generation,
  })
  const activateCalls = sim.calls.activate

  const service2 = createService({ db, simulator: sim, knownDevices: DEVICES })
  await service2.reconcileAll()
  const healed = service2.getRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.summary.confirmed, 2)
  assert.equal(sim.calls.activate, activateCalls) // 纯核对补记，未重复切换
})

test('一台设备拒绝最终切换：不显示完成，后续发布不得越过生效顺序', async () => {
  const sim = fakeSimulator({ failActivateOn: ['collector-2'] })
  const { service } = setup(sim)
  const first = await service.createRelease(REQ)
  assert.equal(first.release.status, 'activating')

  // 多次核对仍不得认定为完成
  await service.reconcileAll()
  const stuck = await service.reconcileRelease(first.release.id)
  assert.equal(stuck.status, 'activating')
  assert.equal(service.currentGeneration().generation, null)

  // 后续发布受理但不得获得代次、不得越过尚未完成的生效
  const second = await service.createRelease({ ...REQ, releaseKey: 'optics-v2', params: 'gain=2.0' })
  assert.equal(second.release.status, 'staging')
  assert.equal(second.release.generation, null)
  assert.equal(service.currentGeneration().generation, null)

  // 设备恢复：先完成前者，再按序推进后者，代次一一对应
  sim.fail.activate.clear()
  await service.reconcileAll()
  const healedFirst = service.getRelease(first.release.id)
  assert.equal(healedFirst.status, 'published')
  assert.equal(healedFirst.generation, 1)
  const healedSecond = service.getRelease(second.release.id)
  assert.equal(healedSecond.status, 'published')
  assert.equal(healedSecond.generation, 2)
  const cur = service.currentGeneration()
  assert.equal(cur.generation, 2)
  assert.equal(cur.releaseKey, 'optics-v2')
  for (const d of DEVICES) {
    const a = await sim.getActive(d)
    assert.equal(a.releaseId, second.release.id)
    assert.equal(a.generation, 2)
  }
})

test('设备实际生效信息不符：如实记录且不得认定为完成', async () => {
  const sim = fakeSimulator()
  const { service } = setup(sim)
  const first = await service.createRelease(REQ)
  assert.equal(first.release.status, 'published')

  sim.fail.activate.add('collector-2')
  const second = await service.createRelease({ ...REQ, releaseKey: 'optics-v2', params: 'gain=2.0' })
  assert.equal(second.release.status, 'activating')
  assert.equal(second.release.generation, 2)

  const view = service.getRelease(second.release.id)
  assert.equal(view.status, 'activating')
  const c2 = view.activations.find((a) => a.deviceId === 'collector-2')
  assert.equal(c2.releaseId, first.release.id) // 设备实际仍停留在上一发布
  assert.equal(c2.generation, 1)
  assert.equal(c2.matches, false)
  assert.equal(view.summary.confirmed, 1)
  assert.equal(service.currentGeneration().generation, 1) // 当前生效代次不得提前
})
