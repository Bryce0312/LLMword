import test from 'node:test'
import assert from 'node:assert/strict'
import { createCourseStore } from './course-store.mjs'
import { groundingPolicy, validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { WARNING_URL, WARNING_RULE, WARNING_POLICY } from './weather-warning.mjs'
import { runWarningCase } from '../../scripts/warning-case.mjs'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { handleCourseApi } from '../course-http.mjs'

test('HTTP result verification rejects client-supplied outcomes or source URLs before resolving', async () => {
  let calls = 0
  const course = { async resolve() { calls++; return { outcome: 1 } } }
  for (const [body, expected] of [[{ outcome: 1 }, 400], [{ sourceUrl: 'https://example.com' }, 400], [{}, 200]]) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req, { method: 'POST', url: '/api/v1/course/requests/q/resolve', headers: {} })
    let status, value
    const res = { writeHead(code) { status = code }, end(text) { value = JSON.parse(text) } }
    await handleCourseApi(course, req, res); assert.equal(status, expected); assert(value)
  }
  assert.equal(calls, 1)
})

test('the original public real-model candidate passes repaired grounding without another model call', () => {
  const recorded = JSON.parse(readFileSync(new URL('../../docs/evidence/warning-grounding-regression.json', import.meta.url), 'utf8'))
  assert.equal(validateGroundedClaims(recorded.claims, recorded.evidence).length, recorded.claims.length)
  const wrong = JSON.parse(JSON.stringify(recorded.claims)); wrong[0].claim = '截至06:20:55Z快照，代码为WFIRER。'
  assert.throws(() => validateGroundedClaims(wrong, recorded.evidence))
})

function fixture() {
  let time = '2026-11-21T06:20:41.990Z'
  const store = createCourseStore({ path: ':memory:', now: () => time }), targetAt = '2026-11-21T06:35:29.095Z'
  const request = store.createRequest({ question: '香港天文台红色火灾危险警告是否仍有效？', modelMode: 'live', sourceMode: 'live', watch: false, groundingPolicy, purpose: 'forecast', budget: { maxTotalTokens: 80000 }, resolutionPolicy: { version: WARNING_POLICY, targetAt } })
  const runId = request.activeRunId, prediction = { predictionId: 'prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true }, targetAt, forecastClosesAt: targetAt, resolutionSource: { url: WARNING_URL }, resolutionRule: WARNING_RULE }
  store.saveRun(runId, { topicId: 'topic', phase: 'review' }); store.bindPrediction(runId, prediction.predictionId, 1)
  store.updateRequest(request.requestId, { predictionId: prediction.predictionId, predictionVersion: 1, normalized: { ...prediction, conditionalOnly: false, temporalPolicy: 'at_target' } })
  const text = '{"WFIRE":{"name":"Fire Danger Warning","code":"WFIRER","actionCode":"ISSUE","updateTime":"2026-11-21T06:00:00+08:00"}}'
  const source = { evidenceId: 'read', topicId: 'topic', predictionId: 'prediction', url: WARNING_URL, text, sourceMode: 'live', contentHash: 'warning-body', weatherWarning: { completeSnapshot: true } }
  for (const [assignmentId, roleId] of [['a', 'official'], ['b', 'industry']]) { store.recordEvidence(runId, source, assignmentId); store.createAssignment(runId, { assignmentId, roleId }); store.saveAssignment(assignmentId, { status: 'completed', report: { status: 'complete', evidenceIds: ['read'] } }) }
  const candidate = { probabilityYes: .85, summary: '当前状态支持有限推断，未来仍需核验。', evidenceIds: ['read'], evidenceAdequacy: 'limited', dissent: ['缺少第三席完整核验'], outcomeKnown: false, outcome: null,
    reasoningClaims: [{ claim: '截至06:20:42Z快照，代码为WFIRER。', evidenceIds: ['read'], basis: 'fact', citations: [{ evidenceId: 'read', quote: '"code":"WFIRER"' }] }] }
  store.saveRun(runId, { status: 'failed', error: { code: 'MAIN_BUDGET' }, state: { summaryResumeCount: 1, main: { messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'propose_forecast', arguments: JSON.stringify(candidate) } }] }] } } })
  return { store, requestId: request.requestId, runId, prediction, candidate, targetAt, setTime(value) { time = value } }
}

