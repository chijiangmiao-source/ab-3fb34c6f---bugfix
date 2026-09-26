import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const num = (v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error('非法的发布编号')
    err.status = 400
    err.code = 'INVALID_ID'
    throw err
  }
  return n
}

export function createApp({ service, webDist, testHooks = false }) {
  const app = express()
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'optics-release-api', time: new Date().toISOString() })
  })

  app.get('/api/devices', (req, res) => {
    res.json({ devices: service.knownDevices() })
  })

  app.get('/api/generation/current', (req, res) => {
    res.json(service.currentGeneration())
  })

  app.post('/api/releases', asyncH(async (req, res) => {
    const result = await service.createRelease(req.body)
    res.status(result.duplicate ? 200 : 201).json(result)
  }))

  app.get('/api/releases', (req, res) => {
    res.json({ releases: service.listReleases() })
  })

  app.get('/api/releases/:id', asyncH(async (req, res) => {
    res.json({ release: service.getRelease(num(req.params.id)) })
  }))

  // 运维入口：对单个/全部未完结发布执行“核对并补记”
  app.post('/api/releases/:id/reconcile', asyncH(async (req, res) => {
    res.json({ release: await service.reconcileRelease(num(req.params.id)) })
  }))

  app.post('/api/admin/reconcile', asyncH(async (req, res) => {
    res.json(await service.reconcileAll())
  }))

  if (testHooks) {
    // 复现“设备暂存成功、回执落库前进程退出”的崩溃窗口（仅测试用途）
    app.post('/api/test-hooks/simulate-crash-after-stage', asyncH(async (req, res) => {
      res.status(201).json({ release: await service.simulateCrashAfterStage(req.body) })
    }))
  }

  // 前端静态资源（生产构建产物）
  if (webDist && fs.existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      res.sendFile(path.join(webDist, 'index.html'))
    })
  }

  // API 404 以 JSON 返回
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} 不存在` } })
  })

  // 统一错误出口：页面只读服务端已确认信息，错误也以结构化形式返回
  app.use((err, req, res, next) => {
    const status = err.status ?? 500
    if (status >= 500) console.error(err)
    res.status(status).json({
      error: {
        code: err.code ?? 'INTERNAL',
        message: err.message ?? 'internal error',
        details: err.details,
      },
    })
  })

  return app
}
