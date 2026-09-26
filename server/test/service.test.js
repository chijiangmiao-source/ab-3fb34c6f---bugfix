import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { openDb } from '../src/db.js'
import { createService, ApiError } from '../src/service.js'
import { digestParams } from '../src/digest.js'

const DEVICES = ['collector-1', 'collector-2', 'collector-3']

/**
 * 内存版设备模拟器：与真实模拟器同语义——
 *   幂等暂存 / 异摘要 409 / 可核对 / 实际生效版本可查询；
 * 并支持可控故障：stage/activate 拒绝（reject）或迟到（stall，挂起直至放行）。
 * 状态跨“重启”保留（同一实例注入新的 service 即模拟后端重启）。
 */
function fakeSimulator({ stageFaults = {}, activateFaults = {} } = {}) {
  const stages = new Map()
  const active = new Map()
  const stallers = new Map() // deviceId -> resolve，迟到设备的放行闸
  const calls = { stage: 0, getStage: 0, activate: 0, getActive: 0 }
  const key = (d, r) => `${d}:${r}`
  const stallGate = (deviceId) => new Promise((resolve) => stallers.set(deviceId, resolve))
  return {
    stages,
    active,
    calls,
    async stage(deviceId, payload) {
      calls.stage += 1
      if (stageFaults[deviceId] === 'reject') {
        const err = new Error('device unreachable')
        err.status = 503
        throw err
      }
      if (stageFaults[deviceId] === 'stall') await stallGate(deviceId)
      const { releaseId, digest } = payload
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
    async activate(deviceId, payload) {
      calls.activate += 1
      if (activateFaults[deviceId] === 'reject') {
        const err = new Error('ACTIVATION_REJECTED_BY_DEVICE')
        err.status = 503
        throw err
      }
      if (activateFaults[deviceId] === 'stall') await stallGate(deviceId)
      const { releaseId, digest, generation } = payload
      const staged = stages.get(key(deviceId, releaseId))
      if (!staged || staged.digest !== digest) {
        const err = new Error('ACTIVATION_NOT_STAGED')
        err.status = 409
        throw err
      }
      const cur = active.get(deviceId)
      if (cur && cur.generation > generation) {
        const err = new Error('ACTIVATION_SUPERSEDED')
        err.status = 409
        throw err
      }
      const rec = { deviceId, releaseId, digest, generation, activatedAt: new Date().toISOString() }
      active.set(deviceId, rec)
      return { ...rec, idempotent: !!(cur && cur.releaseId === releaseId) }
    },
    async getActive(deviceId) {
      calls.getActive += 1
      return active.get(deviceId) ?? null
    },
    corrupt(deviceId, releaseId, digest) {
      const k = key(deviceId, releaseId)
      stages.set(k, { ...stages.get(k), digest })
    },
    setActivateFault(deviceId, mode) {
      if (mode) activateFaults[deviceId] = mode
      else {
        delete activateFaults[deviceId]
        const release = stallers.get(deviceId)
        if (release) {
          stallers.delete(deviceId)
          release()
        }
      }
    },
    setStageFault(deviceId, mode) {
      if (mode) stageFaults[deviceId] = mode
      else {
        delete stageFaults[deviceId]
        const release = stallers.get(deviceId)
        if (release) {
          stallers.delete(deviceId)
          release()
        }
      }
    },
  }
}

function setup(sim = fakeSimulator()) {
  const db = openDb(':memory:')
  const service = createService({ db, simulator: sim, knownDevices: DEVICES })
  return { db, service, sim }
}

/** 用持久化 db + 保留状态的模拟器“重启后端”，模拟进程中断后恢复。 */
function restart(db, sim) {
  return createService({ db, simulator: sim, knownDevices: DEVICES })
}

const REQ = { releaseKey: 'optics-v1', targets: DEVICES, params: 'gain=1.5\nbias=0.02' }

test('摘要为参数文本的 sha256', () => {
  assert.equal(
    digestParams('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
})

test('全部目标确认实际生效后才显示已发布，代次与逐台生效信息一致', async () => {
  const { service, sim } = setup()
  const { release, duplicate } = await service.createRelease(REQ)
  assert.equal(duplicate, false)
  assert.equal(release.status, 'published')
  assert.equal(release.generation, 1)
  assert.equal(release.receipts.length, 3)
  assert.equal(release.summary.activated, 3)
  assert.ok(release.receipts.every((r) => r.matches))
  assert.ok(release.activations.every((a) => a.matches && a.generation === 1))
  // 设备侧实际生效与发布完全一致
  for (const d of DEVICES) {
    const a = await sim.getActive(d)
    assert.equal(a.releaseId, release.id)
    assert.equal(a.digest, release.digest)
    assert.equal(a.generation, 1)
  }
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

test('设备迟到（暂存不可达）：先保持 staging，核对补记后再推进', async () => {
  const sim = fakeSimulator({ stageFaults: { 'collector-2': 'reject' } })
  const { db, service } = setup(sim)
  const { release } = await service.createRelease(REQ)
  assert.equal(release.status, 'staging')
  assert.equal(release.generation, null)
  assert.equal(service.currentGeneration().generation, null)

  // 设备恢复（模拟器不再失败，且保留已暂存内容），重启后 reconcile 幂等重发并推进
  sim.setStageFault('collector-2')
  const service2 = restart(db, sim)
  const healed = await service2.reconcileRelease(release.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
  assert.equal(healed.summary.activated, 3)
})

test('崩溃窗口：设备已暂存但回执未落库，重启核对后补记并发布', async () => {
  const { service, sim } = setup()
  const crashed = await service.simulateCrashAfterStage(REQ)
  assert.equal(crashed.status, 'staging')
  assert.equal(crashed.receipts.length, 0) // 回执确实未落库
  assert.equal(sim.stages.size, 3) // 但设备侧已暂存

  const stageCallsBefore = sim.calls.stage
  const healed = await service.reconcileRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.receipts.length, 3)
  assert.ok(healed.receipts.every((r) => r.matches))
  assert.equal(sim.calls.stage, stageCallsBefore) // 纯核对补记，未重复暂存
})

test('最终切换前崩溃：重启只产生一个发布结果和一个代次', async () => {
  const { db, service, sim } = setup()
  // 代次已预占、进入 activating，但一台设备都尚未切换即“退出”
  const crashed = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 0 })
  assert.equal(crashed.status, 'activating')
  assert.equal(crashed.generation, 1)
  assert.equal(crashed.summary.activated, 0)
  // 页面与接口此刻不得显示已发布
  assert.equal(service.getRelease(crashed.id).status, 'activating')
  assert.equal(service.currentGeneration().generation, null)
  // 设备侧均无生效版本
  for (const d of DEVICES) assert.equal(await sim.getActive(d), null)

  // —— 进程重启 ——
  const service2 = restart(db, sim)
  assert.equal(service2.getRelease(crashed.id).status, 'activating')
  await service2.reconcileAll()
  const healed = service2.getRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
  assert.equal(healed.summary.activated, 3)
  assert.ok(healed.activations.every((a) => a.matches && a.digest === crashed.digest && a.generation === 1))
  assert.equal(service2.currentGeneration().generation, 1)

  // 重启后重复提交：与恢复后阶段一致，仍是同一发布、同一代次
  const again = await service2.createRelease(REQ)
  assert.equal(again.duplicate, true)
  assert.equal(again.release.id, crashed.id)
  assert.equal(again.release.status, 'published')
  assert.equal(again.release.generation, 1)
  const gens = db.prepare('SELECT COUNT(*) AS c FROM generations').get().c
  assert.equal(gens, 1)
  const rels = db.prepare("SELECT COUNT(*) AS c FROM releases WHERE release_key = 'optics-v1'").get().c
  assert.equal(rels, 1)
})

test('部分目标完成最终切换后崩溃：重启逐台核对补齐，最终全部一致', async () => {
  const { db, service, sim } = setup()
  const crashed = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 1 })
  assert.equal(crashed.status, 'activating')
  assert.equal(crashed.summary.activated, 0) // 确认未落库
  // 仅第一台实际切换
  assert.equal((await sim.getActive(DEVICES[0])).releaseId, crashed.id)
  assert.equal(await sim.getActive(DEVICES[1]), null)
  assert.equal(await sim.getActive(DEVICES[2]), null)

  // 中断期间刷新页面：仍不得显示已发布
  assert.equal(service.getRelease(crashed.id).status, 'activating')
  assert.equal(service.listReleases()[0].status, 'activating')
  assert.equal(service.currentGeneration().generation, null)

  // —— 中断后重启 ——：已切换的设备靠 GET /active 核对确认，未切换的补齐
  const service2 = restart(db, sim)
  await service2.reconcileAll()
  const healed = service2.getRelease(crashed.id)
  assert.equal(healed.status, 'published')
  assert.equal(healed.generation, 1)
  assert.equal(healed.summary.activated, 3)
  for (const d of DEVICES) {
    const a = healed.activations.find((x) => x.deviceId === d)
    assert.equal(a.digest, crashed.digest)
    assert.equal(a.generation, 1)
    const dev = await sim.getActive(d)
    assert.equal(dev.releaseId, crashed.id)
    assert.equal(dev.generation, 1)
  }

  // 再次重启仍保持唯一发布/代次，且幂等无新增
  const service3 = restart(db, sim)
  await service3.reconcileAll()
  const dup = await service3.createRelease(REQ)
  assert.equal(dup.duplicate, true)
  assert.equal(dup.release.status, 'published')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM activations').get().c, 3)
})

test('一台设备拒绝最终切换：保持生效中，页面不提前显示已发布', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const rel = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 1 })
  sim.setActivateFault(DEVICES[2], 'reject') // 第三台拒绝切换

  const service2 = restart(db, sim)
  await service2.reconcileAll()
  const stuck = service2.getRelease(rel.id)
  assert.equal(stuck.status, 'activating')
  assert.notEqual(stuck.status, 'published')
  assert.equal(stuck.generation, 1) // 代次已预占但未完成生效
  assert.equal(stuck.summary.activated, 2)
  assert.equal(service2.currentGeneration().generation, null)

  // 同标识重传：结果与当前恢复阶段一致（仍为 activating），不产生新发布/代次
  const retried = await service2.createRelease(REQ)
  assert.equal(retried.duplicate, true)
  assert.equal(retried.release.id, rel.id)
  assert.equal(retried.release.status, 'activating')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)

  // 设备恢复后重启核对，最终收敛为已发布
  sim.setActivateFault(DEVICES[2])
  const service3 = restart(db, sim)
  await service3.reconcileAll()
  assert.equal(service3.getRelease(rel.id).status, 'published')
  assert.equal(service3.currentGeneration().generation, 1)
})

