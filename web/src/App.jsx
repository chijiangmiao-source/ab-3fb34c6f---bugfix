import { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'

const PHASE = {
  staging: { label: '暂存中', cls: 'badge-staging' },
  published: { label: '已发布', cls: 'badge-published' },
  failed: { label: '未发布（摘要不符）', cls: 'badge-failed' },
}

const short = (digest) => (digest ? `${digest.slice(0, 12)}…` : '—')
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—')

function PhaseBadge({ status }) {
  const p = PHASE[status] ?? { label: status, cls: '' }
  return <span className={`badge ${p.cls}`}>{p.label}</span>
}

function PublishForm({ devices, onPublished }) {
  const [releaseKey, setReleaseKey] = useState('')
  const [targets, setTargets] = useState([])
  const [params, setParams] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const toggle = (d) =>
    setTargets((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.createRelease({ releaseKey, targets, params })
      setResult(r)
      onPublished()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>提交发布</h2>
      <form onSubmit={submit}>
        <label>
          发布标识（稳定标识，重复提交按幂等处理）
          <input
            value={releaseKey}
            onChange={(e) => setReleaseKey(e.target.value)}
            placeholder="例如 optics-2026q3-a"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
            title="1-64 位，以字母或数字开头，可含 . _ -"
          />
        </label>
        <fieldset>
          <legend>目标采集器</legend>
          <div className="device-list">
            {devices.map((d) => (
              <label key={d} className="device-item">
                <input
                  type="checkbox"
                  checked={targets.includes(d)}
                  onChange={() => toggle(d)}
                />
                {d}
              </label>
            ))}
            {devices.length === 0 && <span className="muted">（采集器列表加载中…）</span>}
          </div>
        </fieldset>
        <label>
          参数文本
          <textarea
            value={params}
            onChange={(e) => setParams(e.target.value)}
            placeholder={'例如:\ngain=1.5\nbias=0.02\nintegration_ms=120'}
            rows={6}
            required
          />
        </label>
        <button type="submit" disabled={busy || targets.length === 0}>
          {busy ? '提交中…' : '提交发布'}
        </button>
      </form>
      {result && (
        <p className={result.duplicate ? 'notice notice-dup' : 'notice notice-ok'}>
          {result.duplicate ? '该标识已发布过，返回原结果。' : '发布已受理。'}
          发布编号 <strong>#{result.release.id}</strong>，汇总阶段{' '}
          <PhaseBadge status={result.release.status} />
          {result.release.generation != null && (
            <>，生效代次 <strong>G{result.release.generation}</strong></>
          )}
        </p>
      )}
      {error && (
        <p className="notice notice-err">
          {error.code === 'RELEASE_KEY_CONFLICT' ? '冲突：' : '错误：'}
          {error.message}
          {error.code === 'RELEASE_KEY_CONFLICT' && (
            <span className="muted">（已存在的发布 #{error.details?.existingReleaseId}）</span>
          )}
        </p>
      )}
    </section>
  )
}

function ReleaseDetail({ release, onClose, onReconcile }) {
  if (!release) return null
  return (
    <section className="card">
      <div className="detail-head">
        <h2>
          发布 #{release.id} · {release.releaseKey}
        </h2>
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      <dl className="meta">
        <div><dt>汇总阶段</dt><dd><PhaseBadge status={release.status} /></dd></div>
        <div><dt>生效代次</dt><dd>{release.generation != null ? `G${release.generation}` : '—'}</dd></div>
        <div><dt>参数摘要</dt><dd className="mono">{short(release.digest)}</dd></div>
        <div><dt>回执汇总</dt><dd>{release.summary.matched}/{release.summary.expected} 匹配（已收 {release.summary.received}）</dd></div>
        <div><dt>创建时间</dt><dd>{fmt(release.createdAt)}</dd></div>
        <div><dt>发布时间</dt><dd>{fmt(release.publishedAt)}</dd></div>
      </dl>
      <h3>各采集器暂存回执</h3>
      <table>
        <thead>
          <tr><th>采集器</th><th>回执摘要</th><th>暂存时间</th><th>与发布一致</th></tr>
        </thead>
        <tbody>
          {release.targets.map((d) => {
            const r = release.receipts.find((x) => x.deviceId === d)
            return (
              <tr key={d}>
                <td className="mono">{d}</td>
                {r ? (
                  <>
                    <td className="mono">{short(r.digest)}</td>
                    <td>{fmt(r.stagedAt)}</td>
                    <td>{r.matches ? '✅ 匹配' : '❌ 不符'}</td>
                  </>
                ) : (
                  <td colSpan={3} className="muted">等待回执…</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {release.status === 'staging' && (
        <button onClick={() => onReconcile(release.id)}>立即核对并补记</button>
      )}
    </section>
  )
}

export default function App() {
  const [devices, setDevices] = useState([])
  const [releases, setReleases] = useState([])
  const [current, setCurrent] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [lastSync, setLastSync] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [rels, gen] = await Promise.all([api.listReleases(), api.currentGeneration()])
      setReleases(rels.releases)
      setCurrent(gen)
      setLastSync(new Date())
      setLoadError(null)
    } catch (err) {
      setLoadError(err.message)
    }
  }, [])

  useEffect(() => {
    api.listDevices().then((d) => setDevices(d.devices)).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    api.getRelease(selectedId).then((d) => setDetail(d.release)).catch(() => setDetail(null))
  }, [selectedId, releases])

  const reconcile = async (id) => {
    await api.reconcileRelease(id)
    await refresh()
  }

  return (
    <main>
      <header>
        <div>
          <h1>低温光学台参数发布</h1>
          <p className="muted">
            当前生效代次：
            {current?.generation != null ? (
              <strong>G{current.generation}</strong>
            ) : (
              <span>（尚未发布）</span>
            )}
            {current?.releaseKey && <span className="mono"> · {current.releaseKey}</span>}
          </p>
        </div>
        <div className="header-actions">
          {lastSync && <span className="muted">已同步 {lastSync.toLocaleTimeString('zh-CN', { hour12: false })}</span>}
          <button onClick={refresh}>刷新</button>
        </div>
      </header>
      {loadError && <p className="notice notice-err">服务端读取失败：{loadError}</p>}

      <PublishForm devices={devices} onPublished={refresh} />

      <section className="card">
        <h2>发布记录</h2>
        {releases.length === 0 ? (
          <p className="muted">暂无发布记录</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>编号</th><th>发布标识</th><th>摘要</th><th>汇总阶段</th>
                <th>回执</th><th>生效代次</th><th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr
                  key={r.id}
                  className={selectedId === r.id ? 'row-selected' : ''}
                  onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
                >
                  <td>#{r.id}</td>
                  <td className="mono">{r.releaseKey}</td>
                  <td className="mono">{short(r.digest)}</td>
                  <td><PhaseBadge status={r.status} /></td>
                  <td>{r.summary.received}/{r.summary.expected}</td>
                  <td>{r.generation != null ? `G${r.generation}` : '—'}</td>
                  <td>{fmt(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail && (
        <ReleaseDetail
          release={detail}
          onClose={() => setSelectedId(null)}
          onReconcile={reconcile}
        />
      )}
    </main>
  )
}
