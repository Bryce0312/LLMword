import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createCourseMockProvider } from './server/course/course-mock-provider.mjs'

// Independent HTTP acceptance: local synthetic model responses, never a paid provider or real weather prediction.
async function launch(t, { status = 402, onceOnly = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-provider-recovery-'))
  const protocol = createCourseMockProvider()
  const gate = { status, calls: 0 }
  const model = createServer(async (req, res) => {
    gate.calls++
    if (gate.status && (!onceOnly || gate.calls === 1)) {
      res.writeHead(gate.status, { 'Content-Type': 'application/json', 'Retry-After': '0' })
      res.end(JSON.stringify({ error: { message: 'private-provider-payload-must-stay-hidden', code: 'private-detail' } }))
      return
    }
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const result = await protocol.complete({ messages: body.messages, tools: body.tools })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: result.message, finish_reason: result.finishReason }], usage: result.usage, model: 'local-protocol' }))
    } catch { res.writeHead(500).end('{}') }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelUrl = `http://127.0.0.1:${model.address().port}`
  const child = spawn(process.execPath, ['server/app.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env,
    PORT: '0', WORLD_MODEL: 'openai', WORLD_MODEL_NAME: 'local-protocol', WORLD_BASE_URL: modelUrl, WORLD_API_KEY: 'synthetic-test-credential',
    WORLD_MODEL_PROTOCOL: 'openai', WORLD_MODEL_THINKING: 'disabled', WORLD_MODEL_REASONING_EFFORT: '',
    WORLD_MODEL_TIMEOUT_MS: '5000', WORLD_MONITOR: 'off', WORLD_WORKBENCH: 'on', WORLD_RUNTIME: 'probe', WORLD_COURSE: 'on',
    WORLD_SEARCH_PROVIDER: 'fixture', WORLD_COURSE_POLL_MS: '3600000', WORLD_STATE_PATH: join(folder, 'state.json'),
    WORLD_COURSE_PATH: join(folder, 'course.sqlite'), WORLD_DOMAIN_PATH: join(folder, 'domain.sqlite'), WORLD_RUNTIME_PATH: join(folder, 'runtime.sqlite'),
  } })
  const exited = once(child, 'exit'); let diagnostics = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited; await new Promise(resolve => model.close(resolve)); await rm(folder, { recursive: true, force: true })
  })
  const base = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]) })
    exited.then(() => reject(new Error(diagnostics)), reject)
  })
  async function api(path, input) {
    const res = await fetch(base + '/api/v1/course' + path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data
  }
  async function settled(id) {
    for (let i = 0; i < 250; i++) { const value = await api('/requests/' + id); if (value.run && ['failed', 'completed', 'insufficient', 'cancelled'].includes(value.run.status)) return value; await delay(40) }
    throw new Error('Local provider recovery did not settle')
  }
  return { gate, api, settled }
}

test('a model balance error pauses monitoring and the same unprepared question can recover manually without losing history', { timeout: 25000 }, async t => {
  const app = await launch(t)
  const created = await app.api('/requests', { question: '【协议测试】香港红磡今天会下雨吗？', horizonHours: 24, watch: true })
  const failed = await app.settled(created.requestId)
  assert.equal(failed.run.status, 'failed')
  assert.equal(failed.run.error.code, 'MODEL_BALANCE_REQUIRED')
  assert.equal(failed.run.error.httpStatus, 402)
  assert.equal(failed.run.error.actionRequired, true)
  assert.equal(failed.watch.status, 'paused_provider')
  assert.equal(failed.watch.nextDueAt, null)
  assert.equal(Boolean(failed.predictionId), false)
  assert.equal(app.gate.calls, 1, 'hard failures must not be blindly retried')
  assert(!JSON.stringify(failed).includes('private-provider-payload'))
  const originalRun = JSON.stringify(failed.run)
  app.gate.status = 0
  await app.api('/requests/' + created.requestId + '/check', {})
  const recovered = await app.settled(created.requestId)
  assert.equal(recovered.run.status, 'completed', JSON.stringify(recovered.run.error))
  assert(recovered.forecast)
  assert.equal(recovered.question, failed.question)
  assert.equal(recovered.createdAt, failed.createdAt)
  assert.equal(recovered.watch.status, 'active')
  assert.equal(JSON.stringify(recovered.runs[0]), originalRun)
  assert.equal(recovered.forecast.scoringEligible, false, 'fixture sources remain explicitly unscoreable')
})

test('bounded HTTP loop stops on a temporary service response with unknown usage and exposes an honest partial receipt', { timeout: 25000 }, async t => {
  const app = await launch(t, { status: 503, onceOnly: true })
  const created = await app.api('/requests', { question: '【协议测试】未来24小时科技展会开幕吗？', horizonHours: 24, watch: false })
  const recovered = await app.settled(created.requestId)
  assert.equal(recovered.run.status, 'insufficient', JSON.stringify(recovered.run.error))
  assert.equal(recovered.forecast, null)
  assert.equal(recovered.forecasts.length, 0)
  assert.equal(app.gate.calls, 1, 'HTTP 503 without usage does not establish a free attempt')
  assert.equal(recovered.run.usage.modelRequests, app.gate.calls)
  assert.equal(recovered.run.usage.unknownUsage, true)
  assert.equal(recovered.run.delivery.kind, 'partial_research')
  assert.equal(recovered.run.delivery.probabilityYes, null)
  assert.match(recovered.run.delivery.reason, /用量/)
  assert(recovered.run.events.some(event => event.type === 'budget.closeout'))
  assert(!JSON.stringify(recovered).includes('private-provider-payload'))
})
