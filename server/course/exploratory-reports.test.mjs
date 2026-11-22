import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPLORATORY_DELIVERY_POLICY, isExploratoryForecast, selectExploratoryReports } from './exploratory-reports.mjs'

const NOW = '2026-11-22T10:00:00.000Z', RUN = 'run_example'
const options = { asOf: NOW, runId: RUN }
function fixture(roleId = 'market', { status = 'complete', probability = .49, quote = '虚构公司的公开资料显示收入保持增长，未来走势仍有不确定性。', id = roleId } = {}) {
  const assignmentId = 'assignment_' + id, evidenceId = 'evidence_' + id
  const claim = { claim: roleId + '席根据已读资料作有局限的方向推断。', basis: 'inference', evidenceIds: [evidenceId], citations: [{ evidenceId, quote }] }
  const item = { assignmentId, roleId, runId: RUN, status: 'completed', usage: { modelRequests: 3, unknownUsage: false },
    report: { resultId: 'model_' + id, assignmentId, agentSpecId: roleId, runId: RUN, status, summary: '模型报告', probability,
      support: [claim], counterevidence: [], evidenceIds: [evidenceId], missingEvidence: ['数值基准尚未由系统核定。'] } }
  const source = { evidenceId, runId: RUN, readBy: [assignmentId], text: quote, sourceMode: 'live', evidenceKind: 'page_text',
    referenceable: true, obtainedAt: '2026-11-22T09:00:00.000Z', publishedAt: '2026-11-21T09:00:00.000Z', focusMatched: false }
  return { item, source }
}
function partial(item, { originalStatus = 'complete' } = {}) {
  const value = structuredClone(item.report)
  value.status = 'insufficient'
  value.delivery = { mode: 'validated-partial-model-report', modelGenerated: true, substantiveReportComplete: false,
    originalStatus, originalProbabilityPreserved: true, rejectedCount: 1, rejectedReasons: [{ path: 'support/1', reason: '引用未覆盖数字' }] }
  return value
}

test('the new delivery policy is explicit, preset-only, and never changes strict, research, fixed-rule or legacy runs', () => {
  const run = { budget: { deliveryPolicy: EXPLORATORY_DELIVERY_POLICY } }
  assert.equal(isExploratoryForecast(run, { mode: 'preset', purpose: 'forecast' }), true)
  for (const request of [{ mode: 'strict' }, { mode: 'preset', purpose: 'research' }, { mode: 'preset', resolutionPolicy: { version: 'fixed' } }, {}]) assert.equal(isExploratoryForecast(run, request), false)
  assert.equal(isExploratoryForecast({ budget: {} }, { mode: 'preset' }), false)
})

test('a single grounded partial probability remains partial and usable without inventing probability or a verified baseline', () => {
  const { item, source } = fixture('verification', { status: 'insufficient', probability: .45 })
  const before = structuredClone(item)
  const value = selectExploratoryReports([item], [source], options)
  assert.equal(value.roleCount, 1)
  assert.equal(value.partialRoleCount, 1)
  assert.equal(value.completeRoleCount, 0)
  assert.equal(value.usable[0].quality, 'partial')
  assert.equal(value.usable[0].report.status, 'insufficient')
  assert.equal(value.usable[0].report.probability, .45)
  assert.equal(value.usable[0].reportOrigin, 'report')
  assert.equal(value.usable[0].eligibleReason, 'grounded_partial_model_estimate')
  assert(value.usable[0].gaps.some(gap => gap.includes('基准')))
  assert.equal(Object.hasOwn(value, 'probabilityYes'), false)
  assert.deepEqual(item, before)
})

test('footer-only updates, disclaimers, cookie notices and access errors are source limitations rather than event evidence', () => {
  for (const quote of ['更新日期為: 2026年2月9日', 'Updated: 20 Nov 2026 16:08 HKT', '我們保留權利不時更改本免責聲明並於本網站／應用程式刊登更新版本。',
    'By continuing to use this website, you agree to our use of cookies.', 'All rights reserved. Privacy policy.', 'HTTP 404 Not Found']) {
    const { item, source } = fixture('official', { status: 'insufficient', quote })
    const value = selectExploratoryReports([item], [source], options)
    assert.equal(value.roleCount, 0, quote)
    assert.equal(value.rejected[0].eligibleReason, 'no_substantive_evidence', quote)
    assert.equal(value.sourceLimitations.length, 1, quote)
  }
})

test('a focus miss or appended footer does not erase a substantive price or news excerpt', () => {
  const { item, source } = fixture('market', { quote: '腾讯控股报340.6港元，报道当时股价下跌2.24%。\n我們保留權利更改本免責聲明。' })
  const value = selectExploratoryReports([item], [source], options)
  assert.equal(source.focusMatched, false)
  assert.equal(value.roleCount, 1)
  assert.equal(value.usable[0].substantiveClaims.length, 1)
})

test('a Yahoo profile quoted only to describe missing page data stays a source limitation, while a company nondisclosure remains an entity fact', () => {
  const profile = fixture('market', { quote: 'Tencent Holdings Limited provides value-added services, marketing services, fintech, and business services.' })
  profile.item.report.support[0].claim = 'Yahoo Finance的腾讯页面仅返回公司简介，未给出价格或前收数字，未取得第二来源交叉验证。'
  const limited = selectExploratoryReports([profile.item], [profile.source], options)
  assert.equal(limited.roleCount, 0)
  assert.equal(limited.rejected[0].eligibleReason, 'no_substantive_evidence')
  assert.equal(limited.sourceLimitations[0].claim, profile.item.report.support[0].claim)
  const nondisclosure = fixture('official', { quote: '公司尚未发布最新财报，董事会表示将另行公布审议日期。' })
  nondisclosure.item.report.support[0].claim = '公司尚未发布最新财报，审议日期有待董事会公布。'
  assert.equal(selectExploratoryReports([nondisclosure.item], [nondisclosure.source], options).roleCount, 1)
})

