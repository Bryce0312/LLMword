import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { createDomainStore } from './domain-store.mjs'
import { createResearchService } from '../runtime/research-service.mjs'
import { createWorkbenchService } from './workbench-service.mjs'
import { handleApi } from '../http.mjs'

const REGISTERED = ['list_provided_sources', 'read_evidence']
const completeQuestion = (predictionId, patch = {}) => ({
  predictionId, type: 'binary', question: '公开机构会在指定日期前正式发布样例文件吗？',
  object: '样例机构的正式文件发布', timezone: 'UTC',
  forecastClosesAt: '2027-01-01T00:00:00Z', targetAt: '2027-01-02T00:00:00Z',
  resolutionRule: '指定官网在期限前公开正式文件记为是，否则记为否。',
  resolutionSource: { kind: 'official', url: 'https://example.org/result' },
  unresolvablePolicy: '指定来源无法访问则保持待核验，不补造结果。', status: 'ready', ...patch,
})

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'world-domain-independent-'))
  const path = join(directory, 'domain.sqlite')
  const cleanup = []
  let at = '2026-11-18T10:00:00Z'
  const open = () => createDomainStore({ path, registeredToolIds: REGISTERED, now: () => at })
  let store = open()
  t.after(async () => {
    for (const close of cleanup) await close()
    store.close()
    // Known fixture files only; never recursively delete a computed directory.
    for (const name of ['domain.sqlite', 'runtime.sqlite']) for (const suffix of ['', '-wal', '-shm']) {
      const file = join(directory, name) + suffix
      if (existsSync(file)) unlinkSync(file)
    }
    rmdirSync(directory)
  })
  return { get store() { return store }, pathFor: (name) => join(directory, name), addCleanup: (close) => cleanup.push(close),
    setClock(value) { at = value }, reopen() { store.close(); store = open(); return store } }
}

