const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req) {
  const chunks = []; let length = 0
  for await (const chunk of req) { length += chunk.length; if (length <= 16384) chunks.push(chunk) }
  if (length > 16384) throw fail('BODY_TOO_LARGE', '问题不能超过 16KB。', 413)
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('INVALID_JSON', '请提交有效的问题对象。')
  return parsed
}
const id = '[a-zA-Z0-9_-]{1,120}'

/** Isolated course API; the material-reading and legacy APIs remain available. */
export async function handleCourseApi(course, req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/v1/course/')) return false
  try {
    if (!course) throw fail('COURSE_DISABLED', '自动研究服务未启用，请使用支持 SQLite 的服务。', 503)
    const key = req.headers['idempotency-key']
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 120)) throw fail('INVALID_IDEMPOTENCY_KEY', '请求编号无效。')
    let match
    if (req.method === 'GET' && url.pathname === '/api/v1/course/config') {
      send(res, 200, typeof course.config === 'function' ? course.config() : course.capabilities || {})
    } else if (url.pathname === '/api/v1/course/settings' && req.method === 'GET') {
      send(res, 200, course.getSettings())
    } else if (url.pathname === '/api/v1/course/settings' && req.method === 'PUT') {
      send(res, 200, course.updateSettings(await body(req)))
    } else if (url.pathname === '/api/v1/course/requests' && req.method === 'GET') {
      send(res, 200, { requests: course.listRequests(), deletedRequestIds: course.listDeletedRequestIds?.() || [], deletedPredictionIds: course.listDeletedPredictionIds?.() || [] })
    } else if (url.pathname === '/api/v1/course/requests' && req.method === 'POST') {
      send(res, 202, await course.createRequest(await body(req), { idempotencyKey: key }))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/requests/(${id})$`))) && req.method === 'GET') {
      send(res, 200, course.getRequest(match[1]))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/requests/(${id})$`))) && req.method === 'DELETE') {
      send(res, 200, course.deleteRequest(match[1], await body(req)))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/requests/(${id})/resolve$`))) && req.method === 'POST') {
      if (Object.keys(await body(req)).length) throw fail('INVALID_ACTION', '结果核验不接受自填标签、来源或时间。')
      send(res, 200, await course.resolve(match[1]))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/requests/(${id})/(check|stop)$`))) && req.method === 'POST') {
      if (Object.keys(await body(req)).length) throw fail('INVALID_ACTION', '此操作不接受额外参数。')
      const result = match[2] === 'check' ? await course.check(match[1]) : await course.stop(match[1])
      send(res, match[2] === 'check' ? 202 : 200, result)
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/runs/(${id})/resume-summary$`))) && req.method === 'POST') {
      if (Object.keys(await body(req)).length) throw fail('INVALID_ACTION', '续写汇总不接受额外参数。')
      send(res, 202, course.resumeResearchSummary(match[1]))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/runs/(${id})/assemble-report$`))) && req.method === 'POST') {
      if (Object.keys(await body(req)).length) throw fail('INVALID_ACTION', '整理已有报告不接受额外参数。')
      send(res, 200, course.assembleResearchReport(match[1]))
    } else if ((match = url.pathname.match(new RegExp(`^/api/v1/course/runs/(${id})$`))) && req.method === 'GET') {
      send(res, 200, course.getRun(match[1]))
    } else if (url.pathname === '/api/v1/course/events' && req.method === 'GET') {
      const after = url.searchParams.get('afterSeq') || '0'
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw fail('INVALID_CURSOR', '事件位置无效。')
      send(res, 200, { events: course.listEvents({ afterSeq: Number(after), runId: url.searchParams.get('runId') || undefined }) })
    } else send(res, 404, { error: { code: 'NOT_FOUND', message: '找不到这个自动研究入口。', retryable: false } })
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
    const publicFailure = (status < 500 || error.code === 'COURSE_DISABLED') && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
    send(res, status, { error: { code: publicFailure ? error.code : 'COURSE_ERROR',
      message: publicFailure ? error.message : '自动研究暂时无法处理请求。', retryable: Boolean(error.retryable) } })
  }
  return true
}
