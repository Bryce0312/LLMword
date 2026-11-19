import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-m1-http-')); const stops = []
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(folder, { recursive: true, force: true }) })
  return { async launch() {
    const child = spawn(process.execPath, ['start.mjs'], { cwd: new URL('.', import.meta.url),
      env: { ...process.env, PORT: '0', WORLD_MODEL: 'mock', WORLD_API_KEY: '', WORLD_MONITOR: 'off',
        WORLD_WORKBENCH: 'on', WORLD_RUNTIME: 'probe', WORLD_MOCK_PACING: '0',
        WORLD_STATE_PATH: join(folder, 'legacy.json'), WORLD_RUNTIME_PATH: join(folder, 'runtime.sqlite'), WORLD_DOMAIN_PATH: join(folder, 'domain.sqlite') } })
    const exited = once(child, 'exit'); let diagnostics = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostics += chunk })
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited }
    stops.push(stop)
    const address = await new Promise((resolve, reject) => {
      let text = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { text += chunk; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]) })
      exited.then(() => reject(new Error(`M1 test server stopped: ${diagnostics}`)), reject)
    })
    async function request(path, { method = 'GET', data, key, expected = 200, headers = {} } = {}) {
      const response = await fetch(`${address}${path}`, { method, headers: { ...headers,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
      const payload = await response.json()
      assert.equal(response.status, expected, JSON.stringify(payload))
      return payload
    }
    return { address, request, stop }
  } }
}

const contract = (question) => ({ type: 'binary', question, object: '演示对象', timezone: 'Asia/Shanghai',
  forecastClosesAt: '2099-12-30T12:00:00Z', targetAt: '2099-12-31T12:00:00Z',
  resolutionRule: '由指定公告确认是否发生，未确认记否。', resolutionRuleVersion: 1,
  resolutionSource: { kind: 'specified', url: 'https://example.com/official' }, unresolvablePolicy: 'pending_then_manual_review', status: 'ready' })

