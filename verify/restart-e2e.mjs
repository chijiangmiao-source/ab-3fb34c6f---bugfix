/**
 * 恢复一致性端到端验收：以真实进程运行 app + devices 模拟器，
 * 在“最终切换前 / 部分目标切换后 / 一台设备拒绝”等中断边界杀死并重启 app，
 * 核对：
 *   - 重启与同标识重复提交最终只产生一个发布结果和一个代次；
 *   - 未全部确认前页面/接口不显示已发布；
 *   - 重启后逐台核对补齐，所有目标设备的实际生效（发布编号/摘要/代次）一致；
 *   - 一台设备拒绝时页面不会提前显示完成，恢复后才收敛。
 *
 * 用法：node verify/restart-e2e.mjs [--bin-dir=...]
 * 退出码非零即验收失败。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const APP_DIR = path.join(ROOT, 'server')
const DEV_DIR = path.join(ROOT, 'devices')

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures += 1
    console.error(`  ✘ ${name} ${extra}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* 未就绪 */ }
    await sleep(250)
  }
  throw new Error(`服务未就绪: ${url}`)
}

async function req(base, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const children = []
function startService(name, cwd, env) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${name}!] ${d}`))
  children.push(child)
  return child
}

function killApp(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.killed) return resolve()
    child.on('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

async function pollRelease(api, id, fn, { tries = 40, label } = {}) {
  let last
  for (let i = 0; i < tries; i += 1) {
    const r = await req(api, 'GET', `/api/releases/${id}`)
    last = r.data.release
    if (fn(last)) return last
    await sleep(250)
  }
  check(label || `发布 #${id} 达到预期状态`, false, JSON.stringify(last))
  return last
}

