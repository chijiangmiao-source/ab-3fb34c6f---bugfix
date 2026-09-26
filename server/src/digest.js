import { createHash } from 'node:crypto'

/**
 * 参数文本的内容摘要。摘要按原文逐字节计算，
 * 同一发布标识下载荷不同则摘要必然不同（用于冲突判定）。
 */
export function digestParams(params) {
  return createHash('sha256').update(params, 'utf8').digest('hex')
}
