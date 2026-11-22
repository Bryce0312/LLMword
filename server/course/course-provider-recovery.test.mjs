import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createCourseStore } from './course-store.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createModelProvider } from '../runtime/model-provider.mjs'

const NOW = '2026-11-19T10:00:00.000Z'
async function fixture(t, { status = null, failures = Infinity, retryAfter = '0', sourceBlocked = false, harnessVersion = 3 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-provider-recovery-'))
  const path = join(folder, 'course.sqlite')
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const protocol = createCourseMockProvider()
  let modelCalls = 0; let sourceCalls = 0; let blockedStatus = status; let blockedSource = sourceBlocked
  const provider = createModelProvider({ WORLD_API_KEY: 'TEST_ONLY_NOT_A_REAL_KEY', WORLD_MODEL_NAME: 'recovery-fixture', WORLD_BASE_URL: 'https://provider.example/v1' }, async (_url, options) => {
    modelCalls++
    if (blockedStatus && modelCalls <= failures) return new Response('PRIVATE_UPSTREAM_BODY', { status: blockedStatus, headers: { 'retry-after': retryAfter } })
    const body = JSON.parse(options.body)
    const result = await protocol.complete({ messages: body.messages, tools: body.tools, signal: options.signal })
    return Response.json({ choices: [{ message: result.message, finish_reason: result.finishReason }], usage: result.usage })
  })
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const sourceTools = { capabilities: gateway.capabilities, toolsFor(options) {
    return gateway.toolsFor(options).map((tool) => ({ ...tool, async execute(args, context) {
      sourceCalls++
      if (blockedSource) return { status: 'error', data: null, evidenceIds: [], summary: 'PRIVATE_SOURCE_BODY', observedAt: NOW, usage: { providerRequests: 1 },
        error: { code: 'SOURCE_BALANCE_REQUIRED', httpStatus: 402, actionRequired: true, retryable: false, message: 'PRIVATE_SOURCE_BODY' } }
      return tool.execute(args, context)
    } }))
  } }
  const instances = []
  const open = () => {
    const service = createCourseService({ path, workbench, provider, modelMode: 'mock', sourceTools, harnessVersion, now: () => NOW })
    instances.push(service); return service
  }
  t.after(async () => { for (const service of instances) await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { path, provider, open, get modelCalls() { return modelCalls }, get sourceCalls() { return sourceCalls },
    restore() { blockedStatus = null; blockedSource = false } }
}
const question = '【协议模拟】课程科技展会在未来24小时开幕吗？'

test('402, 401 and 403 stop after one model attempt, pause automatic work and preserve safe diagnostic status', async (t) => {
  for (const [status, code] of [[402, 'MODEL_BALANCE_REQUIRED'], [401, 'MODEL_AUTH_FAILED'], [403, 'MODEL_ACCESS_DENIED']]) {
    const setup = await fixture(t, { status })
    const service = setup.open()
    const created = service.createRequest({ question, watch: true })
    await service.idle()
    const failed = service.getRequest(created.requestId)
    assert.equal(failed.run.status, 'failed')
    assert.equal(failed.run.error.code, code)
    assert.equal(failed.run.error.httpStatus, status)
    assert.equal(failed.run.error.retryable, false)
    assert.equal(failed.run.error.actionRequired, true)
    assert.equal(setup.modelCalls, 1)
    assert.equal(failed.run.usage.modelRequests, 1)
    assert.equal(failed.run.usage.unknownUsage, true)
    assert.equal(failed.predictionId, undefined)
    assert.equal(failed.forecasts.length, 0)
    assert.equal(failed.watch.status, 'paused_provider')
    assert.equal(failed.watch.nextDueAt, null)
    assert(!JSON.stringify(failed).includes('PRIVATE_UPSTREAM_BODY'))
    assert(!JSON.stringify(failed).includes('TEST_ONLY_NOT_A_REAL_KEY'))
    service.resume(); await service.idle()
    assert.equal(setup.modelCalls, 1, 'Resuming service must not silently retry a blocked account')
  }
})

test('a hard-failed preparation can recover through manual check without a prediction ID or mutation of its failure record', async (t) => {
  const setup = await fixture(t, { status: 402 })
  const service = setup.open()
  const request = service.createRequest({ question, watch: true })
  await service.idle()
  const old = structuredClone(service.getRequest(request.requestId).run)
  setup.restore()
  const queued = service.check(request.requestId)
  assert.notEqual(queued.runId, old.runId)
  assert.equal(service.getRequest(request.requestId).watch.pauseReason, null)
  await service.idle()
  const recovered = service.getRequest(request.requestId)
  assert.equal(recovered.run.status, 'completed', JSON.stringify({ error: recovered.run.error, summary: recovered.run.summary,
    delivery: recovered.run.delivery, usage: recovered.run.usage,
    assignments: recovered.run.assignments.map(item => ({ roleId: item.roleId, status: item.status, error: item.error })),
    lastEvents: recovered.run.events.slice(-8).map(item => ({ type: item.type, payload: item.payload })) }))
  assert.equal(recovered.forecasts.length, 1)
  assert.equal(recovered.watch.status, 'active')
  assert.equal(recovered.watch.pauseReason, null)
  assert.deepEqual(recovered.runs.find((run) => run.runId === old.runId), old)
})

test('legacy main retries transient failures, caps attempts at three and accounts for every transport attempt', async (t) => {
  // Persisted v2 runs retain their original retry policy. Current bounded runs
  // cannot assume that a 503 without usage was free; that policy is tested below.
  const setup = await fixture(t, { status: 503, failures: 2, harnessVersion: 2 })
  const service = setup.open()
  const request = service.createRequest({ question })
  await service.idle()
  const recovered = service.getRequest(request.requestId)
  assert.equal(recovered.run.status, 'completed', JSON.stringify(recovered.run.error))
  assert.equal(recovered.run.usage.modelRequests, setup.modelCalls)
  assert.equal(recovered.run.events.filter((event) => event.type === 'model.retrying').length, 2)
  assert.equal(recovered.run.usage.unknownUsage, true)
  const unavailable = await fixture(t, { status: 503, harnessVersion: 2 })
  const other = unavailable.open()
  const queued = other.createRequest({ question })
  await other.idle()
  const failed = other.getRequest(queued.requestId)
  assert.equal(unavailable.modelCalls, 3)
  assert.equal(failed.run.error.code, 'MODEL_SERVICE_UNAVAILABLE')
  assert.equal(failed.run.error.httpStatus, 503)
  assert.equal(failed.run.error.retryable, true)
  assert.equal(failed.forecasts.length, 0)
})

test('bounded main stops after unreported 503 usage and delivers an explicit null-probability receipt', async (t) => {
  const setup = await fixture(t, { status: 503, failures: 2 })
  const service = setup.open()
  const request = service.createRequest({ question, watch: false })
  await service.idle()
  const result = service.getRequest(request.requestId)
  assert.equal(setup.modelCalls, 1, 'A retriable HTTP status does not prove the attempted model request was unbilled')
  assert.equal(result.run.status, 'insufficient')
  assert.equal(result.run.usage.modelRequests, 1); assert.equal(result.run.usage.unknownUsage, true)
  assert.equal(result.run.assignments.length, 0); assert.equal(result.forecasts.length, 0)
  assert.equal(result.run.delivery.kind, 'partial_research'); assert.equal(result.run.delivery.probabilityYes, null)
  assert.match(result.run.delivery.reason, /用量/)
  assert.equal(result.watch.status, 'off')
  assert(result.run.events.some(event => event.type === 'budget.closeout'))
  assert(!JSON.stringify(result).includes('PRIVATE_UPSTREAM_BODY'))
})

test('cancellation interrupts Retry-After waiting and prevents the next model request', { timeout: 5000 }, async (t) => {
  const setup = await fixture(t, { status: 429, retryAfter: '30' })
  const service = setup.open()
  let retry
  const waiting = new Promise((resolve) => { retry = resolve })
  service.subscribe((event) => { if (event.type === 'model.retrying') retry() })
  const request = service.createRequest({ question })
  await waiting
  service.stop(request.requestId)
  await service.idle()
  const cancelled = service.getRequest(request.requestId)
  assert.equal(cancelled.run.status, 'cancelled')
  assert.equal(setup.modelCalls, 1)
  assert.equal(cancelled.forecasts.length, 0)
})

test('a source balance error preserves the failed tool receipt, stops new model work and pauses monitoring until manual recovery', async (t) => {
  const setup = await fixture(t, { sourceBlocked: true })
  const service = setup.open()
  const request = service.createRequest({ question, watch: true })
  await service.idle()
  const failed = service.getRequest(request.requestId)
  assert.equal(failed.run.status, 'failed')
  assert.equal(failed.run.error.code, 'SOURCE_BALANCE_REQUIRED')
  assert.equal(failed.run.error.httpStatus, 402)
  assert.equal(failed.watch.status, 'paused_provider')
  assert.equal(setup.modelCalls, 4, 'One intake decision and three independent workers start before the first source hard-failure cancels the run')
  assert.equal(setup.sourceCalls, 3, 'The first three worker requests were already in flight; no additional source request starts after the hard fault')
  assert.equal(failed.forecasts.length, 0)
  assert(failed.run.events.some((event) => event.type === 'tool.failed' && event.payload.summary.includes('余额')))
  assert(!JSON.stringify(failed).includes('PRIVATE_SOURCE_BODY'))
  setup.restore(); service.check(request.requestId); await service.idle()
  assert.equal(service.getRequest(request.requestId).run.status, 'completed')
})

test('legacy nonretryable model HTTP failures pause only their watch without rewriting the old run', async (t) => {
  const setup = await fixture(t)
  const store = createCourseStore({ path: setup.path, now: () => NOW })
  const request = store.createRequest({ question, horizonHours: 24, timezone: 'Asia/Shanghai', mode: 'preset', watch: true,
    modelMode: 'mock', sourceMode: 'replay', providerIdentity: setup.provider.configurationId })
  store.saveRun(request.activeRunId, { status: 'failed', error: { code: 'MODEL_HTTP', message: '先前保存的模型请求失败。', retryable: false } })
  store.saveWatch(request.requestId, { status: 'active', nextDueAt: NOW })
  const frozen = structuredClone(store.getRun(request.activeRunId))
  store.close()
  const service = setup.open()
  service.resume(); await service.idle()
  const blocked = service.getRequest(request.requestId)
  assert.equal(blocked.watch.status, 'paused_provider')
  assert.equal(blocked.watch.nextDueAt, null)
  assert.equal(blocked.watch.pauseReason.code, 'MODEL_HTTP')
  assert.equal(blocked.watch.pauseReason.httpStatus, undefined, 'Legacy unknown status must not be guessed as 402')
  assert.equal(setup.modelCalls, 0)
  await service.close()
  const reopened = createCourseStore({ path: setup.path, now: () => NOW })
  try { assert.deepEqual(reopened.getRun(frozen.runId), frozen) } finally { reopened.close() }
})
