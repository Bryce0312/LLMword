import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createDomainStore } from './domain-store.mjs'
import { getAgentCatalog, PROVIDED_TOOL_IDS } from './agent-catalog.mjs'

const NOW = '2026-11-18T08:00:00.000Z'
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-domain-'))
  const path = join(folder, 'domain.sqlite')
  const stores = []
  t.after(async () => {
    stores.forEach((store) => store.close())
    await rm(folder, { recursive: true, force: true })
  })
  return {
    path,
    open() {
      const store = createDomainStore({ path, registeredToolIds: PROVIDED_TOOL_IDS, now: () => NOW })
      stores.push(store)
      return store
    },
  }
}

function contract(overrides = {}) {
  return {
    type: 'binary', question: '甲公司是否在月底前正式任命 CEO？', object: '甲公司',
    timezone: 'Asia/Shanghai', forecastClosesAt: '2026-11-29T15:59:59Z', targetAt: '2026-11-30T15:59:59Z',
    resolutionRuleVersion: 1, resolutionRule: '以官网正式任命公告为准，期限内无公告记否。',
    resolutionSource: { kind: 'official', url: 'https://example.com/appointments' },
    unresolvablePolicy: 'pending_then_manual_review', status: 'ready', ...overrides,
  }
}

test('drafts persist incomplete fields, ready requires valid contracts, and versions survive reopening', async (t) => {
  const f = await fixture(t)
  const store = f.open()
  const topic = store.createTopic({ title: '管理层变化' })
  const draft = store.createPrediction(topic.topicId, { question: '会发生什么？' })
  assert.equal(draft.status, 'draft')
  assert(draft.validation.missingFields.includes('targetAt'))
  assert.equal(draft.scoringEligible, false)
  assert.throws(() => store.updatePrediction(draft.predictionId, { expectedVersion: 1, status: 'ready' }),
    (error) => error.code === 'PREDICTION_INCOMPLETE' && error.fields.includes('resolutionRule'))
  const ready = store.updatePrediction(draft.predictionId, { expectedVersion: 1, ...contract() })
  assert.equal(ready.version, 2)
  assert.equal(ready.validation.ready, true)
  assert.equal(ready.scoringEligible, true)
  assert.throws(() => store.updatePrediction(draft.predictionId, { expectedVersion: 1, question: '晚到修改' }),
    { code: 'VERSION_CONFLICT', status: 409 })
  assert.equal(store.getPrediction(draft.predictionId, { version: 1 }).question, '会发生什么？')
  store.close()
  const reopened = f.open()
  assert.equal(reopened.getPrediction(draft.predictionId).version, 2)
  assert.equal(reopened.getPrediction(draft.predictionId, { version: 1 }).status, 'draft')
  assert.equal(reopened.metadata.schemaVersion, 1)
})

test('only binary predictions can be created or modified, including drafts, with strict dates and sources', async (t) => {
  const store = (await fixture(t)).open()
  const topic = store.createTopic({ title: '候选人' })
  const options = [{ optionId: 'a', label: '甲' }, { optionId: 'none', label: '期限内未任命' }]
  const input = contract()
  const prediction = store.createPrediction(topic.topicId, input)
  assert.deepEqual(prediction.options, [])
  for (const type of ['categorical', 'numeric', 'ranked_list']) {
    for (const status of ['draft', 'ready']) {
      assert.throws(() => store.createPrediction(topic.topicId, { type, status }), { code: 'UNSUPPORTED_PREDICTION_TYPE' })
      assert.throws(() => store.updatePrediction(prediction.predictionId, { expectedVersion: 1, type, status }),
        { code: 'UNSUPPORTED_PREDICTION_TYPE' })
    }
  }
  for (const status of ['active', 'paused', 'closed', 'resolved', 'void']) {
    assert.throws(() => store.createPrediction(topic.topicId, contract({ status })), { code: 'UNSUPPORTED_PREDICTION_STATUS' })
    assert.throws(() => store.updatePrediction(prediction.predictionId, { expectedVersion: 1, status }),
      { code: 'UNSUPPORTED_PREDICTION_STATUS' })
  }
  for (const patch of [
    { options: [options[0], options[0]] }, { timezone: 'Mars/Room' }, { targetAt: '2026-02-30T10:00:00Z' },
    { forecastClosesAt: '2026-12-01T10:00:00Z' }, { resolutionSource: { kind: 'official', url: 'javascript:alert(1)' } },
  ]) {
    assert.throws(() => store.createPrediction(topic.topicId, { ...input, ...patch }))
  }
  assert.equal(store.getPrediction(prediction.predictionId).version, 1)
  assert.equal(store.listPredictions().length, 1)
})

