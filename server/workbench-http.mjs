function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function body(req) {
  const chunks = []; let count = 0
  for await (const chunk of req) { count += chunk.length; if (count <= 65536) chunks.push(chunk) }
  if (count > 65536) throw Object.assign(new Error('资料总量不能超过 64KB。'), { code: 'BODY_TOO_LARGE', status: 413 })
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* reported below */ }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('请求体必须是 JSON 对象。'), { code: 'INVALID_JSON', status: 400 })
  return value
}

function version(value, field) {
  if (value === null) return undefined
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw Object.assign(new Error(`${field} 必须是正整数。`), { code: 'INVALID_VERSION', status: 400 })
  return number
}

/** Return false when the route belongs to the runtime/V0 API. */
export async function handleWorkbenchApi(workbench, req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const owned = /^\/api\/v1\/(config|topics|predictions|agents|tools|learning|imports)(\/|$)/.test(path) ||
    /^\/api\/v1\/runs\/[^/]+\/events$/.test(path)
  if (!owned) return false
  try {
    if (!workbench) throw Object.assign(new Error('新版工作台未启用，请开启支持 SQLite 的服务。'), { code: 'WORKBENCH_DISABLED', status: 503 })
    const key = req.headers['idempotency-key']
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 120)) throw Object.assign(new Error('幂等键格式无效。'), { code: 'INVALID_IDEMPOTENCY_KEY', status: 400 })
    const options = { idempotencyKey: key }
    const method = req.method
    let match
    if (method === 'GET' && path === '/api/v1/config') send(res, 200, workbench.config())
    else if (path === '/api/v1/topics' && method === 'GET') send(res, 200, { topics: workbench.listTopics() })
    else if (path === '/api/v1/topics' && method === 'POST') send(res, 201, workbench.createTopic(await body(req), options))
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'GET') send(res, 200, workbench.getTopic(match[1]))
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'PATCH') send(res, 200, workbench.updateTopic(match[1], await body(req), options))
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})\/predictions$/)) && method === 'POST') send(res, 201, workbench.createPrediction(match[1], await body(req), options))
    else if (path === '/api/v1/predictions' && method === 'GET') send(res, 200, { predictions: workbench.listPredictions({ topicId: url.searchParams.get('topicId') || undefined }) })
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})\/predictions$/)) && method === 'GET') send(res, 200, { predictions: workbench.listPredictions({ topicId: match[1] }) })
    else if ((match = path.match(/^\/api\/v1\/predictions\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'GET') send(res, 200, workbench.getPrediction(match[1], { version: version(url.searchParams.get('version'), 'version') }))
    else if ((match = path.match(/^\/api\/v1\/predictions\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'PATCH') send(res, 200, workbench.updatePrediction(match[1], await body(req), options))
    else if ((match = path.match(/^\/api\/v1\/predictions\/([a-zA-Z0-9_-]{1,120})\/runs$/)) && method === 'GET') send(res, 200, { runs: workbench.listRuns(match[1]) })
    else if ((match = path.match(/^\/api\/v1\/predictions\/([a-zA-Z0-9_-]{1,120})\/runs$/)) && method === 'POST') send(res, 202, workbench.createRun(match[1], await body(req), options))
    else if ((match = path.match(/^\/api\/v1\/runs\/([a-zA-Z0-9_-]{1,120})\/events$/)) && method === 'GET') send(res, 200, { events: workbench.runEvents(match[1]) })
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})\/evidence$/)) && method === 'GET') send(res, 200, { evidence: workbench.listEvidence({ topicId: match[1], predictionId: url.searchParams.get('predictionId') || undefined }) })
    else if ((match = path.match(/^\/api\/v1\/topics\/([a-zA-Z0-9_-]{1,120})\/evidence$/)) && method === 'POST') send(res, 201, workbench.addEvidence(match[1], await body(req), options))
    else if (path === '/api/v1/agents' && method === 'GET') send(res, 200, { agents: workbench.listAgents() })
    else if (path === '/api/v1/agents' && method === 'POST') send(res, 201, workbench.saveAgent(await body(req), options))
    else if ((match = path.match(/^\/api\/v1\/agents\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'GET') send(res, 200, workbench.getAgent(match[1], { specVersion: version(url.searchParams.get('specVersion'), 'specVersion') }))
    else if ((match = path.match(/^\/api\/v1\/agents\/([a-zA-Z0-9_-]{1,120})$/)) && method === 'DELETE') send(res, 200, workbench.deleteAgent(match[1], await body(req), options))
    else if (path === '/api/v1/tools' && method === 'GET') send(res, 200, workbench.tools())
    else if (path === '/api/v1/learning' && method === 'GET') send(res, 200, { entries: workbench.listLearning() })
    else if (path === '/api/v1/imports/legacy' && method === 'POST') {
      const data = await body(req)
      if (Object.keys(data).length) throw Object.assign(new Error('迁移入口只导入本机已打开的旧案例，不接受外部路径。'), { code: 'INVALID_IMPORT', status: 400 })
      send(res, 201, await workbench.importLegacy())
    } else send(res, 404, { error: { code: 'NOT_FOUND', message: '找不到此工作台 API。', retryable: false } })
  } catch (error) {
    send(res, error.status || 500, { error: { code: error.code || 'WORKBENCH_ERROR', message: error.code ? error.message : '工作台暂时无法处理请求。', retryable: Boolean(error.retryable), ...(error.fields ? { fields: error.fields } : {}) } })
  }
  return true
}
