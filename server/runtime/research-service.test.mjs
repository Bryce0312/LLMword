import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStore } from '../core/store.mjs'
import { createResearchService } from './research-service.mjs'
import { createProbeProvider } from './probe-provider.mjs'
import { createProjectionState, selectRun, projectEvent } from '../../web/run-projection.mjs'

const input = (suffix = 'one', text = '样例原文，尚未确认正式任命。') => ({
  topicId: `topic_${suffix}`, predictionId: `prediction_${suffix}`,
  objective: '核实提供的公告说明了什么，不推测未提供的事实。',
  evidence: [{ evidenceId: 'document', title: `公告 ${suffix}`, text }],
})

async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-service-'))
  const services = []
  const path = join(folder, 'runtime.sqlite')
  t.after(async () => { for (const service of services) await service.close(); await rm(folder, { recursive: true, force: true }) })
  return { path, open(options = {}) { const service = createResearchService({ path, ...options }); services.push(service); return service } }
}

test('one probe executes two real handlers, persists proof before projecting one completion and keeps private messages private', async (t) => {
  const fixture = await setup(t)
  const scripted = createProbeProvider()
  const requests = []
  const provider = { model: scripted.model, async complete(request) {
    requests.push(structuredClone(request.messages))
    const response = await scripted.complete(request)
    response.message.reasoning_content = 'PRIVATE PROTOCOL DETAIL'
    return response
  } }
  const service = fixture.open({ provider })
  const events = []; const effects = []
  let projection = createProjectionState()
  service.subscribe((event) => {
    events.push(event)
    if (event.type === 'assignment.completed') assert(service.getRun(event.runId).report, 'Report must be committed before a completion event')
    const next = projectEvent(projection, event); projection = next.state; effects.push(...next.effects)
  })
  const created = service.createProbe(input(), { idempotencyKey: 'request-one' })
  projection = selectRun(projection, created.runId).state
  assert.equal(service.createProbe(input(), { idempotencyKey: 'request-one' }).runId, created.runId)
  await service.idle()
  const run = service.getRun(created.runId)
  assert.equal(run.status, 'completed')
  assert.equal(run.modelMode, 'mock')
  assert.equal(run.report.probability, null)
  assert.deepEqual(run.report.evidenceIds, ['document'])
  assert.deepEqual(events.filter((event) => event.type === 'tool.completed').map((event) => event.payload.toolId),
    ['list_provided_sources', 'read_evidence', 'submit_report'])
  assert.equal(events.filter((event) => event.type === 'assignment.completed').length, 1)
  assert.equal(effects.filter((effect) => effect.type === 'bubble').length, 1)
  assert.equal(requests[1].find((message) => message.role === 'assistant').tool_calls[0].id, 'probe_list')
  assert.equal(JSON.parse(requests[2].at(-1).content).data.text, input().evidence[0].text)
  assert(!JSON.stringify({ run, events, snapshot: service.snapshot() }).includes('PRIVATE PROTOCOL DETAIL'))
  assert(!Object.hasOwn(run, 'checkpoint'))
  const store = createStore({ path: fixture.path })
  try {
    assert.equal(store.getToolReceipt(run.runId, 'probe_read').result.data.text, input().evidence[0].text)
    assert(store.getRun(run.runId).checkpoint.worker.messages.some((message) => message.reasoning_content))
  } finally { store.close() }
})

test('cancellation stops a provider that ignores AbortSignal from publishing any late report', async (t) => {
  const fixture = await setup(t)
  let entered; let release
  const called = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const scripted = createProbeProvider()
  const provider = { model: scripted.model, async complete(request) { entered(); await held; return scripted.complete(request) } }
  const service = fixture.open({ provider })
  const run = service.createProbe(input('cancel'))
  await called
  assert.equal(service.cancelRun(run.runId).status, 'cancelled')
  release()
  await service.idle()
  assert.equal(service.getRun(run.runId).report, null)
  assert.equal(service.getRun(run.runId).status, 'cancelled')
  assert(!service.listEvents({ runId: run.runId }).some((event) => ['assignment.completed', 'run.finished'].includes(event.type)))
})

test('a paused process reopens the same private checkpoint without repeating the completed tool event', async (t) => {
  const fixture = await setup(t)
  const scripted = createProbeProvider()
  let held; const waiting = new Promise((resolve) => { held = resolve })
  const first = fixture.open({ provider: { model: scripted.model, async complete(request) {
    if (request.messages.some((message) => message.role === 'tool')) { held(); return new Promise(() => {}) }
    return scripted.complete(request)
  } } })
  const created = first.createProbe(input('restart'))
  await waiting
  await first.close()
  const second = fixture.open({ provider: createProbeProvider() })
  second.resume(); await second.idle()
  assert.equal(second.getRun(created.runId).status, 'completed')
  const events = second.listEvents({ runId: created.runId })
  assert.equal(events.filter((event) => event.type === 'tool.completed' && event.payload.toolId === 'list_provided_sources').length, 1)
  assert.equal(events.filter((event) => event.type === 'assignment.completed').length, 1)
  assert.equal(events.filter((event) => event.type === 'run.started').length, 2)
})

test('three concurrent predictions keep same-named evidence and tool calls in their own run', async (t) => {
  const fixture = await setup(t)
  const service = fixture.open()
  const runs = ['alpha', 'beta', 'gamma'].map((name) => service.createProbe(input(name, `${name} 独有资料`)))
  await service.idle()
  for (let i = 0; i < runs.length; i += 1) {
    const value = service.getRun(runs[i].runId)
    const own = ['alpha', 'beta', 'gamma'][i]
    assert.equal(value.status, 'completed')
    assert(value.report.summary.includes(`${own} 独有资料`))
    for (const event of service.listEvents({ runId: value.runId })) {
      assert.equal(event.predictionId, `prediction_${own}`)
      assert.equal(event.topicId, `topic_${own}`)
    }
  }
})

test('one prediction has one active probe and conflicting create retries cannot replace it', async (t) => {
  const fixture = await setup(t)
  const service = fixture.open({ provider: { model: 'held', complete: () => new Promise(() => {}) } })
  const run = service.createProbe(input(), { idempotencyKey: 'same-key' })
  assert.throws(() => service.createProbe(input('one', '不同材料'), { idempotencyKey: 'same-key' }), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.throws(() => service.createProbe(input(), { idempotencyKey: 'other-key' }), { code: 'PREDICTION_BUSY' })
  service.cancelRun(run.runId)
  await service.idle()
})

test('input contracts reject missing evidence, duplicate IDs and unsupported source URL schemes', async (t) => {
  const fixture = await setup(t); const service = fixture.open()
  assert.throws(() => service.createProbe({ objective: 'x', evidence: [] }), { code: 'INVALID_PROBE' })
  const duplicate = input(); duplicate.evidence.push({ ...duplicate.evidence[0] })
  assert.throws(() => service.createProbe(duplicate), { code: 'DUPLICATE_EVIDENCE' })
  const source = input(); source.evidence[0].url = 'file:///private-data'
  assert.throws(() => service.createProbe(source), { code: 'INVALID_SOURCE_URL' })
  assert.equal(service.listRuns().length, 0)
})
