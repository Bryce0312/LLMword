import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coursePhaseLabel, courseWorkflowView, courseModelActivity, courseUsageText, courseModelStatusView } from './course-workflow.mjs'
import { courseRequestProgress } from './course-status.mjs'
import { createCourseProjection, projectCourseSnapshot } from './course-projection.mjs'

const assigned = (roleId, extra = {}) => ({ assignmentId: 'a-' + roleId, roleId, status: 'running', usage: { modelRequests: 3, toolCalls: 2, totalTokens: 1200 }, ...extra })
const event = (seq, type, payload = {}) => ({ seq, eventId: 'e' + seq, type, payload: { assignmentId: 'a-statistics', agentSpecId: 'statistics', ...payload } })
const run = (extra = {}) => ({ runId: 'r', requestId: 'q', status: 'running', phase: 'workers', assignments: [assigned('statistics'), assigned('industry'), assigned('verification')], events: [], ...extra })
const orchestration = { cycle: 2, maxCycles: 3, followUpsUsed: 1, maxFollowUps: 2, investigationSteps: 5, reportStep: 6 }

test('new workflow describes dispatch, contract verification and distinct investigation cycles; old run is not relabelled', () => {
  const old = courseWorkflowView(run({ harnessVersion: 2, phase: 'prepare' }))
  assert.equal(old.status, '正在整理问题与寻找来源')
  assert.equal(old.versionLabel, '本轮使用旧版流程')
  assert.equal(old.cycle, null)
  assert.equal(old.maxFollowUps, null)
  const v3 = run({ harnessVersion: 3, orchestration })
  assert.equal(coursePhaseLabel({ ...v3, phase: 'intake' }), '主 Agent 整理题意并立即派工')
  assert.equal(coursePhaseLabel({ ...v3, phase: 'prepare' }), '主 Agent 根据子 Agent 的资料核定题目')
  assert.equal(coursePhaseLabel({ ...v3, phase: 'review' }), '第 2 个调查周期 · 汇报与质询，决定是否补查或总结')
  const view = courseWorkflowView(v3)
  assert.equal(view.cycle, 2)
  assert.equal(view.rows[0].usage.modelRequests, 3)
  assert.equal(view.investigationSteps, 5)
  assert.equal(view.reportStep, 6)
})

test('active worker count replaces a stale main-only impression and budgets come only from that run', () => {
  const current = run({ harnessVersion: 2 })
  const progress = courseRequestProgress({ requestId: 'q', activeRunId: 'r', run: current })
  assert.equal(progress.label, '3 位子 Agent 正在独立调查；主 Agent 等待报告')
  const unknownBudget = courseWorkflowView(current)
  assert.equal(unknownBudget.budget.maxModelRequests, null)
  assert.equal(unknownBudget.rows[0].budget.maxModelRequests, null)
  assert.equal(courseUsageText(null, 6, ' 次'), '未记录')
  assert.equal(courseUsageText(3, null, ' 次'), '3 次')
  const measured = courseWorkflowView(run({ budget: { maxModelRequests: 40 }, usage: { modelRequests: 13 }, assignments: [assigned('statistics', { cycle: 2, budget: { maxModelRequests: 6 } })] }))
  assert.equal(measured.budget.maxModelRequests, 40)
  assert.equal(measured.rows[0].cycle, 2)
  assert.equal(courseUsageText(measured.rows[0].usage.modelRequests, measured.rows[0].budget.maxModelRequests, ' 次'), '3 / 6 次')
})

test('only an explicitly usable scored partial report is labelled as limited evidence', () => {
  const partial = { status: 'insufficient', probability: .48, evidenceIds: ['owned-source'] }
  const activity = (extra) => courseWorkflowView(run({ status: 'completed', assignments: [assigned('statistics', {
    status: 'completed', report: { status: 'insufficient', probability: .48 }, ...extra })] })).rows[0].activityText
  assert.equal(activity({ usableReport: partial }), '已有依据，资料有限')
  assert.equal(activity({ status: 'failed', usableReport: partial }), '未完整，部分依据已保留')
  for (const probability of [0, 1]) assert.equal(activity({ usableReport: { ...partial, probability } }), '已有依据，资料有限')
  for (const usableReport of [undefined, null, { ...partial, probability: null }, { ...partial, probability: NaN },
    { ...partial, probability: 1.2 }, { ...partial, evidenceIds: [] }, { ...partial, evidenceIds: undefined }]) {
    assert.equal(activity({ usableReport }), '资料不足', 'Missing, invalid or unevidenced estimates retain the original insufficient label')
  }
  assert.equal(activity({ report: { status: 'complete' } }), '报告已提交')
  assert.equal(activity({ status: 'failed', report: null }), '执行失败')
})

