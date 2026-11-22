import assert from 'node:assert/strict'
import test from 'node:test'
import { createCourseStore } from './course-store.mjs'
import { groundingPolicy } from '../domain/claim-grounding.mjs'

const NOW = '2026-11-22T08:00:00.000Z', TARGET = '2026-11-24T08:00:00.000Z'
function fixture({ reportStatus = 'complete', mode = 'preset', marker = true, footerOnly = false, partialArtifact = false } = {}) {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  const request = store.createRequest({ question: '虚构城市科技展开幕预测', mode, watch: false, modelMode: 'mock', sourceMode: 'replay', groundingPolicy,
    purpose: 'forecast', budget: { strategy: 'bounded-forecast-v1', ...(marker ? { deliveryPolicy: 'exploratory-estimate-v1' } : {}), maxTotalTokens: 100000 } })
  const runId = request.activeRunId, assignmentId = 'verification_seat', evidenceId = 'source_read'
  const prediction = { predictionId: 'prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    targetAt: TARGET, forecastClosesAt: TARGET, resolutionSource: { url: 'https://example.com/dated-expo-news' } }
  store.saveRun(runId, { topicId: 'topic', phase: 'review' }); store.bindPrediction(runId, prediction.predictionId, 1)
  store.updateRequest(request.requestId, { predictionId: prediction.predictionId, predictionVersion: 1, normalized: { ...prediction, conditionalOnly: false } })
  const text = footerOnly ? '我們保留權利更改本免責聲明並刊登更新版本。' : '【虚构协议新闻】主办方称场地已经交付，设备安装尚未完成，开幕计划仍受进度影响。'
  store.recordEvidence(runId, { evidenceId, topicId: 'topic', predictionId: prediction.predictionId, url: prediction.resolutionSource.url,
    text, contentHash: 'fixture-news', sourceMode: 'replay', fixture: true }, assignmentId)
  const claim = { claim: footerOnly ? '页面只有免责声明，不能确认实际事件状态。' : '根据场地交付与设备进度，开幕仍有条件限制；这不是未来结果已实现。',
    basis: 'inference', evidenceIds: [evidenceId], citations: [{ evidenceId, quote: text }] }
  const modelReport = { resultId: 'model_result', assignmentId, agentSpecId: 'verification', runId, status: reportStatus,
    summary: '虚构协议报告，概率未校准。', probability: .45, evidenceIds: [evidenceId], support: [claim], counterevidence: [], missingEvidence: ['仅一份可引用报道。'] }
  store.createAssignment(runId, { assignmentId, roleId: 'verification' })
  const patch = { status: 'completed', report: modelReport, checkpoint: { usage: { modelRequests: 3, unknownUsage: false } } }
  if (partialArtifact) {
    patch.status = 'failed'
    patch.partialReport = { ...modelReport, status: 'insufficient', delivery: { mode: 'validated-partial-model-report', modelGenerated: true,
      substantiveReportComplete: false, originalStatus: 'complete', originalProbabilityPreserved: true, rejectedCount: 1 } }
    patch.report = { ...modelReport, status: 'blocked', probability: null, support: [], evidenceIds: [], completionMode: 'harness-failure-receipt' }
  }
  store.saveAssignment(assignmentId, patch)
  const candidate = { probabilityYes: .58, summary: '主模型根据有限公开依据作初步条件估计，非真实测试成绩。', evidenceAdequacy: 'limited',
    evidenceIds: [evidenceId], reasoningClaims: [claim], decisionNotes: [{ assignmentId, disposition: 'qualified', reason: '保留有限资料及未核验缺口。', evidenceIds: [evidenceId] }] }
  return { store, runId, prediction, candidate, assignmentId }
}

for (const reportStatus of ['complete', 'insufficient']) test('preset single ' + reportStatus + ' grounded model estimate publishes only as provisional and unscored', () => {
  const f = fixture({ reportStatus })
  try {
    const value = f.store.publishForecast(f.runId, f.candidate, f.prediction)
    assert.equal(value.probabilityYes, .58)
    assert.equal(value.publicationMode, 'model-provisional-estimate')
    assert.equal(value.kind, 'conditional_estimate')
    assert.equal(value.reviewRequired, true)
    assert.equal(value.scoringEligible, false)
    assert.equal(value.reportAdequacy.eligibleRoleCount, 1)
    assert.equal(value.reportAdequacy.partialRoleCount, reportStatus === 'insufficient' ? 1 : 0)
    assert.equal(value.reportAdequacy.preliminary, true)
    assert.equal(f.store.listAssignments(f.runId)[0].report.status, reportStatus)
    assert.equal(value.decisionNotes[0].disposition, 'qualified')
  } finally { f.store.close() }
})

test('an audited model partial can contribute without turning its failed task or program receipt into a complete report', () => {
  const f = fixture({ partialArtifact: true })
  try {
    const value = f.store.publishForecast(f.runId, f.candidate, f.prediction)
    assert.equal(value.publicationMode, 'model-provisional-estimate')
    assert.equal(value.scorecard[0].reportOrigin, 'partialReport')
    assert.equal(value.scorecard[0].quality, 'partial')
    assert.equal(value.scorecard[0].probabilityYes, .45)
    assert.equal(f.store.listAssignments(f.runId)[0].status, 'failed')
    assert.equal(f.store.listAssignments(f.runId)[0].report.status, 'blocked')
  } finally { f.store.close() }
})

test('access-only quotes cannot pass the exploratory entity-evidence guard', () => {
  const f = fixture({ footerOnly: true })
  try {
    assert.throws(() => f.store.publishForecast(f.runId, f.candidate, f.prediction), { code: 'REPORTS_INSUFFICIENT' })
    assert.equal(f.store.listForecasts().length, 0)
  } finally { f.store.close() }
})

test('strict and pre-marker bounded runs still require the original multi-role publication standard', () => {
  for (const settings of [{ mode: 'strict' }, { marker: false }]) {
    const f = fixture(settings)
    try {
      assert.throws(() => f.store.publishForecast(f.runId, f.candidate, f.prediction), { code: 'REPORTS_INSUFFICIENT' })
      assert.equal(f.store.listForecasts().length, 0)
    } finally { f.store.close() }
  }
})
