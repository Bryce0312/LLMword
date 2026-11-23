import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverCourseBudgetRequest, recoverCourseBudgetRun } from './course-budget-summary.mjs'
import { courseRequestProgress } from './course-status.mjs'
import { courseRequestFailure } from './course-errors.mjs'

const obtainedAt = '2026-11-22T09:17:45Z'
const updatedAt = '2026-11-22T09:18:31Z'
const failed = {
  requestId: 'apple', runId: 'first', status: 'failed', updatedAt,
  budget: { maxTotalTokens: 100000 }, usage: { totalTokens: 115173 },
  error: { code: 'COURSE_BUDGET', message: '本轮已达到总 token 预算。' },
  assignments: [
    { assignmentId: 'market', name: '市场', status: 'completed', report: { status: 'insufficient', summary: '缺少核验报价', evidenceIds: ['old', 'future', 'other'] } },
    { assignmentId: 'verify', name: '核验', status: 'failed' },
  ],
  evidence: [
    { evidenceId: 'old', text: '原文', readBy: ['market'], obtainedAt },
    { evidenceId: 'future', text: '迟到原文', readBy: ['market'], obtainedAt: '2026-11-22T09:19:00Z' },
    { evidenceId: 'other', text: '其他席位已读', readBy: ['verify'], obtainedAt },
  ],
}

test('legacy token failure shows existing cited material and preserves the original failed record', () => {
  const record = { requestId: 'apple', purpose: 'forecast', status: 'failed', forecast: null, latestRun: failed, runs: [failed] }
  const original = structuredClone(record)
  const projected = recoverCourseBudgetRequest(record)
  assert.deepEqual(record, original)
  assert.equal(projected.latestRun.status, 'failed')
  assert.equal(projected.forecast, null)
  const summary = projected.latestRun.budgetSummary
  assert.equal(summary.recovered, true)
  assert.deepEqual(summary.evidenceIds, ['old', 'other'])
  assert.deepEqual(summary.reports[0].evidenceIds, ['old'])
  assert.deepEqual(summary.unfinished.map(item => item.name), ['核验'])
  assert.equal(courseRequestProgress(projected).label, '预算用尽，已整理材料')
  assert.equal(courseRequestFailure(projected), null)
})

test('call-count errors, research failures and current budget summaries keep their original state', () => {
  const below = { ...failed, usage: { totalTokens: 2000 } }
  const current = { ...failed, budgetSummary: { summary: '服务端已保存' } }
  assert.equal(recoverCourseBudgetRun(below, 'forecast'), below)
  assert.equal(recoverCourseBudgetRun(failed, 'research'), failed)
  assert.equal(recoverCourseBudgetRun(current, 'forecast'), current)
})