test('report correction allowance comes from this saved run, while older workflows remain unknown', () => {
  const current = courseWorkflowView(run({ harnessVersion: 3, orchestration: { ...orchestration, investigationSteps: 6, reportStep: 7, reportRepairRequests: 2 } }))
  assert.equal(current.investigationSteps, 6); assert.equal(current.reportStep, 7)
  assert.equal(current.reportRepairRequests, 2)
  assert.equal(courseWorkflowView(run({ harnessVersion: 3, orchestration })).reportRepairRequests, null)
  assert.equal(courseWorkflowView(run({ harnessVersion: 2, orchestration: { ...orchestration, reportRepairRequests: 2 } })).reportRepairRequests, null)
})

test('inflight model activity survives refresh as state, not replayed speech or invented reasoning', () => {
  const snapshot = run({ events: [event(1, 'model.requested', { modelRequestId: 'm3', index: 3, summary: 'PRIVATE REASONING MUST NOT BE DISPLAYED' })] })
  const view = courseWorkflowView(snapshot)
  assert.equal(view.rows[0].waiting, true)
  assert.equal(view.rows[0].activityText, '等待模型返回 · 第 3 次判断')
  assert(!JSON.stringify(view).includes('PRIVATE'))
  const restored = projectCourseSnapshot(createCourseProjection({ requestId: 'q' }), snapshot)
  assert.equal(restored.effects.find(e => e.type === 'restore').modelActivity[0].status, 'waiting')
  assert.equal(restored.effects.some(e => e.type === 'speech'), false)
  assert.deepEqual(projectCourseSnapshot(restored.state, snapshot).effects, [])
})

test('live requested/completed/failed model events only produce model-state effects and clear waiting', () => {
  let projected = projectCourseSnapshot(createCourseProjection(), run({ events: [event(1, 'model.requested', { modelRequestId: 'm1', index: 1 })] }), { fresh: true })
  assert.equal(projected.effects.find(e => e.type === 'model').status, 'waiting')
  for (const type of ['model.completed', 'model.failed']) {
    const snapshot = run({ events: [event(1, 'model.requested', { modelRequestId: 'm1', index: 1 }), event(2, type, { modelRequestId: 'm1', index: 1, elapsedMs: 8800 })] })
    const result = projectCourseSnapshot(projected.state, snapshot)
    assert.equal(result.effects.some(e => e.type === 'speech'), false)
    assert.equal(result.effects.find(e => e.type === 'model').status, type === 'model.completed' ? 'returned' : 'failed')
    assert.equal(courseWorkflowView(snapshot).rows[0].waiting, false)
  }
})

test('foreign, unassigned and previous-assignment model events cannot create waiting actors', () => {
  const snapshot = run({ assignments: [assigned('statistics', { assignmentId: 'followup' })], events: [
    event(1, 'model.requested', { modelRequestId: 'old', index: 4 }),
    { ...event(2, 'model.requested', { modelRequestId: 'foreign', assignmentId: 'followup' }), runId: 'another-run' },
    event(3, 'model.requested', { modelRequestId: 'unknown', assignmentId: 'not-assigned', agentSpecId: 'social' }),
  ] })
  assert.deepEqual(courseModelActivity(snapshot), [])
  assert.equal(courseWorkflowView(snapshot).rows[0].waiting, false)
  for (const status of ['completed', 'failed', 'cancelled']) {
    const ended = run({ status, events: [event(1, 'model.requested', { modelRequestId: 'm3', index: 3 })] })
    assert.equal(courseWorkflowView(ended).rows[0].waiting, false)
  }
})

