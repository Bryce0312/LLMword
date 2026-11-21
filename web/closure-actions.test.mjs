import test from 'node:test'
import assert from 'node:assert/strict'
import { courseRequestAction } from './course-errors.mjs'
test('a bounded review budget failure offers only its remaining chief-summary recovery', () => {
  const run = { requestId: 'q', runId: 'run', status: 'failed', phase: 'review', error: { code: 'COURSE_BUDGET' }, usage: { unknownUsage: false }, summaryResumeCount: 0 }
  const data = { requestId: 'q', purpose: 'forecast', status: 'failed', resolutionPolicy: { version: 'hko-red-fire-observation-v1' }, latestRunId: 'run', runs: [run] }
  assert.equal(courseRequestAction(data).kind, 'resume-summary'); assert.equal(courseRequestAction(data).enabled, true)
  assert.equal(courseRequestAction({ ...data, runs: [{ ...run, summaryResumeCount: 1 }] }).enabled, false)
  assert.equal(courseRequestAction({ ...data, status: 'closed' }).enabled, false)
  assert.notEqual(courseRequestAction({ ...data, runs: [{ ...run, requestId: 'other' }] }).kind, 'resume-summary')
})