test('independent SQLite audit: retries survive reopening while old question versions and conflicts remain intact', (t) => {
  const fixtureStore = fixture(t)
  let store = fixtureStore.store
  const topicInput = { topicId: 'audit_topic', title: '可重复写入的独立审查主题' }
  const topic = store.createTopic(topicInput, { idempotencyKey: 'topic-once' })
  const initial = store.createPrediction(topic.topicId, completeQuestion('audit_prediction'), { idempotencyKey: 'prediction-once' })
  const edit = { expectedVersion: 1, question: '样例机构会在同一期限前发布正式文件吗？' }
  const second = store.updatePrediction(initial.predictionId, edit, { idempotencyKey: 'edit-once' })
  assert.equal(second.version, 2)
  store = fixtureStore.reopen()
  assert.deepEqual(store.createTopic(topicInput, { idempotencyKey: 'topic-once' }), topic)
  assert.deepEqual(store.updatePrediction(initial.predictionId, edit, { idempotencyKey: 'edit-once' }), second)
  assert.deepEqual(store.getPrediction(initial.predictionId, { version: 1 }), initial)
  assert.throws(() => store.updatePrediction(initial.predictionId, { ...edit, question: '不同内容' }, { idempotencyKey: 'edit-once' }), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.throws(() => store.updatePrediction(initial.predictionId, edit, { idempotencyKey: 'stale-edit' }), { code: 'VERSION_CONFLICT' })
  assert.equal(store.listPredictions().length, 1)
})

test('independent SQLite audit: server receive times, immutable material and topic/prediction isolation cannot be overridden', (t) => {
  const fixtureStore = fixture(t)
  const store = fixtureStore.store
  const topicA = store.createTopic({ topicId: 'audit_topic_a', title: '主题甲' })
  const topicB = store.createTopic({ topicId: 'audit_topic_b', title: '主题乙' })
  store.createPrediction(topicA.topicId, completeQuestion('audit_a1'))
  store.createPrediction(topicA.topicId, completeQuestion('audit_a2'))
  store.createPrediction(topicB.topicId, completeQuestion('audit_b1'))
  const evidenceInput = { evidenceId: 'audit_material', title: '实际接收的样例正文', text: '这份材料只关联甲主题第一题。',
    predictionIds: ['audit_a1'], publishedAt: '2026-11-17T00:00:00Z',
    firstSeenAt: '2000-01-01T00:00:00Z', retrievedAt: '2000-01-01T00:00:00Z', contentHash: 'user-forged' }
  const evidence = store.addEvidence(topicA.topicId, evidenceInput)
  assert.equal(evidence.firstSeenAt, '2026-11-18T10:00:00Z')
  assert.equal(evidence.retrievedAt, evidence.firstSeenAt)
  assert.notEqual(evidence.contentHash, 'user-forged')
  assert.equal(store.listEvidence({ topicId: topicA.topicId, predictionId: 'audit_a1', cutoff: '2026-11-18T09:59:59Z' }).length, 0)
  assert.equal(store.listEvidence({ topicId: topicA.topicId, predictionId: 'audit_a1' }).length, 1)
  assert.equal(store.listEvidence({ topicId: topicA.topicId, predictionId: 'audit_a2' }).length, 0)
  assert.throws(() => store.listEvidence({ topicId: topicA.topicId, predictionId: 'audit_b1' }), { code: 'EVIDENCE_SCOPE_MISMATCH' })
  assert.throws(() => store.addEvidence(topicA.topicId, { ...evidenceInput, evidenceId: 'audit_rollback', predictionIds: ['audit_b1'] }), { code: 'EVIDENCE_SCOPE_MISMATCH' })
  assert.throws(() => store.addEvidence(topicA.topicId, { ...evidenceInput, text: '替换不可变的正文' }), { code: 'EVIDENCE_CONFLICT' })
  assert.equal(store.listEvidence({ topicId: topicA.topicId }).length, 1, 'A rejected cross-topic write must roll back atomically')
  fixtureStore.setClock('2026-11-19T10:00:00Z')
  assert.deepEqual(store.addEvidence(topicA.topicId, evidenceInput), evidence, 'Resubmitting an immutable snapshot must retain its first receive time')
  assert.deepEqual(fixtureStore.reopen().listEvidence({ topicId: topicA.topicId })[0], evidence)
})

test('independent SQLite audit: replay origin cannot be relabeled into a scoreable question or evidence', (t) => {
  const { store } = fixture(t)
  const topic = store.createTopic({ topicId: 'audit_replay', title: '历史回放', sourceMode: 'replay' })
  const prediction = store.createPrediction(topic.topicId, completeQuestion('audit_replay_prediction'))
  assert.equal(prediction.scoringEligible, false)
  assert.throws(() => store.updateTopic(topic.topicId, { expectedVersion: topic.version, sourceMode: 'provided' }), { code: 'TOPIC_SOURCE_MODE_IMMUTABLE' })
  const edited = store.updatePrediction(prediction.predictionId, { expectedVersion: 1, question: '修改文字不能改变历史来源。' })
  assert.equal(edited.scoringEligible, false)
  const evidence = store.addEvidence(topic.topicId, { title: '回放中的手动材料', text: '来源方式不改变主题的回放资格。', sourceMode: 'provided' })
  assert.equal(evidence.scoringEligible, false)
  const live = store.createTopic({ topicId: 'audit_provided', title: '当前材料', sourceMode: 'provided' })
  assert.throws(() => store.updateTopic(live.topicId, { expectedVersion: 1, sourceMode: 'replay' }), { code: 'TOPIC_SOURCE_MODE_IMMUTABLE' })
})

test('independent SQLite audit: public question writes cannot invent running, closed or resolved system states', (t) => {
  const { store } = fixture(t)
  const topic = store.createTopic({ topicId: 'audit_status', title: '状态边界' })
  for (const status of ['active', 'closed', 'resolved']) {
    assert.throws(() => store.createPrediction(topic.topicId, completeQuestion(`audit_status_${status}`, { status })),
      (error) => Boolean(error.code), `Creating ${status} requires its dedicated business operation`)
  }
  const prediction = store.createPrediction(topic.topicId, completeQuestion('audit_status_ready'))
  for (const status of ['active', 'closed', 'resolved']) {
    assert.throws(() => store.updatePrediction(prediction.predictionId, { expectedVersion: 1, status }),
      (error) => Boolean(error.code), `Patching ${status} cannot replace a run/resolution transaction`)
  }
  assert.equal(store.getPrediction(prediction.predictionId).status, 'ready')
  assert.equal(store.getPrediction(prediction.predictionId).version, 1)
})

test('independent SQLite audit: only binary question contracts are accepted, including drafts', (t) => {
  const { store } = fixture(t)
  const topic = store.createTopic({ topicId: 'audit_binary', title: '本轮仅是与否' })
  for (const type of ['categorical', 'numeric', 'ranked_list']) {
    assert.throws(() => store.createPrediction(topic.topicId, { type, question: '不可启用的题型', status: 'draft' }), { code: 'UNSUPPORTED_PREDICTION_TYPE' })
  }
})

const directProbe = (predictionId = 'audit_binding_prediction') => ({
  topicId: 'audit_binding_topic', predictionId, objective: '核对可信绑定中的样例材料。',
  evidence: [{ evidenceId: 'audit_binding_evidence', title: '绑定样例', text: '协议夹具，不是外部调查。' }],
})
const closingProvider = (received) => ({
  model: 'audit-configured-primary', configurationId: 'audit-primary-configuration',
  async complete(input) {
    received.push(input)
    return { message: { role: 'assistant', content: null, tool_calls: [{
      id: 'audit_close', type: 'function', function: { name: 'submit_report', arguments: JSON.stringify({
        status: 'insufficient', summary: '审查夹具只验证角色与预算绑定。', evidenceIds: [], support: [], counterevidence: [],
        missingEvidence: ['未开展事实调查'], probability: null, nextSuggestion: '',
      }) },
    }] }, finishReason: 'tool_calls', usage: { total_tokens: 10 } }
  },
})
const bindingAgent = () => ({ agentSpecId: 'audit_binding_role', specVersion: 3, name: '绑定审查角色',
  instructions: 'AUDIT_PINNED_INSTRUCTIONS', allowedTools: ['list_provided_sources'],
  extensionSlots: ['read_evidence', null], modelRef: 'primary',
  limits: { maxModelRequests: 100, maxToolCalls: 100, maxTotalTokens: 1000000, maxTokens: 100000, timeoutMs: 1000000, maxRetries: 100 } })

test('independent runtime binding audit: model/tool grants and budget ceilings freeze with the selected role and question version', async (t) => {
  const f = fixture(t)
  const received = []
  const path = f.pathFor('runtime.sqlite')
  const runtime = createResearchService({ path, provider: closingProvider(received) })
  f.addCleanup(() => runtime.close())
  const agentSpec = bindingAgent()
  const run = runtime.createProbe(directProbe(), { agentSpec, predictionVersion: 7, kind: 'prediction-research' })
  agentSpec.instructions = 'LATE_MUTATION_MUST_NOT_REPLACE_PINNED_TEXT'
  agentSpec.extensionSlots[0] = 'unregistered_late_tool'
  assert.deepEqual(run.assignment.budget, { maxModelRequests: 8, maxToolCalls: 6, maxTotalTokens: 16000, maxTokens: 2048, timeoutMs: 60000, maxRetries: 2 })
  assert.deepEqual(run.assignment.allowedTools, REGISTERED)
  assert.equal(run.predictionVersion, 7)
  assert.equal(run.agent.specVersion, 3)
  await runtime.idle()
  assert.equal(runtime.getRun(run.runId).status, 'completed')
  assert(received[0].messages[0].content.includes('AUDIT_PINNED_INSTRUCTIONS'))
  assert(!received[0].messages[0].content.includes('LATE_MUTATION'))
  assert.deepEqual(received[0].tools.map((tool) => tool.function.name), [...REGISTERED, 'submit_report'])
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const config = JSON.parse(db.prepare('SELECT config_json FROM runs WHERE run_id = ?').get(run.runId).config_json)
    assert.equal(config.agentSpec.instructions, 'AUDIT_PINNED_INSTRUCTIONS')
    assert.equal(config.agentSpec.specVersion, 3)
    assert.equal(config.predictionVersion, 7)
    assert.equal(config.kind, 'prediction-research')
  } finally { db.close() }
  const currentCount = runtime.listRuns().length
  assert.throws(() => runtime.createProbe(directProbe('unknown_model_prediction'), { agentSpec: { ...bindingAgent(), modelRef: 'unconfigured-other-model' } }), { code: 'MODEL_UNAVAILABLE' })
  assert.throws(() => runtime.createProbe(directProbe('unknown_tool_prediction'), { agentSpec: { ...bindingAgent(), extensionSlots: ['search_news', null] } }), { code: 'TOOL_UNAVAILABLE' })
  assert.equal(runtime.listRuns().length, currentCount, 'Rejected bindings must not queue a runtime job')
})

