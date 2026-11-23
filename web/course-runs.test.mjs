import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseAnswerOutlook, courseRuns, courseResearcherCount, selectCourseRoomRun, courseRunLabel, courseAnswerProvenance, courseRunBelongsToRequest } from './course-runs.mjs'

const assignments = (roles) => roles.map((roleId, index) => ({ assignmentId: roleId + index, roleId, status: 'completed' }))
const research = { requestId: 'q', predictionId: 'p', runId: 'research', status: 'completed', assignments: assignments(['social', 'people', 'verification']), triage: { kind: 'initial' } }
const check = { requestId: 'q', predictionId: 'p', runId: 'check', status: 'completed', assignments: [], triage: { kind: 'no_change' }, trigger: 'watch' }
const data = { requestId: 'q', predictionId: 'p', runs: [research, check], latestRun: check, latestRunId: 'check', forecast: { forecastId: 'f', runId: 'research', probabilityYes: .47 } }

test('a provisional outlook stays current across idle checks until a newer forecast is published', () => {
  const outlook = { ...research, runId: 'outlook', directionOutlook: { direction: 'down' } }
  const record = { ...data, runs: [research, outlook, check] }
  assert.equal(courseAnswerOutlook(record), outlook)
  assert.equal(selectCourseRoomRun(record), 'outlook')
  assert.match(courseAnswerProvenance(record).summary, /暂定走势/)
  assert.match(courseRunLabel(outlook), /暂定走势/)
  assert.equal(courseAnswerOutlook({ ...record, forecast: { runId: check.runId } }), null)
  assert.equal(courseAnswerOutlook({ ...record, runs: [research, { ...outlook, requestId: 'foreign' }, check] }), null)
})

test('default room shows the actual forecast collaboration instead of latest zero-worker check', () => {
  assert.equal(selectCourseRoomRun(data), 'research')
  assert.match(courseAnswerProvenance(data).summary, /第 1 次研判，共 3 位研究员/)
  assert.match(courseAnswerProvenance(data).summary, /最近仅监听检查，沿用原判断/)
})
test('without a forecast choose the active run, then the latest actual researcher assignment', () => {
  assert.equal(selectCourseRoomRun({ ...data, forecast: null, activeRunId: 'check' }), 'check')
  assert.equal(selectCourseRoomRun({ ...data, forecast: null }), 'research')
  assert.equal(selectCourseRoomRun({ requestId: 'q', runs: [check] }), 'check')
  assert.equal(selectCourseRoomRun({ requestId: 'q', runs: [] }), null)
})
test('URL, manual selection, and a manually started check stay locked across later forecasts', () => {
  for (const selected of ['check', 'research', 'explicit-url-run']) {
    assert.equal(selectCourseRoomRun(data, { selectedRunId: selected, pinned: true }), selected)
    assert.equal(selectCourseRoomRun({ ...data, forecast: { forecastId: 'new', runId: 'check' } }, { selectedRunId: selected, pinned: true }), selected)
  }
})
test('auto room follows a new immutable forecast source while a pinned room stays put', () => {
  const next = { ...research, runId: 'next-research' }
  const nextData = { ...data, runs: [research, check, next], forecast: { forecastId: 'new', runId: next.runId }, latestRun: next }
  assert.equal(selectCourseRoomRun(nextData, { selectedRunId: 'research' }), 'next-research')
  assert.equal(selectCourseRoomRun(nextData, { selectedRunId: 'research', pinned: true }), 'research')
})
test('role counts are real unique researchers, excluding main and follow-ups', () => {
  assert.equal(courseResearcherCount({ assignments: assignments(['main', 'supervisor', 'market', 'statistics', 'verification', 'statistics']) }), 3)
  assert.equal(courseResearcherCount({ assignments: [], team: [{ roleId: 'people' }] }), 0)
})
test('menus distinguish research, local review, no-change check and failure', () => {
  assert.equal(courseRunLabel(research, 0), '第 1 轮 · 研判')
  assert.equal(courseRunLabel({ ...research, triage: { kind: 'local' } }, 1), '第 2 轮 · 局部复核')
  assert.equal(courseRunLabel(check, 2), '第 3 轮 · 监听检查 · 无变化')
  assert.equal(courseRunLabel({ ...check, status: 'failed' }, 3), '第 4 轮 · 失败')
})
test('provenance numbers substantive rounds and follows the immutable forecast/run link', () => {
  const local = { ...research, runId: 'local', triage: { kind: 'local' }, assignments: assignments(['statistics', 'verification']) }
  const record = { ...data, runs: [research, local, check], forecast: { forecastId: 'new', runId: 'local' } }
  const origin = courseAnswerProvenance(record)
  assert.equal(origin.researchNumber, 2)
  assert.equal(origin.workerCount, 2)
  assert.equal(origin.forecastRunId, 'local')
  assert.equal(origin.latestCheckRunId, 'check')
})
test('foreign request or prediction runs cannot become defaults or evidence of collaboration', () => {
  const foreign = { ...research, runId: 'foreign', requestId: 'another' }
  const wrongPrediction = { ...research, runId: 'wrong', predictionId: 'other' }
  const unidentified = { ...research, runId: 'unidentified', requestId: undefined }
  const record = { ...data, runs: [research, check, foreign, wrongPrediction, unidentified], latestRun: foreign, forecast: { forecastId: 'f', runId: 'foreign' } }
  assert.deepEqual(courseRuns(record).map((run) => run.runId), ['research', 'check'])
  assert.equal(selectCourseRoomRun(record), 'research')
  assert.equal(courseAnswerProvenance(record).workerCount, null)
  assert.match(courseAnswerProvenance(record).summary, /人数尚不能确认/)
})
test('empty history never invents researcher counts or a forecast source', () => {
  const origin = courseAnswerProvenance({ requestId: 'q' })
  assert.equal(origin.forecastRunId, null)
  assert.equal(origin.latestCheckRunId, null)
  assert.equal(origin.workerCount, null)
  assert.match(origin.summary, /尚未发布预测/)
})
test('explicit URL stays selected but foreign or unidentified fetched runs are rejected before rendering', () => {
  assert.equal(selectCourseRoomRun(data, { selectedRunId: 'foreign', pinned: true }), 'foreign')
  assert.equal(courseRunBelongsToRequest(data, { ...research, runId: 'foreign', requestId: 'other' }), false)
  assert.equal(courseRunBelongsToRequest(data, { ...research, predictionId: 'other' }), false)
  assert.equal(courseRunBelongsToRequest(data, { ...research, requestId: undefined }), false)
  assert.equal(courseRunBelongsToRequest(data, research), true)
  assert.equal(courseRunBelongsToRequest(data, { ...research, predictionId: null }), true)
})
