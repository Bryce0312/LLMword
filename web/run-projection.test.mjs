import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectionState, hydrateRun, parseCursor, projectEvent, selectRun } from './run-projection.mjs'

const event = (seq, type, payload = {}, extra = {}) => ({
  schemaVersion: 1, serverEpoch: 'db-1', eventId: `event-${seq}`, seq,
  emittedAt: '2026-11-18T04:00:00Z', topicId: 'topic-1', predictionId: 'prediction-1',
  runId: 'run-1', scope: 'live', trigger: 'manual', type, payload, ...extra,
})
const assignment = (extra = {}) => ({
  assignmentId: 'assignment-1', agentInstanceId: 'agent-run-1-official',
  label: '核对官方公告', ...extra,
})
const sync = (seq, runs = [], extra = {}) => ({
  schemaVersion: 1, serverEpoch: 'db-1', type: 'sync',
  payload: { reset: true, snapshotVersion: seq, coveredThroughCursor: `db-1:${seq}`, runs, activeRuns: [], ...extra },
})
const selected = () => createProjectionState({ selectedRunId: 'run-1' })
const push = (state, ...events) => events.reduce((s, e) => projectEvent(s, e).state, state)
const bubbles = (result) => result.effects.filter(({ type }) => type === 'bubble')

test('an HTTP run hydration preserves the stream cursor and restores without replaying speech', () => {
  const state = push(selected(), event(9, 'run.started'))
  const result = hydrateRun(state, { runId: 'run-1', status: 'completed', version: 3, assignment: assignment(), report: { ...assignment(), status: 'complete', resultId: 'report-1' } })
  assert.equal(result.state.cursor, 'db-1:9')
  assert.equal(result.state.highWaterSeq, 9)
  assert.equal(result.effects[0].type, 'room.restore')
  assert.equal(bubbles(result).length, 0)
  assert.equal(hydrateRun(result.state, { runId: 'run-1', status: 'running', version: 4 }).ignored, 'terminal-run-snapshot')
})

test('an HTTP snapshot in flight cannot resurrect an assignment that already finished over SSE', () => {
  const state = push(selected(), event(9, 'assignment.completed', assignment({ resultId: 'done', status: 'complete', summary: '已完成查证' })))
  const result = hydrateRun(state, { runId: 'run-1', status: 'running', version: 1, assignment: assignment({ status: 'running' }), report: null })
  assert.equal(result.state.runs['run-1'].assignments['assignment-1'].status, 'complete')
  assert.equal(result.state.runs['run-1'].assignments['assignment-1'].summary, '已完成查证')
})

test('a public frozen assignment without lifecycle status accepts real started, tool and completed events', () => {
  let state = hydrateRun(selected(), { runId: 'run-1', topicId: 'topic-1', predictionId: 'prediction-1', scope: 'live', trigger: 'manual', status: 'queued', version: 1, assignment: assignment(), report: null }).state
  assert.equal(state.runs['run-1'].assignments['assignment-1'].status, 'pending')
  const started = projectEvent(state, event(1, 'assignment.started', assignment())); state = started.state
  assert.equal(started.effects[0].type, 'actor.work')
  const tool = projectEvent(state, event(2, 'tool.completed', { ...assignment(), toolCallId: 'real-call', toolId: 'read_evidence', status: 'ok' })); state = tool.state
  assert.equal(tool.effects[0].type, 'tool')
  const completed = projectEvent(state, event(3, 'assignment.completed', assignment({ resultId: 'real-result', status: 'complete', summary: '真实工具返回后形成的报告' })))
  assert.equal(bubbles(completed).length, 1)
  assert.equal(bubbles(completed)[0].message, '真实工具返回后形成的报告')
})

test('a selected run alone owns actor effects; background runs only increment unread', () => {
  let state = push(selected(), event(1, 'run.started'))
  const background = projectEvent(state, event(2, 'assignment.started', assignment({ agentInstanceId: 'other-agent' }), {
    runId: 'run-2', predictionId: 'prediction-2', trigger: 'watch',
  }))
  assert.deepEqual(background.effects, [{ type: 'unread', runId: 'run-2', count: 1 }])
  assert.equal(background.state.selectedRunId, 'run-1')
  const result = projectEvent(background.state, event(3, 'assignment.started', assignment()))
  assert.equal(result.effects[0].type, 'actor.work')
  assert.equal(result.effects[0].runId, 'run-1')
  assert.equal(result.effects[0].preserveBubble, true)
})