test('each role retains its own waiting request, and new activity restores the aggregate room phase', () => {
  const initial = run({ events: [event(1, 'model.requested', { modelRequestId: 'market-1', assignmentId: 'a-industry', agentSpecId: 'industry', index: 1 })] })
  const previous = projectCourseSnapshot(createCourseProjection(), initial, { fresh: true })
  const snapshot = run({ events: [...initial.events,
    event(2, 'tool.started', { toolId: 'fetch_page' }),
    event(3, 'model.requested', { modelRequestId: 'statistics-2', index: 2 }),
    event(4, 'model.completed', { modelRequestId: 'statistics-1', index: 1 }),
    event(5, 'model.requested', { modelRequestId: 'verification-1', assignmentId: 'a-verification', agentSpecId: 'verification', index: 1 }),
  ] })
  assert.equal(courseModelActivity(snapshot).filter(a => a.status === 'waiting').length, 3)
  const next = projectCourseSnapshot(previous.state, snapshot)
  assert.equal(next.effects.at(-1).type, 'phase')
  assert(next.effects.at(-1).summary.includes('3 位等待模型返回'))
  assert.deepEqual(projectCourseSnapshot(next.state, snapshot).effects, [])
})

test('terminal restore clears every waiting badge and model text, even if a late request is the last saved model event', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'insufficient']) {
    const assignments = [assigned('statistics', { status: 'completed' }), assigned('industry', { status: 'completed' }), assigned('verification', { status: 'completed' })]
    const events = assignments.flatMap((a, index) => [
      event(index * 3 + 1, 'model.requested', { assignmentId: a.assignmentId, agentSpecId: a.roleId, modelRequestId: a.roleId + '-1', index: 1 }),
      event(index * 3 + 2, 'model.completed', { assignmentId: a.assignmentId, agentSpecId: a.roleId, modelRequestId: a.roleId + '-1', index: 1 }),
      event(index * 3 + 3, 'model.requested', { assignmentId: a.assignmentId, agentSpecId: a.roleId, modelRequestId: a.roleId + '-2', index: 2 }),
    ])
    const snapshot = run({ status, assignments, events, phase: 'finished' })
    const restored = projectCourseSnapshot(createCourseProjection(), snapshot).effects.find(e => e.type === 'restore')
    assert.equal(restored.modelActivity.length, 3)
    for (const activity of restored.modelActivity) {
      assert.equal(activity.status, 'ended')
      assert.deepEqual(courseModelStatusView(activity), { waiting: false, badgeText: '', text: '' })
    }
    assert(courseWorkflowView(snapshot).rows.every(row => row.waiting === false))
  }
  assert.equal(courseModelStatusView({ status: 'returned', index: 1 }).badgeText, '')
  assert.equal(courseModelStatusView({ status: 'failed', index: 1 }).badgeText, '')
})

test('only an explicit null token ceiling is displayed as unlimited; old missing budgets stay unknown', () => {
  const current = courseWorkflowView(run({ budget: { maxTotalTokens: null }, usage: { totalTokens: 12345 } }))
  assert.equal(current.budget.unlimitedTotalTokens, true)
  assert.equal(courseUsageText(current.usage.totalTokens, current.budget.maxTotalTokens, '', { unlimited: current.budget.unlimitedTotalTokens }), '12,345 / 无限')
  for (const budget of [undefined, {}, { maxTotalTokens: 0 }]) {
    const old = courseWorkflowView(run({ budget, usage: { totalTokens: 12345 } }))
    assert.equal(old.budget.unlimitedTotalTokens, false)
    assert.equal(courseUsageText(old.usage.totalTokens, old.budget.maxTotalTokens, '', { unlimited: old.budget.unlimitedTotalTokens }), '12,345')
  }
  const finite = courseWorkflowView(run({ budget: { maxTotalTokens: 1000000 }, usage: { totalTokens: 12345 } }))
  assert.equal(finite.budget.unlimitedTotalTokens, false)
  assert.equal(courseUsageText(finite.usage.totalTokens, finite.budget.maxTotalTokens, '', { unlimited: finite.budget.unlimitedTotalTokens }), '12,345 / 1,000,000')
  assert.equal(courseUsageText(null, null, '', { unlimited: true }), '未记录')
})
