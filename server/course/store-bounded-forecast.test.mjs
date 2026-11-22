import test from 'node:test'
import assert from 'node:assert/strict'
import { createCourseStore } from './course-store.mjs'
import { BOUNDED_FORECAST_POLICY, boundedForecastBudget } from './bounded-forecast.mjs'
import { PRICE_POLICY } from './market-resolution.mjs'
import { groundingPolicy } from '../domain/claim-grounding.mjs'

const NOW = '2026-11-22T03:00:00.000Z'
function fixture(t, { bounded = true, price = false } = {}) {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  t.after(() => store.close())
  const request = store.createRequest({ question: 'Is the defined event likely?', purpose: 'forecast', watch: false,
    modelMode: 'live', sourceMode: 'live', budget: { maxTotalTokens: 100000, ...(bounded ? { strategy: BOUNDED_FORECAST_POLICY } : {}) },
    ...(price ? { resolutionPolicy: { version: PRICE_POLICY } } : {}) })
  const runId = request.activeRunId
  const prediction = { predictionId: 'prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    forecastClosesAt: '2026-11-24T03:00:00.000Z', targetAt: '2026-11-24T03:00:00.000Z', resolutionRuleVersion: 1,
    resolutionSource: { url: 'https://example.com/official' } }
  store.saveRun(runId, { status: 'running', topicId: 'topic', predictionId: prediction.predictionId, predictionVersion: 1 })
  const evidenceIds = []
  function assign(assignmentId, roleId, { status = 'completed', followUp = false, report = {} } = {}) {
    const evidenceId = `evidence_${assignmentId}`
    store.createAssignment(runId, { assignmentId, roleId, followUp })
    store.recordEvidence(runId, { evidenceId, topicId: 'topic', predictionId: prediction.predictionId,
      title: 'Isolated test evidence', text: 'A genuinely read fixture receipt; not real world news.',
      url: prediction.resolutionSource.url, contentHash: evidenceId, sourceMode: 'live',
      publishedAt: '2026-11-22T02:00:00.000Z', ...(price ? { marketQuote: { pair: 'BTC-USDT' } } : {}) }, assignmentId)
    evidenceIds.push(evidenceId)
    store.saveAssignment(assignmentId, { status, ...(status === 'completed'
      ? { report: { status: 'complete', summary: 'Evidence-backed role estimate.', evidenceIds: [evidenceId], probability: .6, ...report } }
      : { error: { code: 'TEST_FAILURE', message: 'A later failed investigation.' } }) })
    return evidenceId
  }
  function candidate(extra = {}) { return { probabilityYes: .6, summary: 'Finite fixture estimate.', evidenceIds: [...evidenceIds], ...extra } }
  return { store, requestId: request.requestId, runId, prediction, assign, candidate }
}

test('bounded publication accepts a successful replacement and retains prior complete reports after later failure', t => {
  const f = fixture(t)
  f.assign('official_initial', 'official', { status: 'failed' })
  f.assign('statistics_initial', 'statistics')
  f.assign('official_replacement', 'official', { followUp: true })
  f.assign('statistics_later', 'statistics', { followUp: true, status: 'failed' })
  const scorecard = [{ roleId: 'official', assignmentId: 'official_replacement', probabilityYes: .6 }]
  const published = f.store.publishForecast(f.runId, f.candidate({ publicationMode: 'bounded-report-aggregation',
    scorecard, aggregationMethod: 'unweighted-median' }), f.prediction)
  assert.equal(published.probabilityYes, .6)
  assert.equal(published.publicationMode, 'bounded-report-aggregation')
  assert.equal(published.aggregationMethod, 'unweighted-median')
  assert.deepEqual(published.scorecard, scorecard)
  assert.match(published.label, /主Agent未完成最终裁决/)
  assert.equal(published.reviewRequired, true)
  assert.equal(published.scoringEligible, false)
  assert(published.reviewReasons.some(reason => reason.includes('程序汇集')))
  assert.equal(published.statusFacts.find(fact => fact.key === 'scoring').status, 'ineligible')
  assert.deepEqual(f.store.listForecasts()[0], published)
  assert.equal(f.store.listEvents({ runId: f.runId }).at(-1).payload.publicationMode, 'bounded-report-aggregation')
})

