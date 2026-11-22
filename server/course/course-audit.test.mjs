import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createCourseStore } from './course-store.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { handleCourseApi } from '../course-http.mjs'

// Cross-review tests: this author did not implement course-store, service or
// HTTP routing. Network tools are deliberately outside this independent scope.
const initialTime = '2026-11-19T06:00:00.000Z'
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-course-audit-'))
  let at = initialTime
  const path = join(folder, 'course.sqlite')
  let store = createCourseStore({ path, now: () => at })
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }) })
  return { get store() { return store }, setTime(value) { at = value },
    reopen() { store.close(); store = createCourseStore({ path, now: () => at }); return store },
  }
}
function request(store, name, modes = {}) {
  return store.createRequest({ question: name, modelMode: 'live', sourceMode: 'live', providerIdentity: 'audit-model', ...modes })
}
function prepared(store, name = 'primary', modes) {
  const created = request(store, name, modes)
  const runId = created.activeRunId
  const run = store.saveRun(runId, { status: 'running', topicId: `topic_${name}`, predictionId: `prediction_${name}`, predictionVersion: 1 })
  const prediction = { predictionId: run.predictionId, version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    forecastClosesAt: '2026-11-21T05:00:00.000Z', targetAt: '2026-11-21T06:00:00.000Z',
    resolutionRuleVersion: 1, resolutionSource: { url: `https://company.example.com/${name}/official` } }
  const a = { assignmentId: `assignment_${name}_official`, agentSpecId: 'official', followUp: false, objective: 'Find original evidence' }
  const b = { assignmentId: `assignment_${name}_timeline`, agentSpecId: 'timeline', followUp: false, objective: 'Find independent time evidence' }
  for (const assignment of [a, b]) {
    store.createAssignment(runId, assignment)
    store.saveAssignment(assignment.assignmentId, { status: 'completed', report: { status: 'complete', summary: 'Referenced report' } })
  }
  const e1 = { evidenceId: `evidence_${name}_official`, topicId: run.topicId, predictionId: run.predictionId,
    title: 'Original announcement', text: 'A bounded audit material, not a real forecast.', url: prediction.resolutionSource.url,
    contentHash: `hash_${name}_official`, sourceMode: modes?.sourceMode || 'live', publishedAt: '2026-11-19T05:00:00.000Z', ...(modes?.fixture ? { fixture: true } : {}) }
  const e2 = { ...e1, evidenceId: `evidence_${name}_news`, url: `https://news.example.com/${name}`, contentHash: `hash_${name}_news` }
  store.recordEvidence(runId, e1, a.assignmentId)
  store.recordEvidence(runId, e2, b.assignmentId)
  const candidate = { probabilityYes: 0.35, summary: 'An auditable probability based on the cited materials.', evidenceIds: [e1.evidenceId, e2.evidenceId] }
  return { requestId: created.requestId, runId, run, prediction, assignments: [a, b], evidence: [e1, e2], candidate }
}

async function http(course, { path = '/requests', method = 'POST', input = {}, raw, headers = {} } = {}) {
  const req = Readable.from([Buffer.from(raw ?? JSON.stringify(input))])
  req.url = `/api/v1/course${path}`; req.method = method; req.headers = headers
  let status; let payload
  const res = { writeHead(code) { status = code; return this }, end(value) { payload = JSON.parse(value) } }
  const handled = await handleCourseApi(course, req, res)
  return { status, payload, handled }
}

async function serviceFixture(t, { provider = createCourseMockProvider() } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-course-service-audit-'))
  let at = initialTime; let revision = 1
  const pages = () => [
    { url: 'https://example.com/course-lab/official', title: '虚构官方材料', text: `【虚构课程样例】筹备状态，版本${revision}。不是真实新闻。` },
    { url: 'https://example.com/course-lab/news', title: '虚构新闻材料', text: `【虚构课程样例】转述待核验，版本${revision}。不是真实新闻。` },
    { url: 'https://example.com/course-lab/verification', title: '虚构反证材料', text: `【虚构课程样例】缺少完成证明，版本${revision}。不是真实新闻。` },
  ]
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => at })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => at, fixturePages: pages })
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, provider, modelMode: 'mock', sourceTools, now: () => at, watchIntervalMs: 3600000 })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { service, workbench, setTime(value) { at = value }, change() { revision++ } }
}
function assertPublicOnly(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert(!['messages', 'checkpoint', 'state', 'providerIdentity', 'Authorization', 'apiKey'].includes(key), `Private property exposed: ${key}`)
    assertPublicOnly(nested)
  }
}