test('一台设备迟到（activate 挂起）：不提前显示完成，设备到达后收敛', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const rel = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 2 })
  sim.setActivateFault(DEVICES[2], 'stall') // 第三台迟到，暂不响应

  const service2 = restart(db, sim)
  const pending = service2.reconcileAll()
  await new Promise((r) => setTimeout(r, 30))
  // 挂起期间：仅两台确认，页面不得显示已发布
  assert.equal(service2.getRelease(rel.id).status, 'activating')
  assert.equal(service2.getRelease(rel.id).summary.activated, 2)
  assert.equal(service2.currentGeneration().generation, null)

  // 设备到达：挂起的激活请求得到响应，同轮核对即收敛
  sim.setActivateFault(DEVICES[2])
  await pending
  assert.equal(service2.getRelease(rel.id).status, 'published')
  assert.equal(service2.getRelease(rel.id).summary.activated, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)
})

test('前序发布尚未完成生效时，后续发布不得越过其生效顺序', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const first = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 1 })
  assert.equal(first.status, 'activating')
  sim.setActivateFault(DEVICES[1], 'reject') // 前序发布卡在最终切换

  // 后续发布：暂存可全部完成，但因前序仍在 activating，不得预占新一代次
  const second = await service.createRelease({
    releaseKey: 'optics-v2', targets: DEVICES, params: 'gain=2.0',
  })
  assert.equal(second.release.status, 'staging')
  assert.equal(second.release.generation, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generations').get().c, 1)

  // 前序设备恢复后重启核对：前序先发布，后续才可推进且代次严格接续
  sim.setActivateFault(DEVICES[1])
  const service2 = restart(db, sim)
  await service2.reconcileAll()
  assert.equal(service2.getRelease(first.id).status, 'published')
  const r2 = service2.getRelease(second.release.id)
  assert.equal(r2.status, 'published')
  assert.equal(r2.generation, 2)
})