test('independent runtime binding audit: a stricter role limit is not raised to the server ceiling', async (t) => {
  const f = fixture(t)
  const runtime = createResearchService({ path: f.pathFor('runtime.sqlite'), provider: closingProvider([]) })
  f.addCleanup(() => runtime.close())
  const limits = { maxModelRequests: 3, maxToolCalls: 1, maxTotalTokens: 250, maxTokens: 100, timeoutMs: 1000, maxRetries: 0 }
  const run = runtime.createProbe(directProbe(), { agentSpec: { ...bindingAgent(), modelRef: 'audit-configured-primary', limits } })
  assert.deepEqual(run.assignment.budget, limits)
  await runtime.idle()
  assert.equal(runtime.getRun(run.runId).status, 'completed')
})

function workbenchFixture(t, provider = closingProvider([])) {
  const f = fixture(t)
  const runtime = createResearchService({ path: f.pathFor('runtime.sqlite'), provider })
  const workbench = createWorkbenchService({ path: f.pathFor('domain.sqlite'), runtime, now: () => '2026-11-18T10:00:00Z' })
  f.addCleanup(async () => { await runtime.close(); workbench.close() })
  return { ...f, runtime, workbench }
}

test('independent workbench audit: runs pin their inputs, remain isolated, and retries survive later question/role edits', async (t) => {
  const f = workbenchFixture(t)
  const { workbench, runtime } = f
  const topic = workbench.createTopic({ topicId: 'audit_workbench', title: '工作台独立隔离审查' })
  const first = workbench.createPrediction(topic.topicId, completeQuestion('audit_workbench_first'))
  const second = workbench.createPrediction(topic.topicId, completeQuestion('audit_workbench_second'))
  const a = workbench.addEvidence(topic.topicId, { evidenceId: 'audit_workbench_a', title: '第一题材料', text: '只供第一题使用。', predictionIds: [first.predictionId], publishedAt: '2026-11-17T12:00:00Z' })
  const b = workbench.addEvidence(topic.topicId, { evidenceId: 'audit_workbench_b', title: '第二题材料', text: '只供第二题使用。', predictionIds: [second.predictionId] })
  assert.throws(() => workbench.createRun(first.predictionId, { evidenceIds: [b.evidenceId] }), { code: 'EVIDENCE_SCOPE_MISMATCH' })
  const input = { agentSpecId: 'official', specVersion: 1, predictionVersion: 1, evidenceIds: [a.evidenceId] }
  const run = workbench.createRun(first.predictionId, input, { idempotencyKey: 'workbench-run-once' })
  const originalRole = workbench.getAgent('official')
  workbench.saveAgent({ agentSpecId: 'official', expectedVersion: originalRole.specVersion, instructions: 'LATE_EDIT_NOT_APPLIED_TO_OLD_RUN' })
  workbench.updatePrediction(first.predictionId, { expectedVersion: first.version, question: '编辑后的问题仅属于下一版本。' })
  assert.equal(workbench.createRun(first.predictionId, input, { idempotencyKey: 'workbench-run-once' }).runId, run.runId)
  assert.throws(() => workbench.createRun(first.predictionId, { ...input, objective: '不同输入' }, { idempotencyKey: 'workbench-run-once' }), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.throws(() => workbench.createRun(first.predictionId, input), { code: 'VERSION_CONFLICT' })
  await runtime.idle()
  assert.equal(workbench.listRuns(first.predictionId).length, 1)
  assert.equal(workbench.listRuns(second.predictionId).length, 0)
  assert.equal(workbench.getPrediction(second.predictionId).latestRun, null)
  assert.equal(workbench.getPrediction(first.predictionId).forecast, null, 'A research report must not masquerade as a published forecast')
  const db = new DatabaseSync(f.pathFor('runtime.sqlite'), { readOnly: true })
  try {
    const config = JSON.parse(db.prepare('SELECT config_json FROM runs WHERE run_id = ?').get(run.runId).config_json)
    assert.equal(config.predictionVersion, 1)
    assert.equal(config.agentSpec.specVersion, 1)
    assert(!config.agentSpec.instructions.includes('LATE_EDIT_NOT_APPLIED'))
    assert(config.agentSpec.instructions.includes('区分正式发布'), 'The selected method text must be resolved into the frozen role input')
    assert.deepEqual(config.evidence.map(({ evidenceId }) => evidenceId), [a.evidenceId])
    for (const key of ['firstSeenAt', 'retrievedAt', 'publishedAt', 'contentHash', 'sourceMode']) assert.equal(config.evidence[0][key], a[key])
    assert.equal(typeof config.inputSnapshotAt, 'string')
    assert.equal(config.kind, 'prediction-research')
  } finally { db.close() }
})

test('independent workbench audit: replay, incomplete and expired questions cannot queue a live research run', (t) => {
  const { workbench, runtime } = workbenchFixture(t)
  const replay = workbench.createTopic({ topicId: 'audit_workbench_replay', title: '旧回放', sourceMode: 'replay' })
  const replayQuestion = workbench.createPrediction(replay.topicId, completeQuestion('audit_workbench_replay_question'))
  assert.throws(() => workbench.createRun(replayQuestion.predictionId), { code: 'REPLAY_READ_ONLY' })
  const topic = workbench.createTopic({ topicId: 'audit_workbench_rejections', title: '失败状态' })
  const draft = workbench.createPrediction(topic.topicId, { predictionId: 'audit_workbench_draft', question: '缺少规则' })
  assert.throws(() => workbench.createRun(draft.predictionId), { code: 'PREDICTION_NOT_READY' })
  const expired = workbench.createPrediction(topic.topicId, completeQuestion('audit_workbench_expired', { forecastClosesAt: '2026-11-17T00:00:00Z' }))
  assert.throws(() => workbench.createRun(expired.predictionId), { code: 'FORECAST_CLOSED' })
  const empty = workbench.createPrediction(topic.topicId, completeQuestion('audit_workbench_empty'))
  assert.throws(() => workbench.createRun(empty.predictionId), { code: 'EVIDENCE_REQUIRED' })
  assert.equal(runtime.listRuns().length, 0)
})

test('independent workbench restart audit: an unfinished run resumes its saved role while the editable template advances', async (t) => {
  const f = fixture(t)
  let started
  const began = new Promise((resolve) => { started = resolve })
  const receivedAfterRestart = []
  const provider = { ...closingProvider([]), async complete() { started(); return new Promise(() => {}) } }
  let runtime = createResearchService({ path: f.pathFor('runtime.sqlite'), provider })
  let workbench = createWorkbenchService({ path: f.pathFor('domain.sqlite'), runtime, now: () => '2026-11-18T10:00:00Z' })
  f.addCleanup(async () => { await runtime.close(); workbench.close() })
  const topic = workbench.createTopic({ topicId: 'audit_restart_topic', title: '重启绑定' })
  const question = workbench.createPrediction(topic.topicId, completeQuestion('audit_restart_question'))
  workbench.addEvidence(topic.topicId, { title: '重启材料', text: '实际入库的固定材料。' })
  const run = workbench.createRun(question.predictionId, { agentSpecId: 'official', specVersion: 1 })
  await began
  workbench.saveAgent({ agentSpecId: 'official', expectedVersion: 1, instructions: 'NEW_TEMPLATE_ONLY_FOR_FUTURE_RUNS' })
  await runtime.close()
  workbench.close()
  runtime = createResearchService({ path: f.pathFor('runtime.sqlite'), provider: closingProvider(receivedAfterRestart) })
  workbench = createWorkbenchService({ path: f.pathFor('domain.sqlite'), runtime, now: () => '2026-11-18T10:00:00Z' })
  assert.equal(workbench.getAgent('official').specVersion, 2)
  runtime.resume()
  await runtime.idle()
  const completed = runtime.getRun(run.runId)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.agent.specVersion, 1)
  assert.equal(completed.predictionVersion, 1)
  assert(!receivedAfterRestart[0].messages[0].content.includes('NEW_TEMPLATE_ONLY_FOR_FUTURE_RUNS'))
})

