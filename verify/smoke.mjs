/**
 * API 冒烟复核：
 *  1. 健康检查与设备清单
 *  2. 正常发布：全部回执匹配 → 原子推进代次
 *  3. 重复发布（同标识同载荷）→ 返回原结果，代次不动
 *  4. 同标识异载荷 → 409 冲突
 *  5. 崩溃窗口（设备已暂存、回执未落库）→ 核对补记后发布
 *  6. 设备摘要被篡改 → 保持未发布，代次不得推进
 *  7. 已完成发布的重传 → 仍返回原结果
 */
const API = process.env.API_BASE || 'http://localhost:8080'
const SIM = process.env.SIMULATOR_URL || 'http://localhost:9000'

const RUN = `smoke-${Date.now()}`
let failures = 0

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures += 1
    console.error(`  ✘ ${name} ${extra}`)
  }
}

async function req(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function waitFor(base, path, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${base}${path}`)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`服务未就绪: ${base}${path}`)
}

const api = (m, p, b) => req(API, m, p, b)
const sim = (m, p, b) => req(SIM, m, p, b)

async function main() {
  console.log(`[smoke] API=${API} SIM=${SIM} RUN=${RUN}`)
  await waitFor(API, '/api/health')
  await waitFor(SIM, '/health')

  console.log('— 健康检查与设备清单 —')
  const health = await api('GET', '/api/health')
  check('接口健康检查通过', health.status === 200 && health.data.ok === true)
  const devicesRes = await api('GET', '/api/devices')
  const devices = devicesRes.data.devices ?? []
  check('采集器清单非空', devices.length >= 2)
  const targets = devices.slice(0, 3)

  console.log('— 正常发布：暂存回执齐备后原子推进代次 —')
  const keyA = `${RUN}-a`
  const paramsA = 'gain=1.5\nbias=0.02\nintegration_ms=120'
  const createA = await api('POST', '/api/releases', { releaseKey: keyA, targets, params: paramsA })
  check('创建返回 201', createA.status === 201, JSON.stringify(createA.data))
  const relA = createA.data.release ?? {}
  check('全部目标已暂存且汇总为已发布', relA.status === 'published' && relA.summary?.matched === targets.length)
  check('回执逐台与发布摘要一致', (relA.receipts ?? []).every((r) => r.matches))
  const genA = relA.generation
  check('获得生效代次', Number.isInteger(genA) && genA >= 1)
  const cur1 = await api('GET', '/api/generation/current')
  check('当前代次即本次发布', cur1.data.generation === genA && cur1.data.releaseKey === keyA)

  console.log('— 重复发布：同标识同载荷返回原结果 —')
  const dup = await api('POST', '/api/releases', { releaseKey: keyA, targets, params: paramsA })
  check('重传返回 200 且标记 duplicate', dup.status === 200 && dup.data.duplicate === true)
  check('重传返回原发布编号与代次', dup.data.release?.id === relA.id && dup.data.release?.generation === genA)
  const cur2 = await api('GET', '/api/generation/current')
  check('重传不推进代次', cur2.data.generation === genA)

  console.log('— 同标识异载荷必须冲突 —')
  const conflict = await api('POST', '/api/releases', { releaseKey: keyA, targets, params: 'gain=9.9' })
  check('异载荷返回 409', conflict.status === 409, JSON.stringify(conflict.data))
  check('冲突错误码为 RELEASE_KEY_CONFLICT', conflict.data.error?.code === 'RELEASE_KEY_CONFLICT')

  console.log('— 回执补记：设备已暂存、回执未落库的崩溃窗口 —')
  const keyB = `${RUN}-b`
  const crash = await api('POST', '/api/test-hooks/simulate-crash-after-stage', {
    releaseKey: keyB, targets, params: 'gain=2.0\nbias=0.03',
  })
  check('崩溃演练创建发布意图', crash.status === 201, JSON.stringify(crash.data))
  const relB = crash.data.release ?? {}
  check('崩溃后保持暂存中且无回执落库', relB.status === 'staging' && relB.receipts?.length === 0)
  const beforeReconcile = await api('GET', `/api/releases/${relB.id}`)
  check('刷新读取仍无回执（页面只见已确认信息）', beforeReconcile.data.release?.receipts?.length === 0)
  const healed = await api('POST', `/api/releases/${relB.id}/reconcile`)
  check('核对补记后发布', healed.data.release?.status === 'published', JSON.stringify(healed.data))
  check('补记回执齐备且匹配', healed.data.release?.summary?.matched === targets.length)
  check('代次严格递增', healed.data.release?.generation === genA + 1)
  const genB = healed.data.release.generation

  console.log('— 设备摘要不符：保持未发布且代次不推进 —')
  const keyC = `${RUN}-c`
  const crashC = await api('POST', '/api/test-hooks/simulate-crash-after-stage', {
    releaseKey: keyC, targets, params: 'gain=3.0',
  })
  const relC = crashC.data.release ?? {}
  const victim = targets[1] ?? targets[0]
  const corrupt = await sim('POST', '/test-hooks/corrupt', { deviceId: victim, releaseId: relC.id })
  check('已篡改一台设备的暂存摘要', corrupt.status === 200, JSON.stringify(corrupt.data))
  const judged = await api('POST', `/api/releases/${relC.id}/reconcile`)
  check('核对发现不符后保持未发布', judged.data.release?.status === 'failed', JSON.stringify(judged.data))
  check('不符发布无生效代次', judged.data.release?.generation == null)
  check('不符回执被如实记录', (judged.data.release?.receipts ?? []).some((r) => !r.matches))
  const cur3 = await api('GET', '/api/generation/current')
  check('全局代次未被污染', cur3.data.generation === genB)

  console.log('— 已完成发布的重传仍返回原结果 —')
  const again = await api('POST', '/api/releases', { releaseKey: keyA, targets, params: paramsA })
  check('重传幂等', again.status === 200 && again.data.release?.generation === genA)
  const detail = await api('GET', `/api/releases/${relA.id}`)
  check('发布详情含逐台回执', detail.data.release?.receipts?.length === targets.length)

  console.log('— 入参校验 —')
  const bad = await api('POST', '/api/releases', { releaseKey: keyA, targets: [], params: 'x' })
  check('空目标列表返回 400', bad.status === 400)

  if (failures > 0) {
    console.error(`\n[smoke] 失败 ${failures} 项`)
    process.exit(1)
  }
  console.log('\n[smoke] 全部通过')
}

main().catch((err) => {
  console.error(`[smoke] 异常中止: ${err.stack || err.message}`)
  process.exit(1)
})