test('independent course HTTP review hides low-level coded errors and accepts only bounded JSON actions', async () => {
  const sentinel = 'private-credential-and-database-path-sentinel'
  const broken = { createRequest() { throw Object.assign(new Error(sentinel), { code: 'SQLITE_ERROR' }) } }
  const low = await http(broken)
  assert.equal(low.status, 500)
  assert.equal(low.payload.error.code, 'COURSE_ERROR')
  assert(!JSON.stringify(low).includes(sentinel))
  const controlled = { createRequest() { throw Object.assign(new Error('问题无效。'), { code: 'QUESTION_INVALID', status: 400 }) } }
  assert.equal((await http(controlled)).payload.error.message, '问题无效。')
  const disabled = await http(null)
  assert.equal(disabled.status, 503); assert.equal(disabled.payload.error.code, 'COURSE_DISABLED')
  const never = { createRequest() { assert.fail('Malformed body must not invoke service') }, check() { assert.fail('Action body must be empty') } }
  for (const raw of ['[]', 'null', '123', '{malformed']) assert.equal((await http(never, { raw })).status, 400)
  assert.equal((await http(never, { raw: JSON.stringify({ question: 'x'.repeat(17000) }) })).status, 413)
  assert.equal((await http(never, { path: '/requests/request_1/check', input: { allowedTools: ['unsafe'] } })).status, 400)
  assert.equal((await http(never, { method: 'GET', path: '/events?afterSeq=9007199254740992' })).status, 400)
})

test('independent course SQLite review keeps request retries durable and one active run per question', async (t) => {
  const fx = await fixture(t)
  const input = { question: 'A uniquely named audit event?', modelMode: 'live', sourceMode: 'live', providerIdentity: 'audit-model' }
  const first = fx.store.createRequest(input, { idempotencyKey: 'audit-create-once' })
  const queued = fx.store.queueRun(first.requestId, 'watch')
  assert.equal(queued.runId, first.activeRunId)
  assert.equal(fx.store.listRuns({ requestId: first.requestId }).length, 1)
  fx.reopen()
  assert.equal(fx.store.createRequest(input, { idempotencyKey: 'audit-create-once' }).requestId, first.requestId)
  assert.throws(() => fx.store.createRequest({ ...input, question: 'A different event?' }, { idempotencyKey: 'audit-create-once' }), { code: 'IDEMPOTENCY_CONFLICT' })
})

test('independent course assignment review rejects a saved assignment ID crossing run boundaries', async (t) => {
  const fx = await fixture(t)
  const a = request(fx.store, 'request_a'); const b = request(fx.store, 'request_b')
  const assignment = { assignmentId: 'shared_assignment_id', agentSpecId: 'official', objective: 'Only question A' }
  fx.store.createAssignment(a.activeRunId, assignment)
  assert.throws(() => fx.store.createAssignment(b.activeRunId, { ...assignment, objective: 'Question B' }))
  assert.equal(fx.store.listAssignments(b.activeRunId).length, 0)
  assert.equal(fx.store.listAssignments(a.activeRunId).length, 1)
})

test('independent course budget review records already consumed tokens when the budget is exceeded', async (t) => {
  const fx = await fixture(t); const created = request(fx.store, 'budget')
  fx.store.recordUsage(created.activeRunId, 119999)
  assert.throws(() => fx.store.recordUsage(created.activeRunId, 2), { code: 'COURSE_BUDGET' })
  assert.equal(fx.store.getRun(created.activeRunId).usage.totalTokens, 120001)
})

test('independent course usage review keeps input, output and cache counters separate', async (t) => {
  const fx = await fixture(t); const created = request(fx.store, 'usage_split')
  fx.store.recordUsage(created.activeRunId, 300, { total_tokens: 300, prompt_tokens: 240, completion_tokens: 60, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 40 })
  fx.store.recordUsage(created.activeRunId, 120, { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 })
  fx.store.recordUsage(created.activeRunId, undefined)
  const usage = fx.store.getRun(created.activeRunId).usage
  assert.deepEqual({ total: usage.totalTokens, prompt: usage.promptTokens, completion: usage.completionTokens, hit: usage.cacheHitTokens, miss: usage.cacheMissTokens, unknown: usage.unknownUsage },
    { total: 420, prompt: 340, completion: 80, hit: 200, miss: 40, unknown: true })
})

