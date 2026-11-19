import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCourseProjection, projectCourseSnapshot, courseForecastPoints, courseRoomOutcome } from './course-projection.mjs'
import { courseTeam } from './course-team.mjs'
const event = (seq, type, payload = {}) => ({ seq, eventId: 'event-' + seq, type, payload: { roleId: 'official', assignmentId: 'a1', ...payload } })
const run = (events, extra = {}) => ({ runId: 'r1', status: 'running', assignments: [{ assignmentId: 'a1', roleId: 'official', status: 'running' }], events, ...extra })
test('historical and terminal initial snapshots do not replay completion speech', () => {
  const e = event(1, 'assignment.completed', { summary: '旧报告', status: 'complete' })
  for (const options of [{}, { fresh: true }]) {
    const result = projectCourseSnapshot(createCourseProjection(), run([e], { status: 'completed' }), options)
    assert.equal(result.effects.some((e) => e.type === 'speech'), false)
  }
})
test('a room fixed to a request refuses another request run and its actual events', () => {
  const state = createCourseProjection({ requestId: 'request-A' })
  const result = projectCourseSnapshot(state, run([event(1, 'assignment.started')], { requestId: 'request-B' }), { fresh: true })
  assert.equal(result.ignored, 'request-mismatch')
  assert.equal(result.state, state)
  assert.deepEqual(result.effects, [])
})
test('a user-started active run displays real work, tool and completion exactly once', () => {
  let result = projectCourseSnapshot(createCourseProjection(), run([event(1, 'assignment.started')]), { fresh: true })
  assert.ok(result.effects.some((e) => e.type === 'work'))
  const full = run([event(1, 'assignment.started'), event(2, 'tool.completed', { toolId: 'fetch_page', status: 'ok', summary: '已取得原文' }), event(3, 'assignment.completed', { resultId: 'result', summary: '实际报告', status: 'insufficient' })])
  result = projectCourseSnapshot(result.state, full)
  assert.equal(result.effects.find((e) => e.type === 'speech').status, 'insufficient')
  assert.ok(result.effects.some((e) => e.type === 'tool'))
  assert.deepEqual(projectCourseSnapshot(result.state, full).effects, [])
})
test('backend main role messages map to the supervisor without inventing any text', () => {
  const result = projectCourseSnapshot(createCourseProjection(), run([event(1, 'meeting.message', { roleId: undefined, assignmentId: undefined, agentSpecId: 'main', summary: '已核对具体分歧' })]), { fresh: true })
  assert.equal(result.effects.find((e) => e.type === 'speech').roleId, 'supervisor')
  assert.equal(result.effects.find((e) => e.type === 'speech').summary, '已核对具体分歧')
})
test('saved team selection creates the actual topic-specific roster before live speech', () => {
  const team = [
    { roleId: 'people', name: '人物与组织研究员', objective: '核查身份', reason: '本题涉及任命' },
    { roleId: 'industry', name: '行业与专业研究员', objective: '核查行业约束', reason: '需要专业条件' },
    { roleId: 'verification', name: '反证与核验研究员', objective: '核查反例', reason: '保留反证' },
  ]
  const snapshot = run([
    event(1, 'team.selected', { team }),
    event(2, 'assignment.started', { roleId: 'people', assignmentId: 'p1' }),
    event(3, 'assignment.completed', { roleId: 'people', assignmentId: 'p1', summary: '已查到任命原文', status: 'complete' }),
  ], { team, assignments: [{ assignmentId: 'p1', roleId: 'people', name: '人物与组织研究员', status: 'complete' }] })
  const result = projectCourseSnapshot(createCourseProjection(), snapshot, { fresh: true })
  const roster = result.effects.find((e) => e.type === 'team')
  assert.deepEqual(roster.team.map((member) => member.roleId), ['supervisor', 'people', 'industry', 'verification'])
  assert.equal(roster.team[1].reason, '本题涉及任命')
  assert.ok(result.effects.indexOf(roster) < result.effects.findIndex((e) => e.type === 'speech'))
  assert.equal(result.effects.find((e) => e.type === 'speech').roleId, 'people')
  assert.deepEqual(projectCourseSnapshot(result.state, snapshot).effects, [])
})
test('local two-person follow-up has only its selected roles and one actor per researcher', () => {
  const snapshot = run([], { team: [{ roleId: 'statistics', reason: '核查指标' }, { roleId: 'graph', reason: '核查影响关系' }], assignments: [
    { assignmentId: 's1', roleId: 'statistics', objective: '原始任务', status: 'complete' },
    { assignmentId: 's2', roleId: 'statistics', objective: '复核数值。固定问题与规则：{"private":"contract"}', followUp: true, reason: '单位有分歧', status: 'running' },
    { assignmentId: 'g1', roleId: 'graph', status: 'complete' },
  ] })
  const team = courseTeam(snapshot)
  assert.deepEqual(team.map((member) => member.roleId), ['supervisor', 'statistics', 'graph'])
  assert.equal(team[1].reason, '核查指标')
  assert.equal(team[1].followUpReason, '单位有分歧')
  assert.equal(team[1].objective, '复核数值。')
  const restored = projectCourseSnapshot(createCourseProjection(), snapshot)
  assert.equal(restored.effects.some((e) => e.type === 'speech'), false)
})
test('legacy runs use actual assignments; unassigned event roles do not create phantom speech', () => {
  assert.deepEqual(courseTeam(run([], { assignments: [] })).map((member) => member.roleId), ['supervisor'])
  const snapshot = run([
    event(1, 'assignment.completed', { assignmentId: 'unknown', roleId: 'social', summary: '未被派工的发言', status: 'complete' }),
  ], { assignments: [{ assignmentId: 'a1', roleId: 'analogy', name: '历史类比研究员' }] })
  const result = projectCourseSnapshot(createCourseProjection(), snapshot, { fresh: true })
  assert.deepEqual(result.effects.find((e) => e.type === 'team').team.map((member) => member.roleId), ['supervisor', 'analogy'])
  assert.equal(result.effects.some((e) => e.type === 'speech'), false)
})
test('a selected run changes generation; terminal runs cannot emit late success', () => {
  const first = projectCourseSnapshot(createCourseProjection(), run([event(1, 'run.finished')]), { fresh: true })
  const late = projectCourseSnapshot(first.state, run([event(1, 'run.finished'), event(2, 'assignment.completed', { summary: '迟到报告' })]))
  assert.deepEqual(late.effects, [])
  const switched = projectCourseSnapshot(late.state, run([], { runId: 'r2' }))
  assert.equal(switched.state.generation, first.state.generation + 1)
})
test('run.finished preserves actual cancelled, failed and insufficient outcomes', () => {
  for (const status of ['cancelled', 'failed', 'insufficient']) {
    const initial = projectCourseSnapshot(createCourseProjection(), run([event(1, 'assignment.started')]), { fresh: true })
    const result = projectCourseSnapshot(initial.state, run([event(1, 'assignment.started'), event(2, 'run.finished', { status })], { status }))
    assert.equal(result.state.status, status)
    assert.equal(result.effects.find((e) => e.type === 'end').status, status)
  }
})
test('curve points exclude missing probabilities, duplicate IDs, future points and changed targets', () => {
  const base = { forecastId: 'f1', predictionId: 'p', predictionVersion: 1, targetAt: '2026-11-21T00:00:00Z', publishedAt: '2026-11-19T00:00:00Z', probabilityYes: 0.5 }
  const points = courseForecastPoints([base, base, { ...base, forecastId: 'null', probabilityYes: null }, { ...base, forecastId: 'future', publishedAt: '2026-11-22T00:00:00Z' }, { ...base, forecastId: 'other', targetAt: '2026-11-23T00:00:00Z' }], { predictionId: 'p', predictionVersion: 1, targetAt: base.targetAt, now: Date.parse('2026-11-20T00:00:00Z') })
  assert.equal(points.length, 1)
  assert.equal(points[0].probabilityYes, 0.5)
  assert.deepEqual(courseForecastPoints([{ ...base, predictionVersion: undefined }]), [])
  assert.deepEqual(courseForecastPoints([{ ...base, predictionId: undefined }]), [])
})
test('no-change check restores and ends without claiming a forecast, worker report or invented speech', () => {
  const triage = { kind: 'no_change', reason: '没有有效新变化', selectedRoleIds: [], newEvidenceIds: [], duplicateCount: 0 }
  const snapshot = run([event(1, 'run.finished', { summary: '保留上一条概率', status: 'completed' })], { assignments: [], status: 'completed', triage, summary: '保留上一条概率', forecast: null })
  const historical = projectCourseSnapshot(createCourseProjection(), snapshot)
  const restored = historical.effects.find((e) => e.type === 'restore')
  assert.equal(restored.hasForecast, false)
  assert.equal(restored.assignmentCount, 0)
  assert.equal(restored.triage.kind, 'no_change')
  assert.equal(restored.summary, '保留上一条概率')
  assert.deepEqual(courseRoomOutcome(restored), { phase: '检查完成，保留原判断', supervisorState: 'checked', supervisorObjective: '检查新资料，保留原判断', teamNote: '本次没有新变化，未召集研究员' })
  assert.equal(historical.effects.some((e) => ['speech', 'work', 'meeting'].includes(e.type)), false)
  const live = projectCourseSnapshot(createCourseProjection(), run([], { assignments: [], forecast: null }), { fresh: true })
  const finished = projectCourseSnapshot(live.state, snapshot)
  assert.deepEqual(courseRoomOutcome(finished.effects.find((e) => e.type === 'end')), courseRoomOutcome(restored))
  assert.equal(finished.effects.some((e) => ['speech', 'work', 'meeting'].includes(e.type)), false)
  assert.equal(courseRoomOutcome({ ...restored, hasForecast: true }).supervisorState, 'published')
})
