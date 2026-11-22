import { DEFAULT_CHAT_COMPLETIONS_URL, DEFAULT_MODEL_NAME, validateModelConnection } from './runtime/model-endpoint.mjs'

const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status })

/** Session-only credentials. The public view never includes keys or fragments. */
export function createProviderConnection({ configured = false, locked = false, getActiveCount, getActiveWatchCount = () => 0, applyKey, getMode = () => 'live', url = DEFAULT_CHAT_COMPLETIONS_URL, model = DEFAULT_MODEL_NAME, loadPricing }) {
  let settings = validateModelConnection({ url, model })
  let keySource = configured ? 'environment' : 'none'
  let connection = 'unknown'
  let verifiedAt = null
  let changing = false
  const emptyPricing = (reason, checkedAt = null) => ({ status: 'unavailable', model: settings.model, currency: null, unitTokens: 1000000, inputCacheHit: null, inputCacheMiss: null, output: null, sourceUrl: null, checkedAt, reason })
  let pricing = emptyPricing('连接模型后更新价格。')
  async function refreshPricing() {
    if (typeof loadPricing !== 'function') return
    pricing = { ...emptyPricing('正在读取最新公开价格。'), status: 'loading' }
    try {
      const value = await loadPricing({ url: settings.url, model: settings.model })
      pricing = value && ['available', 'unavailable'].includes(value.status) ? { ...value, model: settings.model } : emptyPricing('暂未取得最新公开价格。', new Date().toISOString())
    } catch { pricing = emptyPricing('未能获取最新公开价格；模型连接设置已保存。', new Date().toISOString()) }
  }
  const status = () => {
    const activeRuns = getActiveCount()
    const activeWatchers = getActiveWatchCount()
    return { provider: 'deepseek', configured, keySource, connection, verifiedAt, modelMode: getMode(), persistence: 'server-session', locked, url: settings.url, model: settings.model, pricing: structuredClone(pricing),
      activeRuns, activeWatchers, canUpdate: !locked && !changing && (!configured || (activeRuns === 0 && activeWatchers === 0)), changing }
  }
  return {
    status, refreshPricing,
    get changing() { return changing },
    async update(input) {
      if (locked) throw fault('MODE_LOCKED', '当前是模拟环境，不能保存真实 API Key。请使用 npm run start:live。', 409)
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['apiKey', 'url', 'model'].includes(k)) ||
        typeof input.apiKey !== 'string' || !/^[a-zA-Z0-9._-]{12,512}$/.test(input.apiKey.trim())) {
        throw fault('INVALID_API_KEY', '请输入有效的 DeepSeek API Key，不要包含空格或换行。')
      }
      let nextSettings
      try { nextSettings = validateModelConnection({ url: input.url === undefined ? settings.url : input.url, model: input.model === undefined ? settings.model : input.model }) }
      catch { throw fault('INVALID_MODEL_CONFIG', '请输入有效的 HTTP(S) 模型 URL 和模型名称；URL 不应包含账号、密码或查询参数。') }
      if (changing || (configured && (getActiveCount() > 0 || getActiveWatchCount() > 0))) throw fault('PROVIDER_UPDATE_BUSY', '保存已拒绝：仍有正在运行、排队或持续监听的任务，原 API Key 保持不变。请先停止这些任务，再重新保存。', 409)
      changing = true
      try {
        const applied = await applyKey(input.apiKey.trim(), nextSettings)
        settings = nextSettings
        configured = true; keySource = 'session'
        if (applied && ['connected', 'failed'].includes(applied.connection)) {
          connection = applied.connection
          verifiedAt = new Date().toISOString()
        }
        await refreshPricing()
      } catch {
        throw fault('PROVIDER_UPDATE_FAILED', '连接配置未能更新，请检查服务设置后重试。', 503)
      } finally { changing = false }
      return status()
    },
  }
}

const send = (res, code, value) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
export async function handleProviderConnection(connection, req, res) {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path !== '/api/v1/course/provider-connection') return false
  try {
    if (!connection) throw fault('CONNECTION_UNAVAILABLE', '请先启动支持 SQLite 的新版工作台。', 503)
    if (req.method === 'GET') send(res, 200, connection.status())
    else if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fault('JSON_REQUIRED', '请通过研究室连接表单保存。', 415)
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size <= 4096) chunks.push(chunk) }
      if (size > 4096) throw fault('BODY_TOO_LARGE', '连接配置内容过长。', 413)
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fault('INVALID_JSON', '连接配置格式无效。') }
      send(res, 200, await connection.update(input))
    } else send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '该连接入口仅支持读取或保存。' } })
  } catch (error) {
    const known = ['INVALID_API_KEY', 'INVALID_MODEL_CONFIG', 'PROVIDER_UPDATE_BUSY', 'PROVIDER_UPDATE_FAILED', 'CONNECTION_UNAVAILABLE', 'JSON_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_JSON', 'MODE_LOCKED'].includes(error.code)
    send(res, known ? error.status : 500, { error: { code: known ? error.code : 'CONNECTION_FAILED', message: known ? error.message : '连接配置暂时不可用。', retryable: false } })
  }
  return true
}
