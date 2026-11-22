import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseStore } from './course-store.mjs'
import { createCourseService } from './course-service.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { WARNING_URL, WARNING_POLICY, WARNING_RULE } from './weather-warning.mjs'
import { PRICE_URL, PRICE_RULE } from './market-resolution.mjs'
import { groundingPolicy } from '../domain/claim-grounding.mjs'
import { DEFAULT_PREDICTION_BUDGET, validatePredictionSettings, totalTokenLimit, remainingTotalTokens, boundedOutputTokens } from './prediction-budget.mjs'

const NOW = '2026-11-22T00:00:00.000Z'
const TARGET = '2026-11-22T01:00:00.000Z'
const limited = (maxTotalTokens) => ({ predictionBudget: { mode: 'limited', maxTotalTokens } })
const unlimited = { predictionBudget: { mode: 'unlimited', maxTotalTokens: null } }

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-prediction-budget-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const services = []
  t.after(async () => { for (const service of services) await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { folder, open(provider = createCourseMockProvider(), extra = {}) {
    const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools, provider, now: () => NOW, ...extra })
    services.push(service); return service
  } }
}
function rawRequest(store, maxTotalTokens, extra = {}) {
  const request = store.createRequest({ purpose: 'forecast', question: 'Fixture prediction', modelMode: 'mock', sourceMode: 'replay', providerIdentity: 'fixture',
    budget: { maxTotalTokens, maxTokens: 1024, maxModelRequests: 3, maxToolCalls: 2 }, ...extra })
  return { request, run: store.requireRun(request.activeRunId) }
}

test('prediction settings validate positive safe integers and explicit unlimited without other fields', () => {
  assert.deepEqual(DEFAULT_PREDICTION_BUDGET, { mode: 'limited', maxTotalTokens: 1000000 })
  for (const value of [1, 100000, 300000, 500000, 1000000]) assert.deepEqual(validatePredictionSettings(limited(value)), limited(value))
  assert.deepEqual(validatePredictionSettings(unlimited), unlimited)
  assert.deepEqual(validatePredictionSettings({ predictionBudget: { mode: 'unlimited' } }), unlimited)
  for (const input of [null, [], {}, { predictionBudget: null }, { predictionBudget: { mode: 'unknown' } },
    ...[0, -1, 0.5, '100000', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(value => limited(value)),
    { predictionBudget: { mode: 'unlimited', maxTotalTokens: 10 } }, { predictionBudget: { mode: 'limited', maxTotalTokens: 10, worker: null } },
    { ...limited(10), apiKey: 'must-not-be-stored' }]) assert.throws(() => validatePredictionSettings(input), { code: 'INVALID_PREDICTION_BUDGET', status: 400 })
  assert.equal(totalTokenLimit({}), 120000, 'legacy missing limits retain their fallback')
  assert.equal(totalTokenLimit({ maxTotalTokens: null }), null)
  assert.equal(remainingTotalTokens({ maxTotalTokens: null }, 2000000), null)
  assert.equal(boundedOutputTokens({ maxTotalTokens: null, maxTokens: 4096 }, 2000000), 4096)
  assert.equal(boundedOutputTokens({ maxTotalTokens: 1000, maxTokens: 4096 }, 900), 100)
})

test('store persists settings while preserving prior request/run snapshots and idempotent replay', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-budget-store-'))
  const path = join(folder, 'course.sqlite')
  let store = createCourseStore({ path, now: () => NOW })
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }) })
  assert.deepEqual(store.getSettings(), limited(1000000))
  const old = rawRequest(store, 300000)
  const original = store.requireRun(old.run.runId)
  store.updateSettings(unlimited)
  assert.deepEqual(store.requireRun(old.run.runId), original)
  assert.equal(store.requireRequest(old.request.requestId).budget.maxTotalTokens, 300000)
  for (const input of [limited(0), { ...unlimited, apiKey: 'private' }]) assert.throws(() => store.updateSettings(input), { code: 'INVALID_PREDICTION_BUDGET' })
  assert.deepEqual(store.getSettings(), unlimited)
  store.saveRun(old.run.runId, { status: 'completed' })
  const checked = store.queueRun(old.request.requestId, 'watch', { budget: { maxTotalTokens: null } })
  assert.equal(checked.budget.maxTotalTokens, 300000, 'new checks use the existing request snapshot')
  store.close()
  store = createCourseStore({ path, now: () => NOW })
  assert.deepEqual(store.getSettings(), unlimited)
  assert.equal(store.requireRun(checked.runId).budget.maxTotalTokens, 300000)
  assert(!JSON.stringify(store.getSettings()).includes('private'))
})

