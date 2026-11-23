import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseTranslations, courseDynamicRules } from './locale-zh-en-course.mjs'
import { translateUiText } from './locale.mjs'
import { coursePhaseLabel, courseWorkflowView, courseModelStatusView, courseUsageText } from './course-workflow.mjs'
import { courseStatusLabel } from './course-status.mjs'
import { courseRunLabel, courseAnswerProvenance } from './course-runs.mjs'
import { courseMemoryPolicyLines } from './course-memory.mjs'
import { courseErrorPresentation, courseRequestAction } from './course-errors.mjs'
import { assembleBudgetSummary } from './course-budget-summary.mjs'
import { directionText } from './course-price-direction.mjs'
import { buildForecastFacts, forecastStatusLabel } from '../server/course/forecast-facts.mjs'

const noChinese = text => { const translated = translateUiText(text, 'en'); assert.doesNotMatch(translated, /[\p{Script=Han}]/u, text); return translated }
const assignment = { assignmentId: 'a', roleId: 'verification', name: '保存预算', status: 'running' }
const run = extra => ({ requestId: 'q', runId: 'r', status: 'running', phase: 'workers', harnessVersion: 3, orchestration: { cycle: 2, maxCycles: 3 }, assignments: [assignment], events: [], ...extra })

test('course system phase, usage, round and model-status templates translate across actual helper outputs', () => {
  for (const phase of ['intake', 'workers', 'followup', 'prepare', 'review', 'watch_check', 'triage', 'plan']) {
    for (const version of [2, 3]) {
      const snapshot = run({ phase, harnessVersion: version, events: [{ runId: 'r', seq: 1, type: 'model.requested', payload: { assignmentId: 'a', roleId: 'verification', modelRequestId: 'm', index: 3 } }] })
      noChinese(coursePhaseLabel(snapshot))
      const view = courseWorkflowView(snapshot)
      for (const text of [view.status, view.versionLabel, view.flow, ...view.rows.map(row => row.activityText)]) noChinese(text)
      assert.equal(view.rows[0].name, '保存预算', 'saved researcher names are preserved data')
      noChinese(courseRunLabel(snapshot, 2))
    }
  }
  for (const status of ['queued', 'preparing', 'normalizing', 'researching', 'running', 'active', 'watching', 'ready', 'completed', 'failed', 'stopped', 'closed', 'needs_clarification', 'insufficient', 'blocked', 'cancelled']) noChinese(courseStatusLabel(status))
  for (const status of ['waiting', 'failed', 'returned']) { noChinese(courseModelStatusView({ index: 3, status }).text); noChinese(courseModelStatusView({ status }).text) }
  noChinese('模型 ' + courseUsageText(2, 20, ' 次') + ' · 工具 ' + courseUsageText(null, null, ' 次') + ' · token ' + courseUsageText(32000, null, '', { unlimited: true }))
  noChinese('周期 2 · 模型 3 / 12 次 · 工具 1 / 7 次')
  noChinese('第 2 个调查周期 / 最多 3 个 · 争议补查 1 / 2 次')
  noChinese(directionText({ probabilityUp: .5, probabilityFlat: .3, probabilityDown: .2 }))
})

test('provenance, memory and program-generated budget summaries translate without rewriting saved snapshots', () => {
  const first = run({ status: 'completed', assignments: [{ ...assignment, status: 'completed' }] })
  const check = run({ runId: 'check', status: 'completed', assignments: [], trigger: 'watch', triage: { kind: 'no_change' } })
  const snapshot = { requestId: 'q', forecast: { runId: 'r' }, runs: [first, check], latestRunId: 'check' }
  const before = structuredClone(snapshot)
  noChinese(courseAnswerProvenance(snapshot).summary)
  noChinese('房间当前显示：' + courseRunLabel(first, 0) + '，对应当前答案的协作过程。')
  noChinese(courseAnswerProvenance({ requestId: 'q', runs: [] }).summary)
  noChinese(courseAnswerProvenance({ requestId: 'q', runs: [{ ...first, directionOutlook: { direction: 'up' } }] }).summary)
  const policy = { policy: { shortTermDays: 7, maxJudgments: 4, maxReports: 20, longTermDays: 90, maxRelations: 40, maxEvidence: 60, retrievalIsNotDeletion: true, historicalEvidenceRequiresRefresh: true } }
  for (const line of courseMemoryPolicyLines(policy)) noChinese(line)
  for (const recovered of [true, false]) noChinese(assembleBudgetSummary([], [], '2026-11-23T00:00:00Z', 'model原文', { recovered }).summary)
  assert.deepEqual(snapshot, before)
})

test('safe error and recovery labels translate, while an unknown raw detail remains explicitly data', () => {
  const codes = ['MODEL_BALANCE_REQUIRED', 'SOURCE_BALANCE_REQUIRED', 'MODEL_AUTH_FAILED', 'SOURCE_AUTH_FAILED', 'MODEL_ACCESS_DENIED', 'SOURCE_ACCESS_DENIED', 'MODEL_RATE_LIMITED', 'MODEL_SERVICE_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_NETWORK', 'MODEL_INCOMPLETE', 'MODEL_NOT_CONFIGURED']
  for (const code of codes) {
    const presentation = courseErrorPresentation({ code, message: '保存预算', retryAfterMs: 1500 })
    assert.equal(presentation.detailIsSystem, true)
    for (const text of [presentation.title, presentation.detail, presentation.nextStep, presentation.waitHint].filter(Boolean)) noChinese(text)
  }
  const unknown = courseErrorPresentation({ code: 'UNKNOWN', message: '保存预算' })
  assert.equal(unknown.detail, '保存预算'); assert.equal(unknown.detailIsSystem, false)
  for (const record of [{ requestId: 'q', deleted: true }, { requestId: 'q', status: 'stopped' }, { requestId: 'q', status: 'failed', latestRun: { requestId: 'q', runId: 'r', status: 'failed' } }]) {
    const action = courseRequestAction(record)
    noChinese(action.label); if (action.reason) noChinese(action.reason)
  }
})

test('course rules are anchored to known UI forms and leave original arbitrary text untouched', () => {
  assert(Object.keys(courseTranslations).length > 100)
  for (const rule of courseDynamicRules) { assert(rule.pattern.source.startsWith('^')); assert(rule.pattern.source.endsWith('$')) }
  for (const original of ['用户问题：腾讯上涨概率如何', '模型报告：第 2 轮 · 失败，仍需核验', '原始证据提到模型 2 / 20 次 · 工具 1 / 10 次']) assert.equal(translateUiText(original, 'en'), original)
})


test('deterministic forecast facts and scoring labels translate without treating numeric baselines as prose', () => {
  for (const kind of ['forecast', 'conditional_estimate']) for (const scoringEligible of [true, false]) {
    noChinese(forecastStatusLabel({ kind, scoringEligible, baselineVerified: false }))
    for (const fact of buildForecastFacts({ kind, scoringEligible, baseline: null })) { noChinese(fact.label); noChinese(fact.text) }
  }
  for (const label of ['协议模拟或回放资料结果，不是真实预测', '模型事件概率估计', '程序汇集的研究员概率估计（主Agent未完成最终裁决）', '有公开依据的初步条件估计（资料有限，需复核）', '单题Brier，不代表总体准确率', '模拟协议分数，不计真实成绩', '（系统观测）']) noChinese(label)
})