async function httpFixture(f, method, url, data, headers = {}) {
  const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))])
  Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } })
  let status
  let sentHeaders
  let payload
  const res = {
    writeHead(value, values) { status = value; sentHeaders = values },
    end(value) { payload = JSON.parse(value) },
  }
  await handleApi({ workbench: f.workbench, runtime: f.runtime }, req, res)
  assert(payload, 'The actual HTTP dispatcher must send a JSON response')
  return { status, headers: sentHeaders, payload }
}

test('independent HTTP-handler audit: binary contracts, version conflicts and capability injection keep structured failures', async (t) => {
  const f = workbenchFixture(t)
  const config = await httpFixture(f, 'GET', '/api/v1/config')
  assert.equal(config.status, 200)
  assert.deepEqual(config.payload.capabilities.predictionTypes, ['binary'])
  assert.equal(config.payload.capabilities.forecastPublishing, false)
  const created = await httpFixture(f, 'POST', '/api/v1/topics', { topicId: 'audit_http_topic', title: 'HTTP 边界' }, { 'idempotency-key': 'http-topic-once' })
  assert.equal(created.status, 201)
  const topicId = created.payload.topicId
  const unsupported = await httpFixture(f, 'POST', `/api/v1/topics/${topicId}/predictions`, { type: 'categorical', status: 'draft' })
  assert.equal(unsupported.status, 400)
  assert.equal(unsupported.payload.error.code, 'UNSUPPORTED_PREDICTION_TYPE')
  const prediction = await httpFixture(f, 'POST', `/api/v1/topics/${topicId}/predictions`, completeQuestion('audit_http_prediction'))
  assert.equal(prediction.status, 201)
  const edited = await httpFixture(f, 'PATCH', '/api/v1/predictions/audit_http_prediction', { expectedVersion: 1, question: '新版本问题。' })
  assert.equal(edited.status, 200)
  const stale = await httpFixture(f, 'PATCH', '/api/v1/predictions/audit_http_prediction', { expectedVersion: 1, question: '迟到写入。' })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.error.code, 'VERSION_CONFLICT')
  const fabricated = await httpFixture(f, 'PATCH', '/api/v1/predictions/audit_http_prediction', { expectedVersion: 2, status: 'resolved' })
  assert.equal(fabricated.status, 400)
  assert.equal(fabricated.payload.error.code, 'UNSUPPORTED_PREDICTION_STATUS')
  const injected = await httpFixture(f, 'POST', '/api/v1/predictions/audit_http_prediction/runs', { allowedTools: ['unregistered_tool'], agentSpec: { instructions: 'replace server identity' } })
  assert.equal(injected.status, 400)
  assert.equal(injected.payload.error.code, 'INVALID_RESEARCH_REQUEST')
  const importPath = await httpFixture(f, 'POST', '/api/v1/imports/legacy', { path: 'arbitrary-private-path.json' })
  assert.equal(importPath.status, 400)
  assert.equal(importPath.payload.error.code, 'INVALID_IMPORT')
  assert.equal(f.runtime.listRuns().length, 0)
  assert.equal(fabricated.headers['Cache-Control'], 'no-store')
})