test('设备回报的实际生效摘要/代次不符时不得认定完成，恢复一致后才可发布', async () => {
  const sim = fakeSimulator()
  const { db, service } = setup(sim)
  const rel = await service.simulateCrashDuringActivate({ ...REQ, activateCount: 0 })

  // 一台设备实际生效停留在错误版本（错误发布编号/摘要/代次），且拒绝重新激活
  sim.active.set(DEVICES[0], {
    deviceId: DEVICES[0],
    releaseId: 999,
    digest: 'tampered-digest',
    generation: 42,
    activatedAt: new Date().toISOString(),
  })
  sim.setActivateFault(DEVICES[0], 'reject')
  // 其余两台正常切换
  for (const d of DEVICES.slice(1)) {
    await sim.activate(d, { releaseId: rel.id, digest: rel.digest, generation: 1 })
  }

  const service2 = restart(db, sim)
  await service2.reconcileAll()
  const stuck = service2.getRelease(rel.id)
  assert.equal(stuck.status, 'activating')
  assert.equal(stuck.summary.activated, 2) // 实际生效不符的一台不得计入确认
  assert.equal(service2.currentGeneration().generation, null)

  // 设备侧恢复为可切换（清除错误生效与拒绝），核对后收敛
  sim.setActivateFault(DEVICES[0])
  sim.active.delete(DEVICES[0])
  const service3 = restart(db, sim)
  await service3.reconcileAll()
  assert.equal(service3.getRelease(rel.id).status, 'published')
  assert.equal(service3.getRelease(rel.id).summary.activated, 3)
})