test('previously persisted categorical versions remain readable when a new binary version is authored', async (t) => {
  const f = await fixture(t)
  const store = f.open()
  const topic = store.createTopic({ title: '兼容旧题型存档' })
  const draft = store.createPrediction(topic.topicId, { question: '先前保存的候选题' })
  store.close()
  // This temporary fixture represents a database written before the binary-only scope change.
  const database = new DatabaseSync(f.path)
  try {
    const old = { ...draft, type: 'categorical', options: [{ optionId: 'a', label: '甲' }, { optionId: 'b', label: '乙' }] }
    database.prepare('UPDATE domain_prediction_versions SET record_json = ? WHERE prediction_id = ? AND version = 1')
      .run(JSON.stringify(old), draft.predictionId)
  } finally { database.close() }
  const reopened = f.open()
  assert.equal(reopened.getPrediction(draft.predictionId).type, 'categorical')
  assert.throws(() => reopened.updatePrediction(draft.predictionId, { expectedVersion: 1, question: '继续旧题型' }),
    { code: 'UNSUPPORTED_PREDICTION_TYPE' })
  const current = reopened.updatePrediction(draft.predictionId, { expectedVersion: 1, ...contract(), options: [] })
  assert.equal(current.type, 'binary')
  assert.equal(current.version, 2)
  assert.equal(reopened.getPrediction(draft.predictionId, { version: 1 }).type, 'categorical')
})

test('write idempotency is durable, binds payload and precedes optimistic version checks on retries', async (t) => {
  const f = await fixture(t)
  const store = f.open()
  const topic = store.createTopic({ title: '主题' }, { idempotencyKey: 'topic-once' })
  assert.equal(store.createTopic({ title: '主题' }, { idempotencyKey: 'topic-once' }).topicId, topic.topicId)
  assert.throws(() => store.createTopic({ title: '变了' }, { idempotencyKey: 'topic-once' }), { code: 'IDEMPOTENCY_CONFLICT' })
  const draft = store.createPrediction(topic.topicId, { question: '样例' }, { idempotencyKey: 'prediction-once' })
  const patch = { expectedVersion: 1, question: '已修改的样例' }
  const changed = store.updatePrediction(draft.predictionId, patch, { idempotencyKey: 'edit-once' })
  store.close()
  const reopened = f.open()
  assert.deepEqual(reopened.updatePrediction(draft.predictionId, patch, { idempotencyKey: 'edit-once' }), changed)
  assert.equal(reopened.createPrediction(topic.topicId, { question: '样例' }, { idempotencyKey: 'prediction-once' }).predictionId, draft.predictionId)
  assert.equal(reopened.getPrediction(draft.predictionId).version, 2)
})

test('evidence owns server receive times, immutable content and prediction scope', async (t) => {
  const store = (await fixture(t)).open()
  const topic = store.createTopic({ title: '共享主题' })
  const other = store.createTopic({ title: '另一个主题' })
  const a = store.createPrediction(topic.topicId, { question: '题一' })
  const b = store.createPrediction(topic.topicId, { question: '题二' })
  const c = store.createPrediction(other.topicId, { question: '题三' })
  const input = {
    evidenceId: 'evidence_one', title: '提供的公告', text: '明确的样例正文', url: 'https://example.com/a',
    publishedAt: '2026-11-18T07:00:00Z', firstSeenAt: '2020-01-01T00:00:00Z', retrievedAt: '2020-01-01T00:00:00Z',
    predictionIds: [a.predictionId],
  }
  const saved = store.addEvidence(topic.topicId, input)
  assert.equal(saved.firstSeenAt, NOW)
  assert.equal(saved.retrievedAt, NOW)
  assert(saved.contentHash.startsWith('sha256:'))
  assert.equal(store.listEvidence({ topicId: topic.topicId, predictionId: a.predictionId }).length, 1)
  assert.equal(store.listEvidence({ topicId: topic.topicId, predictionId: b.predictionId }).length, 0)
  assert.equal(store.listEvidence({ topicId: topic.topicId, cutoff: '2026-11-18T07:59:59Z' }).length, 0)
  store.addEvidence(topic.topicId, { title: '共享资料', text: '共享正文' })
  assert.equal(store.listEvidence({ topicId: topic.topicId, predictionId: b.predictionId }).length, 1)
  assert.deepEqual(store.addEvidence(topic.topicId, input), saved)
  assert.throws(() => store.addEvidence(topic.topicId, { ...input, text: '不同正文' }), { code: 'EVIDENCE_CONFLICT' })
  assert.throws(() => store.addEvidence(topic.topicId, { title: '越界', text: '样例', predictionIds: [c.predictionId] }),
    { code: 'EVIDENCE_SCOPE_MISMATCH' })
  assert.throws(() => store.addEvidence(topic.topicId, { title: '过长', text: 'x'.repeat(4001) }), { code: 'INVALID_EVIDENCE' })
})