test('switching rooms invalidates old animation generation and restores state without historic speech', () => {
  const state = push(selected(), event(1, 'assignment.completed', assignment({ status: 'complete', resultId: 'r-1', summary: '已核验' })),
    event(2, 'run.started', {}, { runId: 'run-2' }))
  const switched = selectRun(state, 'run-2')
  assert.equal(switched.state.roomGeneration, 1)
  assert.equal(switched.state.runs['run-2'].unread, 0)
  assert.deepEqual(switched.effects.map(({ type }) => type), ['room.reset', 'room.restore', 'unread'])
  assert.equal(bubbles(selectRun(switched.state, 'run-1')).length, 0)
  assert.deepEqual(selectRun(switched.state, 'run-2').effects, [])
})

test('selecting an unknown run requests an authoritative snapshot instead of inventing activity', () => {
  assert.deepEqual(selectRun(selected(), 'unseen').effects.map(({ type }) => type), ['room.reset', 'run.snapshot.required'])
})

test('eventId deduplication and the stream high water reject repeated and reordered delivery', () => {
  const start = event(10, 'assignment.started', assignment())
  const state = projectEvent(selected(), start).state
  assert.equal(projectEvent(state, { ...start, seq: 11 }).ignored, 'duplicate-event')
  assert.equal(projectEvent(state, event(9, 'run.started')).ignored, 'stale-seq')
  assert.equal(state.cursor, 'db-1:10')
  assert.equal(state.runs['run-1'].assignments['assignment-1'].status, 'running')
})

test('a result is presented once across completion duplicates and a meeting report echo', () => {
  const report = assignment({ resultId: 'result-1', status: 'complete', summary: '已核对两条原始公告', evidenceIds: ['e-1', 'e-2'] })
  const first = projectEvent(selected(), event(1, 'assignment.completed', report))
  assert.equal(bubbles(first).length, 1)
  assert.equal(bubbles(first)[0].success, true)
  assert.equal(bubbles(first)[0].minVisibleMs, 1700)
  const again = projectEvent(first.state, event(2, 'assignment.completed', { ...report, summary: '重新投递的不同文字' }))
  assert.equal(bubbles(again).length, 0)
  const echo = projectEvent(again.state, event(3, 'meeting.message', { ...report, messageId: 'msg-1' }))
  assert.equal(bubbles(echo).length, 0)
  const genuine = projectEvent(echo.state, event(4, 'meeting.message', {
    agentInstanceId: report.agentInstanceId, messageId: 'msg-2', relatedResultId: 'result-1', summary: '需要进一步核对更正时间',
  }))
  assert.equal(bubbles(genuine).length, 1)
  assert.equal(bubbles(genuine)[0].tone, 'neutral')
})

test('separate assignments sharing a result label do not collide in the dedup key', () => {
  const report = assignment({ resultId: 'same-label', status: 'complete' })
  const state = projectEvent(selected(), event(1, 'assignment.completed', report)).state
  const second = projectEvent(state, event(2, 'assignment.completed', { ...report, assignmentId: 'assignment-2' }))
  assert.equal(bubbles(second).length, 1)
})

test('insufficient, blocked, failed, cancelled and missing outcome never produce a success bubble', () => {
  for (const [type, status, tone] of [
    ['assignment.completed', 'insufficient', 'insufficient'],
    ['assignment.completed', 'blocked', 'blocked'],
    ['assignment.failed', undefined, 'error'],
    ['assignment.cancelled', undefined, 'cancelled'],
    ['assignment.completed', undefined, 'error'],
  ]) {
    const result = projectEvent(selected(), event(1, type, assignment({ status })))
    assert.equal(bubbles(result).length, 1)
    assert.equal(bubbles(result)[0].success, false)
    assert.equal(bubbles(result)[0].tone, tone)
  }
})

test('only a successful real tool result gets a success indicator; starting investigation does not invent a tool call', () => {
  assert.equal(projectEvent(selected(), event(1, 'assignment.started', assignment())).effects.some(({ type }) => type === 'tool'), false)
  for (const status of ['ok', 'partial', 'unavailable', 'error', 'cancelled', undefined]) {
    const result = projectEvent(selected(), event(1, 'tool.completed', { ...assignment(), toolCallId: 'tool-1', toolId: 'read_evidence', status }))
    assert.equal(result.effects[0].tool.success, status === 'ok')
    assert.equal(bubbles(result).length, 0)
  }
})

test('an assignment or tool cannot return to running after a terminal result', () => {
  let state = push(selected(), event(1, 'assignment.completed', assignment({ status: 'complete', resultId: 'r-1' })),
    event(2, 'tool.completed', { toolCallId: 'call-1', status: 'ok' }))
  const lateAssignment = projectEvent(state, event(3, 'assignment.started', assignment()))
  assert.deepEqual(lateAssignment.effects, [])
  assert.equal(lateAssignment.state.runs['run-1'].assignments['assignment-1'].status, 'complete')
  const lateTool = projectEvent(lateAssignment.state, event(4, 'tool.started', { toolCallId: 'call-1' }))
  assert.deepEqual(lateTool.effects, [])
})

