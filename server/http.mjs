function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length <= 4096) chunks.push(chunk)
  }
  if (length > 4096) throw Object.assign(new Error('请求体过大。'), { status: 413 })
  if (!length) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      (Object.hasOwn(body, 'branch') && typeof body.branch !== 'string')) {
      throw new Error('Invalid shape')
    }
    return body
  } catch {
    throw Object.assign(new Error('请求体必须是合法的 JSON 对象。'), { status: 400 })
  }
}

export async function handleApi({ world, events, monitor, mode, runtime, workbench, course }, req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const route = `${req.method} ${pathname}`
  try {
    if (req.method === 'POST' && req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`) {
      send(res, 403, { error: '请从研究室页面发起此操作。' })
      return
    }
    if (pathname.startsWith('/api/v1/')) {
      const { handleCourseApi } = await import('./course-http.mjs')
      if (await handleCourseApi(course, req, res)) return
      const { handleWorkbenchApi } = await import('./workbench-http.mjs')
      if (await handleWorkbenchApi(workbench, req, res)) return
      const { handleRuntimeApi } = await import('./v1-http.mjs')
      await handleRuntimeApi(runtime, req, res)
      return
    }
    let result
    switch (route) {
      case 'GET /api/health':
        result = { ok: true, mode }
        break
      case 'GET /api/events':
        events.subscribe(req, res)
        return
      case 'GET /api/monitor':
        result = await monitor.get()
        break
      case 'GET /api/world':
        result = await world.get()
        break
      case 'POST /api/run': {
        const { branch } = await readBody(req)
        result = await events.run({ scope: 'replay', trigger: 'manual' }, (stream) => world.run({ branch, ...stream }))
        break
      }
      case 'POST /api/advance':
        result = await world.advance()
        break
      case 'POST /api/reset':
        result = await world.reset()
        break
      default:
        send(res, 404, { error: '找不到此 API。' })
        return
    }
    send(res, 200, result)
  } catch (error) {
    send(res, error.status || 500, { error: error.message || '研究室处理请求时失败。' })
  }
}