test('M1 HTTP persists three binary questions, role/question versions, scoped inputs and reports across a process restart', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const first = await f.launch(); const request = first.request
  const config = await request('/api/v1/config')
  assert.deepEqual(config.capabilities.predictionTypes, ['binary'])
  assert.equal(config.capabilities.supervisor, false); assert.equal(config.capabilities.forecastPublishing, false)
  assert.equal((await request('/api/v1/agents')).agents.length, 10)
  assert.equal((await request('/api/v1/tools')).tools.length, 2)
  assert.match(await (await fetch(first.address)).text(), /workbench\.js/)
  assert.match(await (await fetch(`${first.address}/legacy.html`)).text(), /app\.js/)
  const topicInput = { title: '三个独立问题的测试主题', background: '虚构验收材料', sourceMode: 'provided' }
  const topic = await request('/api/v1/topics', { method: 'POST', data: topicInput, key: 'topic-key', expected: 201 })
  const predictionPath = `/api/v1/topics/${topic.topicId}/predictions`
  const a = await request(predictionPath, { method: 'POST', data: contract('事件甲是否发生？'), expected: 201 })
  const b = await request(predictionPath, { method: 'POST', data: contract('事件乙是否发生？'), expected: 201 })
  const c = await request(predictionPath, { method: 'POST', data: { type: 'binary', question: '事件丙是否发生？' }, expected: 201 })
  assert.equal(c.status, 'draft'); assert(c.validation.missingFields.includes('targetAt'))
  await request(`/api/v1/predictions/${c.predictionId}`, { method: 'PATCH', data: { expectedVersion: 1, status: 'ready' }, expected: 400 })
  for (const type of ['categorical', 'numeric', 'ranked_list']) {
    const invalid = await request(predictionPath, { method: 'POST', data: { type, question: '暂缓的类型' }, expected: 400 })
    assert.equal(invalid.error.code, 'UNSUPPORTED_PREDICTION_TYPE')
  }
  assert.equal((await request('/api/v1/predictions')).predictions.length, 3)
  const evidencePath = `/api/v1/topics/${topic.topicId}/evidence`
  const ea = await request(evidencePath, { method: 'POST', data: { title: '仅属于甲的资料', text: '甲的独有事实。', predictionIds: [a.predictionId], firstSeenAt: '1900-01-01T00:00:00Z' }, expected: 201 })
  const eb = await request(evidencePath, { method: 'POST', data: { title: '仅属于乙的资料', text: '乙的独有事实。', predictionIds: [b.predictionId] }, expected: 201 })
  assert.notEqual(ea.firstSeenAt, '1900-01-01T00:00:00Z')
  assert.deepEqual((await request(`${evidencePath}?predictionId=${a.predictionId}`)).evidence.map((item) => item.evidenceId), [ea.evidenceId])
  await request(`/api/v1/predictions/${a.predictionId}/runs`, { method: 'POST', data: { evidenceIds: [eb.evidenceId] }, expected: 409 })
  const ra = await request(`/api/v1/predictions/${a.predictionId}/runs`, { method: 'POST', data: { agentSpecId: 'official', predictionVersion: 1 }, key: 'research-a', expected: 202 })
  const rb = await request(`/api/v1/predictions/${b.predictionId}/runs`, { method: 'POST', data: { agentSpecId: 'verification' }, expected: 202 })
  for (const run of [ra, rb]) {
    let value
    for (let i = 0; i < 100; i += 1) { value = await request(`/api/v1/runs/${run.runId}`); if (value.status === 'completed') break; await delay(10) }
    assert.equal(value.status, 'completed'); assert.equal(value.report.probability, null); assert.equal(value.predictionVersion, 1)
    assert(!Object.hasOwn(value, 'checkpoint'))
  }
  const eventsA = (await request(`/api/v1/runs/${ra.runId}/events`)).events
  assert(eventsA.every((event) => event.predictionId === a.predictionId))
  assert.equal(eventsA.filter((event) => event.type === 'assignment.completed').length, 1)
  const role = await request('/api/v1/agents/official')
  const changedRole = await request('/api/v1/agents', { method: 'POST', data: { agentSpecId: 'official', expectedVersion: role.specVersion, name: '新的官方资料席' }, expected: 201 })
  assert.equal(changedRole.specVersion, 2)
  const changedQuestion = await request(`/api/v1/predictions/${a.predictionId}`, { method: 'PATCH', data: { expectedVersion: 1, question: '修改后的事件甲是否发生？' }, expected: 200 })
  assert.equal(changedQuestion.version, 2); assert.equal(changedQuestion.latestRun, null)
  assert.equal((await request(`/api/v1/runs/${ra.runId}`)).agent.specVersion, 1)
  assert.equal((await request(`/api/v1/predictions/${a.predictionId}?version=1`)).question, a.question)
  assert.equal((await request(`/api/v1/predictions/${a.predictionId}/runs`, { method: 'POST', data: { agentSpecId: 'official', predictionVersion: 1 }, key: 'research-a', expected: 202 })).runId, ra.runId)
  assert.deepEqual((await request('/api/v1/learning')).entries, [])
  await first.stop()
  const second = await f.launch()
  assert.equal((await second.request('/api/v1/predictions')).predictions.length, 3)
  assert.equal((await second.request(`/api/v1/runs/${ra.runId}`)).report.evidenceIds[0], ea.evidenceId)
  assert.equal((await second.request('/api/v1/topics', { method: 'POST', data: topicInput, key: 'topic-key', expected: 201 })).topicId, topic.topicId)
  assert.equal((await second.request('/api/v1/agents/official')).specVersion, 2)
})

test('M1 HTTP legacy import is repeatable, leaves the old case usable and separates input from learning', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const service = await f.launch(); const request = service.request
  const original = await request('/api/world')
  const imported = await request('/api/v1/imports/legacy', { method: 'POST', data: {}, expected: 201 })
  const duplicate = await request('/api/v1/imports/legacy', { method: 'POST', data: {}, expected: 201 })
  assert.equal(imported.predictions.length, 2); assert.equal(duplicate.duplicate, true)
  assert.equal(imported.topic.sourceMode, 'replay')
  assert(imported.predictions.every((item) => item.type === 'binary' && item.scoringEligible === false))
  await request(`/api/v1/predictions/${imported.predictions[0].predictionId}/runs`, { method: 'POST', data: {}, expected: 409 })
  const after = await request('/api/world')
  assert.equal(after.step, original.step); assert.deepEqual(after.learning, original.learning)
  assert.deepEqual((await request('/api/v1/learning')).entries, [])
  await request('/api/v1/topics', { method: 'POST', data: { title: '跨来源请求' }, headers: { Origin: 'https://example.com' }, expected: 403 })
})