test('finite total token limits are enforced and unlimited retains request/tool count limits', () => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  try {
    const finite = rawRequest(store, 3).run
    store.recordUsage(finite.runId, 3)
    assert.throws(() => store.reserve(finite.runId, 'modelRequests', 3), { code: 'COURSE_BUDGET' })
    assert.throws(() => store.recordUsage(finite.runId, 1), { code: 'COURSE_BUDGET' })
    assert.equal(store.requireRun(finite.runId).usage.totalTokens, 4, 'actual consumed usage remains recorded')
    const infinite = rawRequest(store, null).run
    store.recordUsage(infinite.runId, 4000000)
    assert.equal(store.requireRun(infinite.runId).budget.maxTotalTokens, null)
    for (let i = 0; i < 3; i++) store.reserve(infinite.runId, 'modelRequests', 3)
    assert.throws(() => store.reserve(infinite.runId, 'modelRequests', 3), { code: 'COURSE_BUDGET' })
    store.reserve(infinite.runId, 'toolCalls', 1)
    assert.throws(() => store.reserve(infinite.runId, 'toolCalls', 1), { code: 'COURSE_BUDGET' })
  } finally { store.close() }
})

test('forecast setting snapshots include strict price/warning while research retains its own budget and service replacement keeps settings', async t => {
  const fixtureValue = await fixture(t)
  let service = fixtureValue.open()
  const capture = (input, options) => { const request = service.createRequest(input, options); service.stop(request.requestId); return request }
  const initial = capture({ question: '默认预算问题' }, { idempotencyKey: 'budget-replay' })
  assert.equal(initial.budget.maxTotalTokens, 1000000)
  service.updateSettings(limited(500000))
  const replayed = capture({ question: '默认预算问题' }, { idempotencyKey: 'budget-replay' })
  assert.equal(replayed.requestId, initial.requestId)
  assert.equal(replayed.budget.maxTotalTokens, 1000000)
  const price = capture({ question: '比特币BTC价格会高于本轮固定基准吗？', mode: 'strict', strict: { targetAt: TARGET, resolutionSourceUrl: PRICE_URL, resolutionRule: PRICE_RULE } })
  assert.equal(price.budget.maxTotalTokens, 500000)
  assert.equal(price.budget.worker.maxTotalTokens, 80000)
  assert.equal(price.budget.maxToolCalls, 12)
  service.updateSettings(unlimited)
  const warning = capture({ question: '香港天文台红色火灾危险警告会持续吗？', mode: 'strict', strict: { targetAt: TARGET, resolutionSourceUrl: WARNING_URL, resolutionRule: WARNING_RULE } })
  assert.equal(warning.budget.maxTotalTokens, null)
  assert.equal(warning.budget.worker.maxTotalTokens, 18000)
  assert.equal(warning.budget.maxModelRequests, 18)
  const research = capture({ question: '财报研报资料核验', purpose: 'research' })
  assert.equal(research.budget.maxTotalTokens, 160000)
  assert.equal(research.budget.worker.maxTotalTokens, 40000)
  assert.equal(service.getRun(initial.run.runId).budget.maxTotalTokens, 1000000)
  await service.close()
  service = fixtureValue.open()
  assert.deepEqual(service.getSettings(), unlimited)
  assert.equal(service.capabilities.limits.totalTokensPerRun, null)
  const next = capture({ question: '连接替换后新预测' })
  assert.equal(next.budget.maxTotalTokens, null)
  assert.equal(next.budget.worker.maxTotalTokens, 65536)
})

