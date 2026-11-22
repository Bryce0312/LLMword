import test from 'node:test'
import assert from 'node:assert/strict'
import { createCourseStore } from './course-store.mjs'

const NOW = '2026-11-22T00:00:00.000Z'
function fixture(t, { exploratory = true, substantiveVerification = false, acceptVerification = false } = {}) {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  t.after(() => store.close())
  const request = store.createRequest({ question: 'Is the defined event likely?', purpose: 'forecast', mode: exploratory ? 'preset' : 'strict',
    modelMode: 'live', sourceMode: 'live', groundingPolicy: 'quoted-claims-v1',
    budget: { strategy: 'bounded-forecast-v1', maxTotalTokens: 100000, ...(exploratory ? { deliveryPolicy: 'exploratory-estimate-v1' } : {}) } })
  const runId = request.activeRunId
  const prediction = { predictionId: 'prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    targetAt: '2026-11-24T00:00:00.000Z', forecastClosesAt: '2026-11-24T00:00:00.000Z', resolutionSource: { url: 'https://example.com/official' } }
  store.saveRun(runId, { status: 'running', topicId: 'topic', predictionId: prediction.predictionId, predictionVersion: 1 })
  store.updateRequest(request.requestId, { normalized: { baseline: { value: 100, verified: true }, conditionalOnly: false } })
  const rows = [
    ['market', 'The company reported a completed acquisition.'],
    ['official', 'The board published an official business update.'],
    ['verification', substantiveVerification ? 'The regulator independently confirmed the announced company transaction.' : 'All rights reserved. This website uses cookies.'],
  ]
  const claims = []
  for (const [roleId, text] of rows) {
    const assignmentId = 'assignment-' + roleId, evidenceId = 'evidence-' + roleId
    const claim = { claim: roleId === 'verification' && !substantiveVerification ? 'The page contains a copyright notice.' : text,
      basis: 'fact', evidenceIds: [evidenceId], citations: [{ evidenceId, quote: text }] }
    claims.push(claim)
    store.createAssignment(runId, { assignmentId, roleId })
    store.recordEvidence(runId, { evidenceId, topicId: 'topic', predictionId: prediction.predictionId,
      text, url: roleId === 'official' ? prediction.resolutionSource.url : 'https://example.com/' + roleId,
      title: roleId, contentHash: evidenceId, sourceMode: 'live' }, assignmentId)
    store.saveAssignment(assignmentId, { status: 'completed', report: { status: 'complete', summary: text, probability: .6,
      evidenceIds: [evidenceId], support: [claim], counterevidence: [], missingEvidence: [], nextSuggestion: 'Review the remaining uncertainty.',
      resultId: 'result-' + roleId, runId, assignmentId, agentSpecId: roleId } })
  }
  const adopted = rows.filter(([role]) => role !== 'verification' || acceptVerification).map(([role]) => role)
  const candidate = { probabilityYes: .6, summary: 'An isolated store-guard test with explicitly accepted model reports.',
    evidenceIds: adopted.map(role => 'evidence-' + role), reasoningClaims: claims.filter(claim => adopted.some(role => claim.evidenceIds.includes('evidence-' + role))),
    decisionNotes: rows.map(([role]) => ({ assignmentId: 'assignment-' + role, disposition: adopted.includes(role) ? 'adopted' : 'rejected',
      reason: 'Explicit guard-test decision.', evidenceIds: adopted.includes(role) ? ['evidence-' + role] : [] })) }
  return { store, runId, prediction, candidate }
}

test('two complete substantive seats cannot hide an unusable raw-complete verification seat', t => {
  const f = fixture(t)
  const published = f.store.publishForecast(f.runId, f.candidate, f.prediction)
  assert.equal(published.reportAdequacy.completeRoleCount, 2)
  assert.equal(published.reportAdequacy.preliminary, false)
  assert.equal(published.reviewRequired, true)
  assert.equal(published.scoringEligible, false)
  assert(published.reviewReasons.some(reason => reason.includes('实质原文核验报告')))
  assert.equal(published.scorecard.some(item => item.roleId === 'verification'), false)
})

test('a complete substantive verification report must actually be adopted or qualified to count as final review', t => {
  const f = fixture(t, { substantiveVerification: true })
  const published = f.store.publishForecast(f.runId, f.candidate, f.prediction)
  assert.equal(published.reportAdequacy.completeRoleCount, 3)
  assert.equal(published.reviewRequired, true)
  assert.equal(published.scoringEligible, false)
})

test('accepted complete substantive verification keeps the ordinary scoring and review eligibility', t => {
  const f = fixture(t, { substantiveVerification: true, acceptVerification: true })
  const published = f.store.publishForecast(f.runId, f.candidate, f.prediction)
  assert.equal(published.reviewRequired, false)
  assert.deepEqual(published.reviewReasons, [])
  assert.equal(published.scoringEligible, true)
})

test('nonmarker strict runs retain their prior review contract', t => {
  const f = fixture(t, { exploratory: false })
  const published = f.store.publishForecast(f.runId, f.candidate, f.prediction)
  assert.equal(published.reviewRequired, false)
  assert.equal(published.scoringEligible, true)
  assert.equal(published.reportAdequacy, undefined)
})