test('independent course publisher review rejects invalid values, stale versions, foreign citations and late publication atomically', async (t) => {
  const fx = await fixture(t); const a = prepared(fx.store, 'publication_a'); const b = prepared(fx.store, 'publication_b')
  for (const probabilityYes of [NaN, Infinity]) assert.throws(() => fx.store.publishForecast(a.runId, { ...a.candidate, probabilityYes }, a.prediction), (error) => ['INVALID_FORECAST', 'INVALID_JSON_VALUE'].includes(error.code))
  for (const probabilityYes of [-0.1, 1.1]) assert.throws(() => fx.store.publishForecast(a.runId, { ...a.candidate, probabilityYes }, a.prediction), { code: 'INVALID_FORECAST' })
  assert.throws(() => fx.store.publishForecast(a.runId, a.candidate, { ...a.prediction, version: 2 }), { code: 'FORECAST_VERSION' })
  assert.throws(() => fx.store.publishForecast(a.runId, { ...a.candidate, evidenceIds: b.candidate.evidenceIds }, a.prediction), { code: 'FORECAST_EVIDENCE' })
  assert.equal(fx.store.listForecasts().length, 0)
  fx.setTime(a.prediction.forecastClosesAt)
  assert.throws(() => fx.store.publishForecast(a.runId, a.candidate, a.prediction), { code: 'FORECAST_CLOSED' })
  assert.equal(fx.store.listEvents({ runId: a.runId }).filter((event) => event.type === 'forecast.published').length, 0)
})

test('independent course publication retries retain one immutable forecast and event after restart', async (t) => {
  const fx = await fixture(t); const a = prepared(fx.store, 'retry')
  const first = fx.store.publishForecast(a.runId, a.candidate, a.prediction)
  assert.equal(first.probabilityNo, 0.65)
  assert.equal(first.scoringEligible, true)
  fx.store.saveRun(a.runId, { status: 'completed' })
  fx.setTime('2026-11-22T06:00:00.000Z')
  fx.reopen()
  assert.equal(fx.store.publishForecast(a.runId, a.candidate, a.prediction).forecastId, first.forecastId)
  assert.throws(() => fx.store.publishForecast(a.runId, { ...a.candidate, probabilityYes: 0.9 }, a.prediction), { code: 'FORECAST_CONFLICT' })
  assert.equal(fx.store.listForecasts().length, 1)
  assert.equal(fx.store.listEvents({ runId: a.runId }).filter((event) => event.type === 'forecast.published').length, 1)
  assert.equal(fx.store.listForecasts()[0].issuedAt, initialTime)
})

test('independent course result and cancellation review stop new publication and late mutations', async (t) => {
  const fx = await fixture(t); const a = prepared(fx.store, 'known_result')
  fx.store.recordResult(a.requestId, { outcome: 1, evidenceIds: [a.evidence[0].evidenceId] })
  assert.throws(() => fx.store.publishForecast(a.runId, a.candidate, a.prediction), { code: 'RESULT_KNOWN' })
  const b = prepared(fx.store, 'stopped')
  fx.store.saveWatch(b.requestId, { status: 'watching', nextDueAt: '2026-11-19T07:00:00.000Z' })
  fx.store.stop(b.requestId)
  assert.equal(fx.store.getRun(b.runId).status, 'cancelled')
  assert.equal(fx.store.getWatch(b.requestId).status, 'stopped')
  assert.equal(fx.store.getWatch(b.requestId).nextDueAt, null)
  assert.throws(() => fx.store.queueRun(b.requestId), { code: 'REQUEST_STOPPED' })
  assert.throws(() => fx.store.publishForecast(b.runId, b.candidate, b.prediction), { code: 'COURSE_CANCELLED' })
  assert.throws(() => fx.store.recordEvidence(b.runId, b.evidence[0], b.assignments[0].assignmentId), { code: 'COURSE_CANCELLED' })
})

test('independent course source-mode review never scores fixture evidence as a live prediction', async (t) => {
  const fx = await fixture(t)
  for (const [name, modes] of [['all_mock', { modelMode: 'mock', sourceMode: 'replay', fixture: true }], ['live_model_fixture', { modelMode: 'live', sourceMode: 'replay', fixture: true }]]) {
    const a = prepared(fx.store, name, modes)
    const forecast = fx.store.publishForecast(a.runId, a.candidate, a.prediction)
    assert.equal(forecast.scoringEligible, false)
    assert.equal(forecast.modelMode, modes.modelMode); assert.equal(forecast.sourceMode, 'replay')
  }
})

