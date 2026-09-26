/** 页面只读服务端已确认信息：所有状态均来自以下接口。 */
async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败 (${res.status})`)
    err.status = res.status
    err.code = data?.error?.code
    err.details = data?.error?.details
    throw err
  }
  return data
}

export const listDevices = () => request('GET', '/api/devices')
export const listReleases = () => request('GET', '/api/releases')
export const getRelease = (id) => request('GET', `/api/releases/${id}`)
export const currentGeneration = () => request('GET', '/api/generation/current')
export const createRelease = (payload) => request('POST', '/api/releases', payload)
export const reconcileRelease = (id) => request('POST', `/api/releases/${id}/reconcile`)
