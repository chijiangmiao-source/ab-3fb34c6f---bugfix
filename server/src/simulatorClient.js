/** 设备模拟器 HTTP 客户端：按发布编号与摘要幂等暂存。 */
export function createSimulatorClient(baseUrl, { timeoutMs = 5000 } = {}) {
  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || `simulator responded ${res.status}`)
      err.status = res.status
      err.payload = data
      throw err
    }
    return data
  }

  return {
    /** 幂等暂存：同 (device, releaseId) 同摘要返回原回执；异摘要抛 409。 */
    stage: (deviceId, payload) =>
      request('POST', `/devices/${encodeURIComponent(deviceId)}/stage`, payload),

    activate: (deviceId, payload) =>
      request('POST', `/devices/${encodeURIComponent(deviceId)}/activate`, payload),

    /** 核对设备当前持有的暂存内容；未暂存返回 null。 */
    getStage: async (deviceId, releaseId) => {
      try {
        return await request('GET', `/devices/${encodeURIComponent(deviceId)}/stages/${releaseId}`)
      } catch (err) {
        if (err.status === 404) return null
        throw err
      }
    },

    getActive: async (deviceId) => {
      try {
        return await request('GET', `/devices/${encodeURIComponent(deviceId)}/active`)
      } catch (err) {
        if (err.status === 404) return null
        throw err
      }
    },

    health: () => request('GET', '/health'),
  }
}