test('independent course service review executes all three roles and preserves an honest public report without private model state', async (t) => {
  const { service } = await serviceFixture(t)
  const created = service.createRequest({ question: '【演示】虚构城市科技展是否会在两天后正式开幕？', mode: 'preset', horizonHours: 48 })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  for (const role of ['official', 'timeline', 'verification']) {
    const assignment = done.run.assignments.find((item) => item.roleId === role && !item.followUp)
    assert(assignment, `Missing role ${role}`)
    assert.equal(assignment.report?.status, 'complete', role)
    assert(assignment.report.evidenceIds.length, role)
  }
  assert(done.run.assignments.some((item) => item.followUp), 'Protocol fixture explicitly demonstrates one follow-up')
  assertPublicOnly(done); assertPublicOnly(service.listRequests()); assertPublicOnly(service.listEvents({})); assertPublicOnly(service.capabilities)
  assert.equal(done.forecast.scoringEligible, false)
  assert.equal(done.forecast.modelMode, 'mock'); assert.equal(done.forecast.sourceMode, 'replay')
  assert(done.relations.length > 0)
})

test('independent course service watch review does not republish duplicates, adds one point for changed text and stops at target', async (t) => {
  const fx = await serviceFixture(t)
  const created = fx.service.createRequest({ question: '【演示】虚构展览未来两天是否开幕？', horizonHours: 48, watch: true })
  await fx.service.idle()
  const first = fx.service.getRequest(created.requestId)
  assert.equal(first.run.status, 'completed', JSON.stringify(first.run.error))
  assert.equal(first.forecasts.length, 1)
  fx.service.check(created.requestId); await fx.service.idle()
  const unchanged = fx.service.getRequest(created.requestId)
  assert.equal(unchanged.forecasts.length, 1)
  assert.equal(unchanged.run.assignments.length, 0, 'No unchanged-message worker meeting')
  fx.change(); fx.setTime('2026-11-19T07:00:00.000Z')
  fx.service.check(created.requestId); await fx.service.idle()
  const changed = fx.service.getRequest(created.requestId)
  assert.equal(changed.forecasts.length, 2, JSON.stringify(changed.run.error))
  assert.equal(changed.forecasts[0].forecastId, first.forecast.forecastId)
  assert.equal(changed.forecasts[0].issuedAt, initialTime)
  assert.equal(changed.forecast.issuedAt, '2026-11-19T07:00:00.000Z')
  assert.equal(changed.forecast.targetAt, first.forecast.targetAt)
  fx.setTime(changed.normalized.forecastClosesAt)
  fx.service.check(created.requestId); await fx.service.idle()
  const expired = fx.service.getRequest(created.requestId)
  assert.equal(expired.forecasts.length, 2)
  assert.equal(expired.watch.status, 'completed')
  assert.equal(expired.watch.nextDueAt, null)
})

test('independent course service errors never expose coded provider secrets through public state or events', async (t) => {
  const sentinel = 'course-provider-secret-sentinel'
  const provider = { model: 'audit-failing-provider', configurationId: 'audit-failing-provider', async complete() { throw Object.assign(new Error(sentinel), { code: 'SQLITE_ERROR' }) } }
  const { service } = await serviceFixture(t, { provider })
  const created = service.createRequest({ question: '【演示】不可用模型的失败检查？' })
  await service.idle()
  const result = service.getRequest(created.requestId)
  assert.equal(result.run.status, 'failed')
  assert(!JSON.stringify(result).includes(sentinel))
  assert(!JSON.stringify(service.listEvents({})).includes(sentinel))
  assertPublicOnly(result)
})

test('independent course request boundary rejects manual evidence and capability injection before queuing', async (t) => {
  const { service } = await serviceFixture(t)
  for (const input of [
    { question: 'test', evidence: [{ text: 'untrusted manual body' }] },
    { question: 'test', allowedTools: ['execute_shell'] },
    { question: 'test', modelMode: 'live' },
    { question: 'test', sourceMode: 'live' },
  ]) assert.throws(() => service.createRequest(input))
  assert.equal(service.listRequests().length, 0)
})

test('independent course strict-mode review keeps the supplied time, rule and verified source instead of substituting preset rules', async (t) => {
  const { service } = await serviceFixture(t)
  const strict = { targetAt: '2026-11-20T12:00:00.000Z', timezone: 'Asia/Shanghai',
    resolutionRule: '【虚构验收口径】只有指定来源在目标时刻明确确认才记为是；来源不足保持待核验。',
    resolutionSourceUrl: 'https://example.com/course-lab/official' }
  const created = service.createRequest({ question: '【演示】虚构科技展是否按严格规则确认开幕？', mode: 'strict', strict })
  await service.idle()
  const result = service.getRequest(created.requestId)
  assert.equal(result.run.status, 'completed', JSON.stringify(result.run.error))
  assert.equal(result.normalized.targetAt, strict.targetAt)
  assert.equal(result.normalized.resolutionRule, strict.resolutionRule)
  assert.equal(result.normalized.resolutionSource.url, strict.resolutionSourceUrl)
  assert.equal(result.normalized.timezone, strict.timezone)
  assert.equal(result.forecast.targetAt, strict.targetAt)
})