test('revalidation cannot change a recorded probability, bypass expiry or hide the original failed events', () => {
  for (const late of [false, true]) {
    const f = fixture()
    try {
      assert.throws(() => f.store.publishForecast(f.runId, { ...f.candidate, probabilityYes: .99 }, f.prediction, { recoverRecordedCandidate: true }), { code: 'CANDIDATE_RECOVERY_UNAVAILABLE' })
      if (late) { f.setTime('2026-11-21T06:35:30Z'); assert.throws(() => f.store.publishForecast(f.runId, f.candidate, f.prediction, { recoverRecordedCandidate: true }), { code: 'FORECAST_CLOSED' }); assert.equal(f.store.listForecasts().length, 0) }
      else {
        const usage = f.store.getRun(f.runId).usage, result = f.store.publishForecast(f.runId, f.candidate, f.prediction, { recoverRecordedCandidate: true })
        assert.equal(result.probabilityYes, .85); assert.equal(result.publicationMode, 'revalidated-recorded-model-candidate'); assert(Date.parse(result.publishedAt) < Date.parse(f.targetAt)); assert.deepEqual(f.store.getRun(f.runId).usage, usage)
        assert.equal(result.reviewRequired, true); assert(result.reviewReasons.some(reason => reason.includes('核验席')))
        assert(f.store.listEvents({ runId: f.runId }).some(e => e.type === 'forecast.revalidated' && e.payload.originalFailure.code === 'MAIN_BUDGET'))
      }
    } finally { f.store.close() }
  }
})

test('resolution rejects early, late, invalid and simulated sources; a closed result cannot start another run', () => {
  const f = fixture()
  try {
    const original = f.store.publishForecast(f.runId, f.candidate, f.prediction, { recoverRecordedCandidate: true })
    const make = () => ({ url: WARNING_URL, obtainedAt: '2026-11-21T06:35:30Z', sourceMode: 'live', fixture: false, text: '{}', rawJson: '{}' })
    assert.throws(() => f.store.recordWarningResult(f.requestId, make()), { code: 'RESULT_NOT_AVAILABLE' })
    f.setTime('2026-11-21T06:35:30Z')
    assert.throws(() => f.store.recordWarningResult(f.requestId, { ...make(), sourceMode: 'replay', fixture: true }), { code: 'RESULT_PROVENANCE' })
    assert.throws(() => f.store.recordWarningResult(f.requestId, { ...make(), rawJson: '{bad' }), { code: 'RESULT_EVIDENCE' })
    f.setTime('2026-11-21T06:41:00Z'); assert.throws(() => f.store.recordWarningResult(f.requestId, make()), { code: 'RESOLUTION_WINDOW' })
    f.setTime('2026-11-21T06:35:30Z')
    const result = f.store.recordWarningResult(f.requestId, make()); assert.equal(result.outcome, 0); assert.equal(result.scores[0].brier, .85 ** 2)
    assert.equal(f.store.listForecasts()[0].probabilityYes, original.probabilityYes); assert.throws(() => f.store.queueRun(f.requestId), { code: 'REQUEST_CLOSED' })
  } finally { f.store.close() }
})

test('deduplicated text preserves distinct reader observation times without rewriting its first acquisition', () => {
  let time = '2026-11-21T06:20:00Z'
  const store = createCourseStore({ path: ':memory:', now: () => time })
  try {
    const request = store.createRequest({ question: 'test' }), runId = request.activeRunId
    store.saveRun(runId, { topicId: 'topic' })
    const source = { evidenceId: 'shared', topicId: 'topic', url: WARNING_URL, text: '"code":"WFIRER"', contentHash: 'same' }
    store.recordEvidence(runId, source, 'a'); time = '2026-11-21T06:21:00Z'; store.recordEvidence(runId, source, 'b')
    const saved = store.evidenceFor(runId)[0]
    assert.equal(saved.obtainedAt, '2026-11-21T06:20:00Z'); assert.equal(saved.readObservations.length, 2)
    const claim = { claim: '截至06:21:00Z快照，代码为WFIRER。', basis: 'fact', evidenceIds: ['shared'], citations: [{ evidenceId: 'shared', quote: source.text }] }
    assert.equal(validateGroundedClaims([claim], [saved], { readerId: 'b', asOf: time }).length, 1)
    assert.throws(() => validateGroundedClaims([claim], [saved], { readerId: 'a', asOf: time }))
    assert.throws(() => validateGroundedClaims([claim], [saved], { readerId: 'b', asOf: '2026-11-21T06:20:30Z' }))
  } finally { store.close() }
})

test('bounded warning workers keep independent contexts while model execution is serialized', async () => {
  let active = 0, maximum = 0
  await runWarningCase({ onModel: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 4)); active-- } })
  assert.equal(maximum, 1)
})
