import path from 'node:path'
import { openDb } from './db.js'
import { createService } from './service.js'
import { createSimulatorClient } from './simulatorClient.js'
import { createApp } from './app.js'

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
const SIMULATOR_URL = process.env.SIMULATOR_URL || 'http://localhost:9000'
const WEB_DIST = process.env.WEB_DIST || path.resolve('web/dist')
const TEST_HOOKS = process.env.TEST_HOOKS === '1'
const KNOWN_DEVICES = (process.env.KNOWN_DEVICES || 'collector-1,collector-2,collector-3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const db = openDb(path.join(DATA_DIR, 'app.db'))
const simulator = createSimulatorClient(SIMULATOR_URL)
const service = createService({ db, simulator, knownDevices: KNOWN_DEVICES })

// 进程重启后的第一道动作：向模拟器核对并补记崩溃窗口内丢失的回执。
// 模拟器可能尚未就绪，做有限次退避重试；之后由周期任务兜底。
async function reconcileWithRetry(attempts = 5) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const { reconciled } = await service.reconcileAll()
      if (reconciled.length > 0) {
        console.log(`[reconcile] 启动核对补记完成: ${JSON.stringify(reconciled)}`)
      }
      return
    } catch (err) {
      console.error(`[reconcile] 第 ${i} 次核对失败: ${err.message}`)
      await sleep(500 * i)
    }
  }
}

await reconcileWithRetry()
setInterval(() => {
  service.reconcileAll().catch((err) => console.error(`[reconcile] 周期核对失败: ${err.message}`))
}, 10_000).unref()

const app = createApp({ service, webDist: WEB_DIST, testHooks: TEST_HOOKS })
app.listen(PORT, () => {
  console.log(`低温光学台参数发布接口已启动: http://0.0.0.0:${PORT} (模拟器: ${SIMULATOR_URL})`)
})
