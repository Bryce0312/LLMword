import { randomUUID } from 'node:crypto'

export function createEvents() {
  const journal = []
  const clients = new Set()
  const active = new Map()
  let seq = Date.now() * 1000
  let queue = Promise.resolve()

  function write(client, data) {
    if (!client.destroyed && !client.write(data)) {
      // A disconnected or slow tab can reconnect from its last received cursor.
      clients.delete(client)
      client.destroy()
    }
  }

  const frame = (event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

  function publish(payload) {
    const event = { ...payload, seq: ++seq }
    journal.push(event)
    if (journal.length > 400) journal.shift()
    if (event.type === 'run-start') active.set(event.runId, event)
    if (event.type === 'run-complete' || event.type === 'run-error') active.delete(event.runId)
    const message = frame(event)
    for (const client of clients) write(client, message)
    return event
  }

  function subscribe(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })
    res.flushHeaders()
    const cursor = Number(req.headers['last-event-id'])
    const validCursor = cursor >= (journal[0]?.seq ?? seq) - 1 && cursor <= seq
    const backlog = validCursor
      ? journal.filter((event) => event.seq > cursor)
      : journal.filter((event) => active.has(event.runId))
    write(res, `retry: 1500\ndata: ${JSON.stringify({ type: 'sync', reset: !validCursor, active: [...active.values()] })}\n\n`)
    for (const event of backlog) write(res, frame(event))
    if (res.destroyed) return
    clients.add(res)
    const heartbeat = setInterval(() => write(res, ': keepalive\n\n'), 15000)
    heartbeat.unref()
    res.on('close', () => {
      clearInterval(heartbeat)
      clients.delete(res)
    })
  }

  function run({ scope, trigger, headline, runId = randomUUID() }, work) {
    const next = queue.then(async () => {
      const onEvent = (event) => publish({ ...event, runId, scope })
      onEvent({ type: 'run-start', trigger, headline })
      try {
        const result = await work({ runId, onEvent })
        onEvent({ type: 'run-complete' })
        return result
      } catch (error) {
        onEvent({ type: 'run-error', message: '会议未完成，研究室会保留上次记录。' })
        throw error
      }
    })
    queue = next.catch(() => {})
    return next
  }

  return { subscribe, publish, run }
}