test('the audited partial model artifact may be used instead of a program receipt without modifying either stored artifact', () => {
  const { item, source } = fixture('verification')
  item.partialReport = partial(item)
  item.report = { ...item.report, probability: null, support: [], counterevidence: [], evidenceIds: [],
    delivery: { mode: 'harness-budget-closeout', modelGenerated: false, substantiveReportComplete: false, usageKnown: true } }
  const before = structuredClone(item)
  const value = selectExploratoryReports([item], [source], options)
  assert.equal(value.roleCount, 1)
  assert.equal(value.usable[0].reportOrigin, 'partialReport')
  assert.equal(value.usable[0].quality, 'partial')
  assert.equal(value.usable[0].report.status, 'insufficient')
  assert.equal(value.usable[0].report.probability, .49)
  assert.equal(value.rejected[0].eligibleReason, 'program_receipt')
  assert.deepEqual(item, before)
  assert.notEqual(value.usable[0].report, item.partialReport)
})

test('missing partial audits, blocked reports, generated receipts and unknown usage cannot be relabelled usable', () => {
  const mutations = [
    item => { item.report.generatedBy = 'harness' },
    item => { item.report.completionMode = 'harness-failure-receipt' },
    item => { item.report.status = 'blocked' },
    item => { item.usage.unknownUsage = true },
    item => { item.checkpoint = { usage: { unknownUsage: true } } },
    item => { item.partialReport = partial(item); item.partialReport.delivery.modelGenerated = false; item.report = null },
    item => { item.partialReport = partial(item); delete item.partialReport.delivery.rejectedCount; item.report = null },
    item => { item.partialReport = partial(item, { originalStatus: 'blocked' }); item.report = null },
  ]
  for (const mutate of mutations) {
    const { item, source } = fixture(); mutate(item)
    assert.equal(selectExploratoryReports([item], [source], options).roleCount, 0)
  }
  const { item, source } = fixture()
  assert.equal(selectExploratoryReports([item], [source], { ...options, unknownUsage: true }).roleCount, 0)
})

test('a failed task may expose its audited partial model artifact without being relabelled completed', () => {
  const { item, source } = fixture('verification')
  item.partialReport = partial(item)
  item.status = 'failed'; item.report = null
  const before = structuredClone(item)
  const value = selectExploratoryReports([item], [source], options)
  assert.equal(value.roleCount, 1)
  assert.equal(value.usable[0].status, 'failed')
  assert.equal(value.usable[0].reportOrigin, 'partialReport')
  assert.equal(value.usable[0].quality, 'partial')
  assert(value.usable[0].gaps.some(gap => gap.includes('该任务未完整完成')))
  assert.deepEqual(item, before)
  for (const status of ['cancelled', 'running', 'queued', 'blocked']) {
    item.status = status
    assert.equal(selectExploratoryReports([item], [source], options).roleCount, 0)
  }
  item.status = 'failed'; item.usage.unknownUsage = true
  assert.equal(selectExploratoryReports([item], [source], options).roleCount, 0)
  delete item.usage
  assert.equal(selectExploratoryReports([item], [source], options).roleCount, 0)
})

test('no model probability, missing model provenance, unread snippets, future sources and ungrounded numeric facts remain unusable', () => {
  const mutations = [
    (item) => { item.report.probability = null },
    (item) => { item.report.probability = 1.2 },
    (item) => { delete item.report.resultId },
    (item) => { item.report.assignmentId = 'foreign' },
    (_item, source) => { source.readBy = ['other_worker'] },
    (_item, source) => { source.runId = 'foreign_run' },
    (_item, source) => { source.evidenceKind = 'search_snippet'; source.referenceable = false },
    (_item, source) => { source.obtainedAt = '2026-11-23T09:00:00.000Z' },
    (_item, source) => { source.publishedAt = '2026-11-23T09:00:00.000Z' },
    item => { item.report.support[0].basis = 'fact'; item.report.support[0].claim = '原文确认价格为9999港元。' },
  ]
  for (const mutate of mutations) {
    const { item, source } = fixture(); mutate(item, source)
    assert.equal(selectExploratoryReports([item], [source], options).roleCount, 0)
  }
  const { item, source } = fixture()
  assert.equal(selectExploratoryReports([item], [source], {}).rejected[0].eligibleReason, 'invalid_cutoff')
})

test('latest usable estimates count once per role, while an unusable follow-up does not silently replace earlier partial evidence', () => {
  const first = fixture('verification', { status: 'insufficient', probability: .45, id: 'first' })
  const later = fixture('verification', { probability: .6, id: 'later' })
  const before = selectExploratoryReports([first.item, later.item], [first.source, later.source], options)
  assert.equal(before.roleCount, 1)
  assert.equal(before.usable[0].assignmentId, later.item.assignmentId)
  later.item.report.delivery = { mode: 'harness-budget-closeout', modelGenerated: false }
  const after = selectExploratoryReports([first.item, later.item], [first.source, later.source], options)
  assert.equal(after.roleCount, 1)
  assert.equal(after.partialRoleCount, 1)
  assert.equal(after.usable[0].assignmentId, first.item.assignmentId)
  assert.equal(after.usable[0].latestAttemptRejected, true)
  assert(after.usable[0].gaps.some(gap => gap.includes('并非后续核验已成功')))
})
