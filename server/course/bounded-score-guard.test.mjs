import assert from 'node:assert/strict'
import test from 'node:test'
import { createCourseStore } from './course-store.mjs'
import { groundingPolicy } from '../domain/claim-grounding.mjs'

// In-memory publication guards only; synthetic records are never real forecasts.
const NOW = '2026-11-22T08:00:00.000Z', TARGET = '2026-11-24T08:00:00.000Z'
function fixture(scores, { bounded = true, roles = ['market', 'verification'], publicationMode } = {}) {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  const request = store.createRequest({ question: '虚构事件协议测试', modelMode: 'mock', sourceMode: 'replay', watch: false, groundingPolicy,
    purpose: 'forecast', budget: { maxTotalTokens: 100000, ...(bounded ? { strategy: 'bounded-forecast-v1' } : {}) } })
  const runId = request.activeRunId
  const prediction = { predictionId: 'prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    targetAt: TARGET, forecastClosesAt: TARGET, resolutionSource: { url: 'https://example.com/source/0' } }
  store.saveRun(runId, { topicId: 'topic', phase: 'review' }); store.bindPrediction(runId, prediction.predictionId, 1)
  store.updateRequest(request.requestId, { predictionId: prediction.predictionId, predictionVersion: 1, normalized: { ...prediction, conditionalOnly: false } })
  const claims = [], notes = []
  scores.forEach((probability, index) => {
    const assignmentId = 'seat_' + index, evidenceId = 'evidence_' + index
    const text = '这是已实际读取的虚构协议测试材料，未来结果仍然未知。'
    store.recordEvidence(runId, { evidenceId, topicId: 'topic', predictionId: prediction.predictionId, url: `https://example.com/source/${index}`,
      text, contentHash: 'fixture_' + index, sourceMode: 'replay', fixture: true }, assignmentId)
    const claim = { claim: roles[index] + '席据当前材料作有限推断。', basis: 'inference', evidenceIds: [evidenceId], citations: [{ evidenceId, quote: text }] }
    store.createAssignment(runId, { assignmentId, roleId: roles[index] })
    store.saveAssignment(assignmentId, { status: 'completed', report: { status: 'complete', summary: '静态协议报告', probability,
      evidenceIds: [evidenceId], support: [claim], counterevidence: [], missingEvidence: [] } })
    claims.push(claim); notes.push({ assignmentId, disposition: 'qualified', reason: '仅验证协议', evidenceIds: [evidenceId] })
  })
  const candidate = { probabilityYes: .61, summary: '协议提案，不是现实预测。', evidenceIds: scores.map((_, index) => 'evidence_' + index),
    reasoningClaims: claims, decisionNotes: notes, ...(publicationMode ? { publicationMode } : {}) }
  return { store, runId, prediction, candidate }
}

test('bounded publisher rejects null, missing, nonnumeric and out-of-range role scores for normal and aggregated proposals', () => {
  for (const publicationMode of [undefined, 'bounded-report-aggregation']) for (const scores of [[null, null], [.6, null], [.6, undefined], [.6, '0.5'], [-.1, .6], [.6, 1.1]]) {
    const f = fixture(scores, { publicationMode })
    try {
      assert.throws(() => f.store.publishForecast(f.runId, f.candidate, f.prediction), { code: 'REPORT_SCORES_INSUFFICIENT' })
      assert.equal(f.store.listForecasts().length, 0)
    } finally { f.store.close() }
  }
})

test('two distinct valid roles including boundary probabilities may publish, while repeated role assignments count once', () => {
  const valid = fixture([0, 1])
  try { assert.equal(valid.store.publishForecast(valid.runId, valid.candidate, valid.prediction).probabilityYes, .61) }
  finally { valid.store.close() }
  const repeated = fixture([.4, .6], { roles: ['market', 'market'] })
  try { assert.throws(() => repeated.store.publishForecast(repeated.runId, repeated.candidate, repeated.prediction), { code: 'REPORTS_INSUFFICIENT' }) }
  finally { repeated.store.close() }
})

test('a successful replacement contributes one score for its role and the guard does not change legacy publication semantics', () => {
  const replacement = fixture([null, .6, .7], { roles: ['market', 'market', 'verification'] })
  try { assert.equal(replacement.store.publishForecast(replacement.runId, replacement.candidate, replacement.prediction).probabilityYes, .61) }
  finally { replacement.store.close() }
  const legacy = fixture([null, null], { bounded: false })
  try { assert.equal(legacy.store.publishForecast(legacy.runId, legacy.candidate, legacy.prediction).probabilityYes, .61) }
  finally { legacy.store.close() }
})
