const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status })

/** Session-only credentials. The public view never includes keys or fragments. */
export function createProviderConnection({ configured = false, locked = false, getActiveCount, getActiveWatchCount = () => 0, applyKey, getMode = () => 'live' }) {
  let keySource = configured ? 'environment' : 'none'
  let connection = 'unknown'
  let verifiedAt = null
  let changing = false
  const status = () => {
    const activeRuns = getActiveCount()
    const activeWatchers = getActiveWatchCount()
    return { provider: 'deepseek', configured, keySource, connection, verifiedAt, modelMode: getMode(), persistence: 'server-session', locked,
      activeRuns, activeWatchers, canUpdate: !locked && !changing && (!configured || (activeRuns === 0 && activeWatchers === 0)), changing }
  }
  return {
    status,
    get changing() { return changing },
    async update(input) {
      if (locked) throw fault('MODE_LOCKED', '当前是模拟环境，不能保存真实 API Key。请使用 npm run start:live。', 409)
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'apiKey') ||
        typeof input.apiKey !== 'string' || !/^[a-zA-Z0-9._-]{12,512}$/.test(input.apiKey.trim())) {
        throw fault('INVALID_API_KEY', '请输入有效的 DeepSeek API Key，不要包含空格或换行。')
      }
      if (changing || (configured && (getActiveCount() > 0 || getActiveWatchCount() > 0))) throw fault('PROVIDER_UPDATE_BUSY', '保存已拒绝：仍有正在运行、排队或持续监听的任务，原 API Key 保持不变。请先停止这些任务，再重新保存。', 409)
      changing = true
      try {
        const applied = await applyKey(input.apiKey.trim())
        configured = true; keySource = 'session'
        if (applied && ['connected', 'failed'].includes(applied.connection)) {
          connection = applied.connection
          verifiedAt = new Date().toISOString()
        }
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
    const known = ['INVALID_API_KEY', 'PROVIDER_UPDATE_BUSY', 'PROVIDER_UPDATE_FAILED', 'CONNECTION_UNAVAILABLE', 'JSON_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_JSON', 'MODE_LOCKED'].includes(error.code)
    send(res, known ? error.status : 500, { error: { code: known ? error.code : 'CONNECTION_FAILED', message: known ? error.message : '连接配置暂时不可用。', retryable: false } })
  }
  return true
}
