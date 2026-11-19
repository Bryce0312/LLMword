import { runtimeFailure } from './core/contracts.mjs'

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []; let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes <= 65536) chunks.push(chunk)
  }
  if (bytes > 65536) throw runtimeFailure('BODY_TOO_LARGE', '运行验证材料总量不能超过 64KB。', 413)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw runtimeFailure('INVALID_JSON', '请求体必须为 JSON。') }
}

function subscribe(runtime, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
  res.flushHeaders()
  let disconnected = false
  let unsubscribe = () => {}
  const write = (data) => {
    if (disconnected || res.destroyed) return false
    if (!res.write(data)) { disconnected = true; unsubscribe(); res.destroy(); return false }
    return true
  }
  const frame = (event) => `id: ${event.serverEpoch}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
  const snapshot = runtime.snapshot()
  const epoch = runtime.metadata.serverEpoch
  const upper = Number(snapshot.coveredThroughCursor.split(':').at(-1))
  const match = String(req.headers['last-event-id'] || '').match(/^([^:]+):(\d+)$/)
  const cursor = match ? Number(match[2]) : null
  const valid = match && match[1] === epoch && Number.isSafeInteger(cursor) && cursor <= upper
  write(`${valid ? '' : `id: ${snapshot.coveredThroughCursor}\n`}retry: 1500\ndata: ${JSON.stringify({ schemaVersion: 1, serverEpoch: epoch, type: 'sync', payload: {
    reset: !valid, ...snapshot,
  } })}\n\n`)
  if (valid) {
    let afterSeq = cursor
    while (!disconnected) {
      const batch = runtime.listEvents({ afterSeq, limit: 200 })
      if (!batch.length) break
      for (const event of batch) {
        if (event.seq > upper) break
        if (!write(frame(event))) break
        afterSeq = event.seq
      }
      if (afterSeq >= upper || batch.length < 200) break
    }
  }
  if (disconnected) return
  unsubscribe = runtime.subscribe((event) => write(frame(event)))
  const heartbeat = setInterval(() => write(': keepalive\n\n'), 15000)
  heartbeat.unref()
  res.on('close', () => { disconnected = true; clearInterval(heartbeat); unsubscribe() })
}

export async function handleRuntimeApi(runtime, req, res) {
  try {
    if (!runtime) throw runtimeFailure('RUNTIME_DISABLED', 'M0 验证入口尚未启用。', 503)
    const path = new URL(req.url, 'http://localhost').pathname
    if (req.method === 'GET' && path === '/api/v1/runtime') {
      send(res, 200, { ...runtime.capabilities, ...runtime.metadata }); return
    }
    if (req.method === 'GET' && path === '/api/v1/events') { subscribe(runtime, req, res); return }
    if (path === '/api/v1/runtime/probes') {
      if (req.method === 'GET') { send(res, 200, { runs: runtime.listRuns() }); return }
      if (req.method === 'POST') {
        const key = req.headers['idempotency-key']
        if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 120)) {
          throw runtimeFailure('INVALID_IDEMPOTENCY_KEY', '幂等键须为一至一百二十个字符。')
        }
        const run = runtime.createProbe(await readBody(req), { idempotencyKey: key })
        send(res, 202, run); return
      }
    }
    const found = path.match(/^\/api\/v1\/runs\/([a-zA-Z0-9_-]{1,120})(\/cancel)?$/)
    if (found) {
      if (req.method === 'GET' && !found[2]) { send(res, 200, runtime.getRun(found[1])); return }
      if (req.method === 'POST' && found[2]) { send(res, 200, runtime.cancelRun(found[1])); return }
    }
    throw runtimeFailure('NOT_FOUND', '找不到此运行 API。', 404)
  } catch (error) {
    send(res, error.status || 500, { error: { code: error.code || 'RUNTIME_ERROR',
      message: error.code ? error.message : '运行服务暂时无法响应。', retryable: Boolean(error.retryable) } })
  }
}