test('a complete verification seat cannot make program aggregation count as an independently finalized forecast', t => {
  const f = fixture(t)
  f.store.updateRequest(f.requestId, { groundingPolicy })
  const evidenceId = f.assign('official_initial', 'official')
  f.assign('verification_initial', 'verification')
  const quote = 'A genuinely read fixture receipt'
  const published = f.store.publishForecast(f.runId, f.candidate({ publicationMode: 'bounded-report-aggregation',
    reasoningClaims: [{ claim: quote, basis: 'fact', evidenceIds: [evidenceId], citations: [{ evidenceId, quote }] }] }), f.prediction)
  assert.equal(published.reviewRequired, true)
  assert.equal(published.scoringEligible, false)
  assert.equal(published.reviewReasons.length, 1)
  assert.match(published.reviewReasons[0], /主Agent未完成有效最终裁决/)
})

test('bounded publication rejects unknown usage rather than sealing an unaccounted result', t => {
  const f = fixture(t)
  f.assign('official_initial', 'official')
  f.assign('verification_initial', 'verification')
  f.store.recordUsage(f.runId, undefined)
  assert.throws(() => f.store.publishForecast(f.runId, f.candidate(), f.prediction), { code: 'COURSE_USAGE_UNKNOWN' })
  assert.equal(f.store.getRun(f.runId).usage.unknownUsage, true)
  assert.equal(f.store.listForecasts().length, 0)
})

test('bounded worker limits use the committed settings snapshot without changing idempotent input identity', t => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  t.after(() => store.close())
  const base = { maxTotalTokens: 1000000, maxTokens: 8192, worker: { maxTokens: 8192 } }
  const input = { question: 'budget snapshot', purpose: 'forecast', budget: boundedForecastBudget(base, base.maxTotalTokens) }
  const first = store.createRequest(input, { idempotencyKey: 'same-request', predictionBudget: { mode: 'limited', maxTotalTokens: 100000 } })
  const original = store.getRun(first.activeRunId).budget
  assert.deepEqual(original, boundedForecastBudget(input.budget, 100000))
  const replay = store.createRequest(input, { idempotencyKey: 'same-request', predictionBudget: { mode: 'limited', maxTotalTokens: 300000 } })
  assert.equal(replay.requestId, first.requestId)
  assert.deepEqual(store.getRun(replay.activeRunId).budget, original)
  const later = store.createRequest(input, { idempotencyKey: 'new-request', predictionBudget: { mode: 'limited', maxTotalTokens: 300000 } })
  assert.deepEqual(store.getRun(later.activeRunId).budget, boundedForecastBudget(input.budget, 300000))
})

test('bounded publication cannot count repeated roles or harness-generated reports as extra seats', t => {
  const f = fixture(t)
  f.assign('statistics_initial', 'statistics')
  f.assign('statistics_second', 'statistics')
  f.assign('statistics_followup', 'statistics', { followUp: true })
  assert.throws(() => f.store.publishForecast(f.runId, f.candidate(), f.prediction), { code: 'REPORTS_INSUFFICIENT' })
  f.assign('official_receipt', 'official', { report: { generatedBy: 'harness' } })
  assert.throws(() => f.store.publishForecast(f.runId, f.candidate(), f.prediction), { code: 'REPORTS_INSUFFICIENT' })
  assert.equal(f.store.listForecasts().length, 0)
})

test('legacy publication still requires two initial complete reports and does not invent aggregation metadata', t => {
  const f = fixture(t, { bounded: false })
  f.assign('official_initial', 'official', { status: 'failed' })
  f.assign('statistics_initial', 'statistics')
  f.assign('official_replacement', 'official', { followUp: true })
  assert.throws(() => f.store.publishForecast(f.runId, f.candidate(), f.prediction), { code: 'REPORTS_INSUFFICIENT' })
  f.assign('verification_initial', 'verification')
  const published = f.store.publishForecast(f.runId, f.candidate(), f.prediction)
  for (const key of ['publicationMode', 'scorecard', 'aggregationMethod']) assert.equal(Object.hasOwn(published, key), false)
})

test('strict BTC policy still requires all three initial seats even with a complete follow-up', t => {
  for (const bounded of [false, true]) {
    const f = fixture(t, { bounded, price: true })
    const quoteId = f.assign('market_initial', 'market')
    f.assign('statistics_initial', 'statistics')
    f.assign('verification_initial', 'verification', { status: 'failed' })
    f.assign('verification_followup', 'verification', { followUp: true })
    const quote = f.store.evidenceFor(f.runId).find(source => source.evidenceId === quoteId)
    f.store.recordEvidence(f.runId, quote, 'main')
    f.store.saveRun(f.runId, { state: { priceFinalSnapshot: { quoteEvidenceId: quoteId }, latestReference: { evidenceId: quoteId, observedAt: NOW } } })
    assert.throws(() => f.store.publishForecast(f.runId, f.candidate(), f.prediction), { code: 'PRICE_TEAM_INCOMPLETE' })
    assert.equal(f.store.listForecasts().length, 0)
  }
})