async function main() {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'optics-restart-'))
  const appData = path.join(work, 'app')
  const devData = path.join(work, 'devices')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(devData, { recursive: true })

  const SIM_PORT = 9131
  const APP_PORT = 8131
  const SIM = `http://127.0.0.1:${SIM_PORT}`
  const API = `http://127.0.0.1:${APP_PORT}`
  const DEVICES = ['collector-1', 'collector-2', 'collector-3']

  let app
  const startApp = () =>
    startService('app', APP_DIR, {
      PORT: String(APP_PORT),
      DATA_DIR: appData,
      WEB_DIST: path.join(ROOT, 'web', 'dist'),
      SIMULATOR_URL: SIM,
      KNOWN_DEVICES: DEVICES.join(','),
      TEST_HOOKS: '1',
    })

  // 设备模拟器全程不重启（独立持久化），仅 app 在中断边界被杀
  startService('devices', DEV_DIR, { PORT: String(SIM_PORT), DATA_DIR: devData, TEST_HOOKS: '1' })
  await waitFor(`${SIM}/health`)

  const run = `restart-${Date.now()}`

  // —— 场景 1：最终切换前中断（一台都未切换）——
  console.log('— 场景1：最终切换前杀死进程，重启后核对补齐 —')
  app = startApp()
  await waitFor(`${API}/api/health`)
  const key1 = `${run}-a`
  const params1 = 'gain=1.5\nbias=0.02\nintegration_ms=120'
  const c1 = await req(API, 'POST', '/api/test-hooks/simulate-crash-during-activate', {
    releaseKey: key1, targets: DEVICES, params: params1, activateCount: 0,
  })
  check('崩溃演练进入生效中且已预占代次', c1.status === 201 && c1.data.release?.status === 'activating'
    && c1.data.release?.generation === 1 && c1.data.release?.summary?.activated === 0,
    JSON.stringify(c1.data))
  const id1 = c1.data.release.id
  for (const d of DEVICES) {
    const a = await req(SIM, 'GET', `/devices/${d}/active`)
    check(`设备 ${d} 尚无生效版本`, a.status === 404)
  }
  const curStuck1 = await req(API, 'GET', '/api/generation/current')
  check('未全部生效前当前生效代次不指向该发布', curStuck1.data.generation == null)

  await killApp(app)
  app = startApp()
  await waitFor(`${API}/api/health`) // 健康入口在恢复核对期间即可访问
  const h1 = await pollRelease(API, id1, (r) => r.status === 'published', {
    label: '重启后发布 #1 收敛为已发布',
  })
  check('重启后发布 #1 已发布且代次为 1', h1?.status === 'published' && h1?.generation === 1)
  check('发布 #1 三台设备生效确认齐备且一致',
    h1?.summary?.activated === 3
    && (h1?.activations ?? []).every((a) => a.matches && a.generation === 1 && a.digest === h1.digest))
  for (const d of DEVICES) {
    const a = await req(SIM, 'GET', `/devices/${d}/active`)
    check(`设备 ${d} 实际生效与发布一致`,
      a.data.releaseId === id1 && a.data.generation === 1 && a.data.digest === h1.digest,
      JSON.stringify(a.data))
  }
  const cur1 = await req(API, 'GET', '/api/generation/current')
  check('当前生效代次为 1 且指向发布 #1', cur1.data.generation === 1 && cur1.data.releaseId === id1)

  // 同标识重传：唯一发布结果与唯一代次
  const dup1 = await req(API, 'POST', '/api/releases', { releaseKey: key1, targets: DEVICES, params: params1 })
  check('重传返回 200 duplicate 且为同一发布/代次',
    dup1.status === 200 && dup1.data.duplicate === true
    && dup1.data.release?.id === id1 && dup1.data.release?.generation === 1
    && dup1.data.release?.status === 'published')

  // —— 场景 2：部分目标完成最终切换后中断 ——
  console.log('— 场景2：部分目标切换后杀死进程，重启逐台核对补齐 —')
  const key2 = `${run}-b`
  const params2 = 'gain=2.0\nbias=0.03'
  const c2 = await req(API, 'POST', '/api/test-hooks/simulate-crash-during-activate', {
    releaseKey: key2, targets: DEVICES, params: params2, activateCount: 1,
  })
  check('发布 #2 进入生效中，仅一台设备实际切换',
    c2.data.release?.status === 'activating' && c2.data.release?.generation === 2,
    JSON.stringify(c2.data))
  const id2 = c2.data.release.id
  const a2first = await req(SIM, 'GET', `/devices/${DEVICES[0]}/active`)
  check('第一台设备已实际切换到发布 #2', a2first.data.releaseId === id2 && a2first.data.generation === 2)
  const listStuck = await req(API, 'GET', '/api/releases')
  check('列表页不提前显示已发布',
    listStuck.data.releases?.find((r) => r.id === id2)?.status === 'activating')

  await killApp(app)
  app = startApp()
  await waitFor(`${API}/api/health`)
  const h2 = await pollRelease(API, id2, (r) => r.status === 'published', {
    label: '重启后发布 #2 收敛为已发布',
  })
  check('发布 #2 已发布且代次严格递增为 2', h2?.status === 'published' && h2?.generation === 2)
  check('发布 #2 三台设备实际生效一致',
    h2?.summary?.activated === 3
    && (h2?.activations ?? []).every((a) => a.matches && a.generation === 2 && a.digest === h2.digest))
  for (const d of DEVICES) {
    const a = await req(SIM, 'GET', `/devices/${d}/active`)
    check(`设备 ${d} 实际生效为发布 #2/G2`,
      a.data.releaseId === id2 && a.data.generation === 2 && a.data.digest === h2.digest)
  }
  const dup2 = await req(API, 'POST', '/api/releases', { releaseKey: key2, targets: DEVICES, params: params2 })
  check('发布 #2 重传仍为同一结果',
    dup2.status === 200 && dup2.data.duplicate === true
    && dup2.data.release?.id === id2 && dup2.data.release?.generation === 2)

  // —— 场景 3：一台设备拒绝最终切换 ——
  console.log('— 场景3：一台设备拒绝切换，重启与重传都不得提前显示完成 —')
  const key3 = `${run}-c`
  const params3 = 'gain=3.0\nbias=0.04'
  const fault = await req(SIM, 'POST', '/test-hooks/activate-fault', { deviceId: DEVICES[2], mode: 'reject' })
  check('注入设备拒绝故障', fault.status === 200 && fault.data.mode === 'reject')
  const c3 = await req(API, 'POST', '/api/test-hooks/simulate-crash-during-activate', {
    releaseKey: key3, targets: DEVICES, params: params3, activateCount: 1,
  })
  // 钩子会顺序切换第一台；拒绝故障在第三台，不影响前两台之外的预置
  check('发布 #3 进入生效中', c3.data.release?.status === 'activating', JSON.stringify(c3.data))
  const id3 = c3.data.release.id

  await killApp(app)
  app = startApp()
  await waitFor(`${API}/api/health`)
  // 启动核对期间第三台仍拒绝：保持 activating（轮询确认拒绝确实被核对到，而非尚未核到）
  const stuck = await pollRelease(API, id3, (r) => r.status === 'activating' && r.summary?.activated === 2,
    { label: '拒绝未恢复前保持生效中且仅两台确认', tries: 20 })
  check('拒绝未恢复前不显示已发布', stuck?.status === 'activating')
  check('仅两台设备完成生效确认', stuck?.summary?.activated === 2)
  const curStuck3 = await req(API, 'GET', '/api/generation/current')
  check('当前生效代次仍停在前序发布 G2', curStuck3.data.generation === 2)

  // 同标识重传：结果与当前恢复阶段一致（仍为生效中），不产生新发布
  const retried = await req(API, 'POST', '/api/releases', { releaseKey: key3, targets: DEVICES, params: params3 })
  check('拒绝期间重传返回同一发布且仍为生效中',
    retried.status === 200 && retried.data.duplicate === true
    && retried.data.release?.id === id3 && retried.data.release?.status === 'activating'
    && retried.data.release?.generation === 3)

  // 设备恢复：核对后收敛
  const cleared = await req(SIM, 'POST', '/test-hooks/activate-fault', { deviceId: DEVICES[2], mode: 'ok' })
  check('解除设备拒绝故障', cleared.status === 200 && cleared.data.mode === 'ok')
  await req(API, 'POST', '/api/admin/reconcile')
  const h3 = await pollRelease(API, id3, (r) => r.status === 'published', {
    label: '设备恢复后发布 #3 收敛为已发布',
  })
  check('发布 #3 已发布且代次为 3', h3?.status === 'published' && h3?.generation === 3)
  check('发布 #3 三台设备实际生效一致',
    h3?.summary?.activated === 3
    && (h3?.activations ?? []).every((a) => a.matches && a.generation === 3 && a.digest === h3.digest))

  // —— 全局唯一性核对 ——
  console.log('— 全局：三个发布、三个连续代次、逐设备一致 —')
  const list = await req(API, 'GET', '/api/releases')
  check('发布记录恰好三条且全部已发布',
    (list.data.releases ?? []).length === 3
    && list.data.releases.every((r) => r.status === 'published'))
  const cur = await req(API, 'GET', '/api/generation/current')
  check('当前生效代次为 3', cur.data.generation === 3 && cur.data.releaseId === id3)

  if (failures > 0) {
    console.error(`\n[restart-e2e] 失败 ${failures} 项`)
    process.exitCode = 1
  } else {
    console.log('\n[restart-e2e] 全部通过')
  }
}

function killAll() {
  for (const child of children) {
    if (child.exitCode == null && !child.killed) child.kill('SIGKILL')
  }
}
process.on('SIGTERM', () => { killAll(); process.exit(1) })
process.on('SIGINT', () => { killAll(); process.exit(1) })

main()
  .then(() => {
    killAll()
    process.exit(failures > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.error(`[restart-e2e] 异常中止: ${err.stack || err.message}`)
    killAll()
    process.exit(1)
  })