test('one finished assignment does not stop an actor that is still doing another assignment', () => {
  const state = push(selected(), event(1, 'assignment.started', assignment()),
    event(2, 'assignment.started', assignment({ assignmentId: 'assignment-2' })))
  const finished = projectEvent(state, event(3, 'assignment.completed', assignment({ status: 'complete', resultId: 'r-1' })))
  assert.equal(finished.effects[0].type, 'actor.work')
  assert.equal(bubbles(finished).length, 1)
  const done = projectEvent(finished.state, event(4, 'assignment.completed', assignment({ assignmentId: 'assignment-2', status: 'complete', resultId: 'r-2' })))
  assert.equal(done.effects[0].type, 'actor.stop')
})

test('late tool success after assignment cancellation is retained as a record without a visible success effect', () => {
  const state = push(selected(), event(1, 'assignment.cancelled', assignment()))
  const late = projectEvent(state, event(2, 'tool.completed', { ...assignment(), toolCallId: 'late-tool', status: 'ok' }))
  assert.deepEqual(late.effects, [])
  assert.equal(late.state.runs['run-1'].tools['late-tool'], undefined)
  assert.equal(late.state.runs['run-1'].records.at(-1).type, 'tool.completed')
})

test('terminal runs block late success and publishing; cancellation invalidates old rendering effects', () => {
  for (const terminal of ['run.cancelled', 'run.failed', 'run.finished']) {
    const state = push(selected(), event(1, 'assignment.started', assignment()))
    const ended = projectEvent(state, event(2, terminal))
    assert.equal(ended.state.roomGeneration, terminal === 'run.finished' ? 0 : 1)
    assert.ok(ended.effects.some(({ type }) => type === 'actor.stop'))
    const late = projectEvent(ended.state, event(3, 'assignment.completed', assignment({ status: 'complete', resultId: 'late' })))
    assert.deepEqual(late.effects, [])
    const restart = projectEvent(late.state, event(4, 'run.started'))
    assert.equal(restart.state.runs['run-1'].status, ended.state.runs['run-1'].status)
    assert.deepEqual(restart.effects, [])
    assert.equal(projectEvent(restart.state, event(5, 'forecast.published', { version: 1, probabilityYes: 0.5 })).state.runs['run-1'].forecast, null)
  }
})

test('a reset restores a public single-worker run and starts after its covered cursor without replaying a report', () => {
  const raw = {
    runId: 'run-1', topicId: 'topic-1', predictionId: 'prediction-1', version: 3, status: 'running', scope: 'live', trigger: 'manual',
    assignment: assignment({ status: 'complete' }), report: { assignmentId: 'assignment-1', resultId: 'result-1', status: 'insufficient', summary: '缺少正式公告' },
  }
  const restored = projectEvent(selected(), sync(50, [raw], { activeRuns: ['run-1'] }))
  assert.equal(restored.state.cursor, 'db-1:50')
  assert.equal(restored.state.runs['run-1'].assignments['assignment-1'].agentInstanceId, raw.assignment.agentInstanceId)
  assert.equal(restored.state.runs['run-1'].assignments['assignment-1'].status, 'insufficient')
  assert.deepEqual(restored.effects.map(({ type }) => type), ['room.reset', 'room.restore'])
  assert.equal(projectEvent(restored.state, event(49, 'run.started')).ignored, 'stale-seq')
  const echo = projectEvent(restored.state, event(51, 'meeting.message', assignment({ resultId: 'result-1', messageId: 'm-1', summary: '缺少正式公告' })))
  assert.equal(bubbles(echo).length, 0)
})

test('snapshot version/cursor cannot move backwards; a terminal snapshot cannot resurrect', () => {
  const ended = push(selected(), event(20, 'run.cancelled'))
  assert.equal(projectEvent(ended, sync(19)).ignored, 'stale-snapshot')
  const reset = projectEvent(ended, sync(21, [{ runId: 'run-1', status: 'running' }]))
  assert.equal(reset.state.runs['run-1'].status, 'cancelled')
  assert.equal(reset.state.cursor, 'db-1:21')
})

test('activeRun IDs without public snapshots request hydration and do not invent work', () => {
  const result = projectEvent(selected(), sync(10, [], { activeRuns: ['run-1'] }))
  assert.deepEqual(result.effects.map(({ type }) => type), ['room.reset', 'run.snapshot.required'])
  assert.equal(result.state.runs['run-1'], undefined)
})