test('unlimited supervisor can complete beyond the historical total cap without NaN outputs or losing worker limits', async t => {
  const fixtureValue = await fixture(t)
  const protocol = createCourseMockProvider()
  const sent = []
  const provider = { ...protocol, async complete(input) {
    sent.push({ maxTokens: input.maxTokens, system: input.messages[0].content })
    const response = await protocol.complete(input)
    let context = {}; try { context = JSON.parse(input.messages.find(message => message.role === 'user')?.content || '{}') } catch {}
    if (context.kind === 'course-main') response.usage = { total_tokens: 1100000 }
    return response
  } }
  const service = fixtureValue.open(provider)
  service.updateSettings(unlimited)
  const request = service.createRequest({ question: '【模拟】虚构科技展未来48小时会正式开幕吗？', watch: false })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(done.forecasts.length, 1)
  assert(done.run.usage.totalTokens > 1000000)
  assert.equal(done.run.budget.maxTotalTokens, null)
  assert(done.run.assignments.every(assignment => Number.isFinite(assignment.budget.maxTotalTokens)))
  assert(sent.every(input => Number.isInteger(input.maxTokens) && input.maxTokens > 0 && input.maxTokens <= 4800))
  assert(sent.some(input => input.system.includes('总 token 不设上限')))
  assert(!sent.some(input => /NaN|Infinity|null tokens/u.test(input.system)))
  assert(!JSON.stringify(done).includes('NaN'))
  service.updateSettings(limited(100000))
  const finite = service.createRequest({ question: '【模拟】另一个虚构科技展48小时会开幕吗？', watch: false })
  await service.idle()
  assert.equal(service.getRequest(finite.requestId).run.error.code, 'COURSE_BUDGET')
  assert.equal(service.getRequest(finite.requestId).forecasts.length, 0)
})

test('unlimited fixed-rule summary recovery is not rejected by the old fallback total cap', () => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  try {
    const { request, run } = rawRequest(store, null, { resolutionPolicy: { version: WARNING_POLICY }, normalized: { forecastClosesAt: TARGET } })
    store.updateRequest(request.requestId, { normalized: { forecastClosesAt: TARGET } })
    for (const role of ['official', 'verification']) {
      const assignmentId = `resume_${role}`
      store.createAssignment(run.runId, { assignmentId, roleId: role })
      store.saveAssignment(assignmentId, { status: 'completed', report: { evidenceIds: ['fixture-evidence'] } })
    }
    store.recordUsage(run.runId, 1500000)
    store.saveRun(run.runId, { phase: 'review', status: 'failed', error: { code: 'MODEL_INCOMPLETE' }, state: { main: { calls: 2, messages: [] } } })
    const resumed = store.resumeResearchSummary(run.runId, { maxTokens: 6000 })
    assert.equal(resumed.budget.maxTotalTokens, null)
    assert.equal(resumed.status, 'queued')
    assert.equal(resumed.budget.maxTokens, 6000)
  } finally { store.close() }
})

test('fixed-rule preflight enforces a finite global budget but bypasses only that cap in unlimited mode', async t => {
  const fixtureValue = await fixture(t), protocol = createCourseMockProvider()
  let calls = 0
  const provider = { ...protocol, async complete(input) {
    calls++
    const response = await protocol.complete(input)
    let context = {}; try { context = JSON.parse(input.messages.find(message => message.role === 'user')?.content || '{}') } catch {}
    if (context.kind === 'course-main') response.usage = { total_tokens: 1100000 }
    return response
  } }
  const service = fixtureValue.open(provider, { evidencePolicy: groundingPolicy })
  const input = { question: '香港天文台红色火灾危险警告会持续吗？', mode: 'strict', strict: { targetAt: TARGET, resolutionSourceUrl: WARNING_URL, resolutionRule: WARNING_RULE } }
  service.updateSettings(limited(1))
  const rejected = service.createRequest(input)
  await service.idle()
  assert.equal(service.getRequest(rejected.requestId).run.error.code, 'COURSE_BUDGET')
  assert.equal(calls, 0, 'bounded preflight rejects before sending a paid model request')
  service.updateSettings(unlimited)
  const created = service.createRequest(input)
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert(done.forecast)
  assert(done.run.usage.totalTokens > 1000000)
  assert.equal(done.run.budget.maxTotalTokens, null)
  assert(done.run.assignments.every(item => item.budget.maxTotalTokens === 18000))
})