test('agent versions are immutable and permissions admit registered tool IDs only', async (t) => {
  const store = (await fixture(t)).open()
  const initial = store.saveAgentSpec(getAgentCatalog()[0], { idempotencyKey: 'agent-init' })
  assert.equal(initial.specVersion, 1)
  const next = store.saveAgentSpec({
    agentSpecId: initial.agentSpecId, expectedVersion: 1, instructions: '先核对更正，再读原文。', extensionSlots: ['read_evidence', null],
  })
  assert.equal(next.specVersion, 2)
  assert.equal(store.getAgentSpec(initial.agentSpecId, { specVersion: 1 }).instructions, initial.instructions)
  assert.equal(store.listAgentSpecs().length, 1)
  assert.throws(() => store.saveAgentSpec({ agentSpecId: initial.agentSpecId, expectedVersion: 1, instructions: '旧版本修改' }),
    { code: 'VERSION_CONFLICT' })
  assert.throws(() => store.saveAgentSpec({ ...next, expectedVersion: 2, allowedTools: ['not_registered'] }))
})

test('topic source mode cannot promote replay data and malformed writes remain atomic', async (t) => {
  const store = (await fixture(t)).open()
  const replay = store.createTopic({ title: '回放主题', sourceMode: 'replay' })
  const prediction = store.createPrediction(replay.topicId, contract())
  assert.equal(prediction.scoringEligible, false)
  assert.throws(() => store.updateTopic(replay.topicId, { expectedVersion: 1, sourceMode: 'provided' }),
    { code: 'TOPIC_SOURCE_MODE_IMMUTABLE' })
  assert.equal(store.getTopic(replay.topicId).version, 1)
  assert.equal(store.getPrediction(prediction.predictionId).scoringEligible, false)
  assert.equal(store.addEvidence(replay.topicId, { title: '后来提供的材料', text: '不因此改变回放的评分资格。', sourceMode: 'provided' }).scoringEligible, false)
  for (const value of [null, [], 'wrong']) {
    for (const write of [
      () => store.createTopic(value), () => store.createPrediction(replay.topicId, value),
      () => store.updateTopic(replay.topicId, value), () => store.updatePrediction(prediction.predictionId, value),
      () => store.saveAgentSpec(value), () => store.addEvidence(replay.topicId, value),
    ]) assert.throws(write, { code: 'INVALID_INPUT' })
  }
  assert.equal(store.listTopics().length, 1)
  assert.equal(store.listPredictions().length, 1)
})

test('legacy import preserves raw data, imports exactly two replay drafts and cannot add scoring eligibility', async (t) => {
  const f = await fixture(t)
  const store = f.open()
  const snapshot = {
    version: 1, step: 1, pending: {}, forecast: null, trace: [],
    history: [{ targetId: 'amd-license', target: '旧题', probability: 0.6, outcome: 1, brier: 0.16 }],
  }
  const before = structuredClone(snapshot)
  const imported = store.importLegacy({ snapshot })
  assert.deepEqual(snapshot, before)
  assert.equal(imported.predictions.length, 2)
  assert.equal(imported.topic.sourceMode, 'replay')
  assert(imported.predictions.every((prediction) => prediction.status === 'draft' && !prediction.scoringEligible))
  assert(store.getLegacyImport(imported.sourceHash).archive.raw.history.length === 1)
  assert.equal(store.listEvidence({ topicId: imported.topic.topicId }).length, 0)
  assert.equal(store.listLearningEntries()[0].scoringEligible, false)
  assert.equal(store.listLearningEntries()[0].issuedAt, null)
  assert.equal(store.importLegacy({ snapshot }).duplicate, true)
  store.close()
  const reopened = f.open()
  assert.equal(reopened.importLegacy({ snapshot }).duplicate, true)
  assert.equal(reopened.listPredictions().length, 2)
  assert.throws(() => reopened.importLegacy({ snapshot: { ...snapshot, step: 2 }, sourceHash: imported.sourceHash }), { code: 'LEGACY_HASH_CONFLICT' })
})
