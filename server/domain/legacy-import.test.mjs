import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorld } from '../world.mjs'
import { normalizeLegacySnapshot } from './legacy-import.mjs'

const rawState = () => ({
  version: 1, step: 1,
  pending: { 'nvda-charge': { probability: 0.61, issuedAt: '2025-04-16T09:03:30-04:00', mode: 'mock' } },
  history: [{ targetId: 'amd-license', target: '旧题文字', probability: 0.60, outcome: 1, brier: 0.16,
    issuedAt: '2025-04-15T17:22:59-04:00', resolvedAt: '2025-04-16T09:03:30-04:00', mode: 'mock', sourceIds: ['amd-8k'] }],
  forecast: { probability: 0.61, lockedProbability: 0.61 }, trace: [{ id: 'line-1', agentId: 'chair', message: '原会议摘要。' }],
})

test('real legacy API snapshot imports as one replay topic and two unscored draft questions without revealing hidden stages', async () => {
  const snapshot = await createWorld({ provider: { mode: 'mock' } }).get()
  const original = structuredClone(snapshot)
  const plan = normalizeLegacySnapshot(snapshot)
  assert.equal(plan.topic.sourceMode, 'replay')
  assert.equal(plan.predictions.length, 2)
  for (const prediction of plan.predictions) {
    assert.equal(prediction.type, 'binary')
    assert.equal(prediction.topicId, plan.topic.topicId)
    assert.equal(prediction.status, 'draft')
    assert.equal(prediction.scoringEligible, false)
    assert.equal(prediction.forecastClosesAt, null)
    assert.equal(prediction.targetAt, null)
    assert(prediction.validation.missingFields.includes('resolutionRule'))
    assert.equal(prediction.originalMode, 'mock')
  }
  const timeline = plan.archive.records.filter(({ kind }) => kind === 'timeline')
  assert.equal(timeline[0].data.date, snapshot.stages[0].date)
  assert.equal(timeline[1].data.date, null)
  assert(timeline[1].missingFields.includes('date'))
  const evidence = plan.archive.records.filter(({ kind }) => kind === 'evidence')
  assert.deepEqual(evidence.map(({ data }) => data.id), ['amd-10k', 'nvda-8k'])
  assert(evidence.every((item) => item.missingFields.includes('retrievedAt')))
  assert(!Object.hasOwn(plan, 'evidence'), 'Incomplete historical excerpts cannot become new eligible source snapshots')
  assert.deepEqual(snapshot, original)
  assert.deepEqual(plan.archive.raw, snapshot)
  assert.equal(plan.archive.originalMode, 'mock')
  assert.equal(plan.archive.scoringEligible, false)
})

test('raw version-one state preserves original forecasts, modes, scores and missing times as archive data', () => {
  const snapshot = rawState()
  const plan = normalizeLegacySnapshot(snapshot)
  assert.equal(plan.archive.format, 'world-state-v1')
  const historical = plan.archive.records.find(({ kind }) => kind === 'settled-forecast')
  assert.deepEqual(historical.data, snapshot.history[0])
  assert.equal(historical.originalMode, 'mock')
  assert.equal(historical.scoringEligible, false)
  assert.equal(historical.predictionId, plan.predictions[0].predictionId)
  const pending = plan.archive.records.find(({ kind }) => kind === 'pending-forecast')
  assert.equal(pending.data.probability, 0.61)
  assert.equal(pending.originalMode, 'mock')
  assert.equal(pending.predictionId, plan.predictions[1].predictionId)
  const summary = plan.archive.records.find(({ kind }) => kind === 'forecast-summary')
  assert(summary.missingFields.includes('issuedAt'))
  assert.equal(summary.originalMode, 'unknown')
  assert.equal(plan.archive.cutoff, null)
  assert(plan.archive.missingFields.includes('snapshotCapturedAt'))
  assert(plan.archive.missingFields.includes('cutoff'))
  assert(plan.archive.missingFields.includes('evidence'))
  assert.equal(plan.archive.raw.pending['nvda-charge'].issuedAt, snapshot.pending['nvda-charge'].issuedAt)
  assert.equal(new Set(plan.archive.records.map(({ kind, legacyId }) => `${kind}:${legacyId}`)).size, plan.archive.records.length)
})

test('source identity is deterministic, immutable input is retained, and later snapshots map to the same two questions', () => {
  const snapshot = rawState()
  const first = normalizeLegacySnapshot(snapshot)
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse())
  assert.deepEqual(normalizeLegacySnapshot(reordered), first)
  const next = normalizeLegacySnapshot({ ...snapshot, step: 2, forecast: null })
  assert.notEqual(next.sourceHash, first.sourceHash)
  assert.equal(next.topic.topicId, first.topic.topicId)
  assert.deepEqual(next.predictions.map(({ predictionId }) => predictionId), first.predictions.map(({ predictionId }) => predictionId))
  const suppliedHash = 'A'.repeat(64)
  assert.equal(normalizeLegacySnapshot(snapshot, { sourceHash: suppliedHash }).sourceHash, suppliedHash.toLowerCase())
  first.archive.raw.history[0].probability = 0
  assert.equal(snapshot.history[0].probability, 0.60)
})

test('unsupported or malformed legacy inputs fail without generating a partial import plan', () => {
  for (const input of [null, [], {}, { ...rawState(), version: 2 }, { ...rawState(), step: 99 },
    { ...rawState(), history: [null] }, { ...rawState(), pending: { bad: null } },
    { ...rawState(), case: { id: 'unrelated-case' } }]) {
    assert.throws(() => normalizeLegacySnapshot(input), { code: 'INVALID_LEGACY_SNAPSHOT' })
  }
  assert.throws(() => normalizeLegacySnapshot(rawState(), { sourceHash: 'short' }), { code: 'INVALID_LEGACY_SOURCE_HASH' })
  assert.throws(() => normalizeLegacySnapshot({ ...rawState(), forecast: { probability: NaN } }), { code: 'INVALID_JSON_VALUE' })
})