test('a database epoch change requires a full reset and discards old run data', () => {
  const state = push(selected(), event(1, 'run.started'))
  const mismatch = projectEvent(state, event(2, 'run.started', {}, { serverEpoch: 'db-2' }))
  assert.equal(mismatch.state.needsSync, true)
  assert.equal(mismatch.effects.at(-1).type, 'resync.required')
  assert.equal(projectEvent(mismatch.state, event(3, 'run.started')).ignored, 'needs-sync')
  const reset = projectEvent(mismatch.state, { ...sync(0), serverEpoch: 'db-2', payload: { ...sync(0).payload, coveredThroughCursor: 'db-2:0' } })
  assert.equal(reset.state.serverEpoch, 'db-2')
  assert.equal(reset.state.needsSync, false)
  assert.deepEqual(reset.state.runs, {})
  assert.equal(projectEvent(reset.state, event(1, 'run.started', {}, { serverEpoch: 'db-2' })).state.runs['run-1'].status, 'running')
})

test('a run cannot silently change prediction or scope', () => {
  const state = push(selected(), event(1, 'run.started'))
  const mismatch = projectEvent(state, event(2, 'assignment.started', assignment(), { predictionId: 'different' }))
  assert.equal(mismatch.ignored, 'run-context-changed')
  assert.equal(mismatch.effects.at(-1).type, 'resync.required')
  assert.equal(mismatch.state.runs['run-1'].predictionId, 'prediction-1')
})

test('public projections omit hidden reasoning, raw model messages and checkpoints; inputs remain immutable', () => {
  const state = selected()
  Object.freeze(state)
  const input = event(1, 'assignment.completed', assignment({
    resultId: 'result-1', status: 'complete', summary: '公开判断',
    reasoning_content: 'PRIVATE_REASONING', checkpoint: { private: 'PRIVATE_CHECKPOINT' }, messages: ['PRIVATE_MESSAGE'],
  }))
  Object.freeze(input.payload)
  const result = projectEvent(state, input)
  assert.deepEqual(state, selected())
  const output = JSON.stringify(result)
  assert.ok(output.includes('公开判断'))
  assert.equal(output.includes('PRIVATE_'), false)
})

test('forecast versions cannot regress, while later resolution can update a completed run without actor effects', () => {
  const state = push(selected(), event(1, 'forecast.published', { version: 2, forecastId: 'f-2', probabilityYes: 0.6 }))
  const stale = projectEvent(state, event(2, 'forecast.published', { version: 1, forecastId: 'f-1', probabilityYes: 0.9 }))
  assert.equal(stale.state.runs['run-1'].forecast.forecastId, 'f-2')
  assert.deepEqual(stale.effects, [])
  const completed = push(stale.state, event(3, 'run.finished'))
  const resolution = projectEvent(completed, event(4, 'resolution.recorded', { version: 1, resolutionId: 'res-1', status: 'resolved' }))
  assert.deepEqual(resolution.effects.map(({ type }) => type), ['resolution'])
})

test('an unchanged question contract can have multiple forecast publications', () => {
  const state = push(selected(), event(1, 'forecast.published', { predictionVersion: 1, forecastId: 'f-1', probabilityYes: 0.5 }))
  const update = projectEvent(state, event(2, 'forecast.published', { predictionVersion: 1, forecastId: 'f-2', probabilityYes: 0.6 }))
  assert.equal(update.state.runs['run-1'].forecast.forecastId, 'f-2')
  assert.equal(update.state.runs['run-1'].forecast.predictionVersion, 1)
  assert.deepEqual(update.effects.map(({ type }) => type), ['forecast'])
})

test('cursor parsing and malformed envelopes fail closed', () => {
  assert.deepEqual(parseCursor('db-1:23'), { epoch: 'db-1', seq: 23 })
  for (const invalid of ['', ':2', 'db:nan', 'db:-1', 'db:1.5', 'db:9007199254740992', null]) assert.equal(parseCursor(invalid), null)
  for (const invalid of [null, event(1, 'run.started', {}, { schemaVersion: 0 }), event(1, 'run.started', {}, { scope: 'monitor' })]) {
    assert.equal(projectEvent(selected(), invalid).ignored, 'invalid-envelope')
  }
  assert.equal(projectEvent(selected(), sync(3, [], { coveredThroughCursor: 'different:3' })).ignored, 'invalid-snapshot')
  assert.equal(projectEvent(selected(), sync(3, {})).ignored, 'invalid-snapshot')
})