test('同标识重传对 staging 发布同样驱动恢复，结果与恢复阶段一致', async () => {
  const { db, service, sim } = setup()
  const crashed = await service.simulateCrashAfterStage(REQ)
  assert.equal(crashed.status, 'staging')

  // 重启后不调 reconcile，直接同标识重传：应续做核对补齐并返回最新状态
  const service2 = restart(db, sim)
  const retried = await service2.createRelease(REQ)
  assert.equal(retried.duplicate, true)
  assert.equal(retried.release.id, crashed.id)
  assert.equal(retried.release.status, 'published')
  assert.equal(retried.release.generation, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM releases WHERE release_key = ?').get('optics-v1').c, 1)
})

test('任一设备暂存摘要不符：判负且代次不得推进', async () => {
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

test('旧版本库恢复：曾被提前置为 published 但缺少生效确认的记录回退为 activating', async () => {
  // 构造一个旧版数据文件：schema 已到 v1 但 user_version=0、无 activations 表，
  // 且存在一条“本地已 published、设备尚未全部切换”的记录（正是待修复的旧状态）。
  const dir = await fsp.mkdtemp(pathJoin(os.tmpdir(), 'optics-db-'))
  const file = `${dir}/app.db`
  const raw = openDb(file)
  raw.exec('DROP TABLE IF EXISTS activations')
  raw.pragma('user_version = 0')
  const rid = Number(
    raw.prepare(
      `INSERT INTO releases (release_key, digest, params, targets, status, generation, created_at, published_at)
       VALUES (?, ?, ?, ?, 'published', 3, ?, ?)`
    ).run('legacy-key', 'digest-x', 'p', JSON.stringify(DEVICES), new Date().toISOString(), new Date().toISOString())
      .lastInsertRowid
  )
  raw.prepare('INSERT INTO generations (generation, release_id, published_at) VALUES (?, ?, ?)')
    .run(3, rid, new Date().toISOString())
  raw.close()

  // 以旧文件重新打开：迁移必须把该记录降级为 activating，等待逐台核对补齐
  const migratedDb = openDb(file)
  const row = migratedDb.prepare('SELECT * FROM releases WHERE id = ?').get(rid)
  assert.equal(row.status, 'activating')
  assert.equal(row.generation, 3)
  assert.equal(migratedDb.pragma('user_version', { simple: true }), 1)
  migratedDb.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

function pathJoin(a, b) {
  return `${a.replace(/\/$/, '')}/${b}`
}
