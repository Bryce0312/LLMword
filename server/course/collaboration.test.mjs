import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCollaboration, validateDecisionNotes } from './collaboration.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { runCase, CASES } from '../../scripts/course-cases.mjs'
import { memoryForModel } from './memory-policy.mjs'

test('decision receipts reject foreign reports, uncited sources, duplicates and unsupported adoption', () => {
  const assignments = [{ assignmentId: 'a', report: { status: 'complete', evidenceIds: ['e'] } }, { assignmentId: 'b', report: { status: 'insufficient', evidenceIds: [] } }]
  const note = { assignmentId: 'a', disposition: 'adopted', reason: '核验通过', evidenceIds: ['e'] }
  assert.deepEqual(validateDecisionNotes([note], assignments, ['e']), [note])
  for (const notes of [[{ ...note, assignmentId: 'foreign' }], [{ ...note, evidenceIds: ['other'] }], [note, note], [{ ...note, assignmentId: 'b', evidenceIds: [] }], [{ ...note, evidenceIds: [] }], [null]]) {
    assert.throws(() => validateDecisionNotes(notes, assignments, ['e']))
  }
  assert.deepEqual(validateDecisionNotes(undefined, assignments, ['e']), [])
})

test('public collaboration isolates runs and distinguishes answered reviews from resolved disputes', () => {
  const run = { runId: 'r', status: 'completed', modelMode: 'mock', sourceMode: 'replay',
    messages: [{ secret: 'PRIVATE_MODEL_MESSAGES' }], checkpoint: { secret: 'PRIVATE_CHECKPOINT' },
    evidence: [{ runId: 'r', evidenceId: 'e', title: '来源' }, { runId: 'foreign', evidenceId: 'bad', title: 'FOREIGN_SOURCE' }],
    assignments: [{ runId: 'r', assignmentId: 'a', roleId: 'verification', cycle: 1, report: { summary: '首轮', evidenceIds: ['e'], probability: .6 } },
      { runId: 'r', assignmentId: 'b', roleId: 'verification', followUp: true, cycle: 2, report: { status: 'insufficient', summary: '仍有缺口', evidenceIds: ['e'] }, review: { evidenceIds: ['e', 'bad'], parentAssignmentIds: ['a', 'outside'] } },
      { runId: 'foreign', assignmentId: 'outside', roleId: 'official', report: { summary: 'FOREIGN_REPORT', evidenceIds: ['bad'] } }],
    forecast: { runId: 'foreign', summary: 'FOREIGN_FORECAST' } }
  const trace = buildCollaboration(run)
  assert.equal(trace.reviews[0].responseStatus, 'submitted')
  assert.equal(trace.reviews[0].decision, null)
  assert.deepEqual(trace.reviews[0].review.parentAssignmentIds, ['a'])
  assert.deepEqual(trace.reviews[0].review.evidenceIds, ['e'])
  assert.equal(trace.decision, null)
  assert(!/PRIVATE_|FOREIGN_/.test(JSON.stringify(trace)))
})

test('publisher refuses a foreign decision receipt and can repair it without publishing twice', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-decision-receipt-'))
  const now = () => '2026-11-20T04:00:00.000Z'
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now })
  const mock = createCourseMockProvider(); let injected = false, rejected = false
  const provider = { ...mock, async complete(input) {
    rejected ||= input.messages.some((message) => message.role === 'tool' && message.content.includes('DECISION_EVIDENCE'))
    const result = await mock.complete(input)
    const call = result.message.tool_calls?.find((item) => item.function.name === 'propose_forecast')
    if (call && !injected) { const args = JSON.parse(call.function.arguments); args.decisionNotes[0].assignmentId = 'other_run_report'; call.function.arguments = JSON.stringify(args); injected = true }
    return result
  } }
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, provider, modelMode: 'mock', sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now }), now })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  const created = service.createRequest({ question: '比特币会涨吗', watch: false }); await service.idle()
  const done = service.getRequest(created.requestId)
  assert(injected && rejected)
  assert.equal(done.forecasts.length, 1)
  assert(done.run.collaboration.reviews.every((review) => review.review.parentAssignmentIds.length))
  assert(!JSON.stringify(done.run.collaboration).includes('other_run_report'))
  assert(done.forecast.decisionNotes.every((note) => done.run.assignments.some((item) => item.assignmentId === note.assignmentId)))
})

for (const spec of CASES) test('representative case: ' + spec.id, async () => {
  const result = await runCase(spec)
  assert(result.checks.length >= 5)
  assert(result.snapshots.every((snapshot) => snapshot.collaboration.modelMode === 'mock'))
  assert.equal(result.notAccuracyBenchmark, true)
})

test('model memory removes duplicate archives, preserves safety labels and scopes reports by role', () => {
  const memory = { previousForecast: { forecastId: 'f', probabilityYes: .4, conditionalOnly: true, scoringEligible: false, summary: '未核验'.repeat(500), checkpoint: 'PRIVATE' },
    reports: ['market', 'statistics', 'verification'].map((roleId) => ({ roleId, summary: '历史报告'.repeat(300), evidenceIds: ['e'] })),
    relations: [], previousEvidence: [], shortTerm: { duplicate: 'x'.repeat(20000) }, longTerm: { duplicate: 'x'.repeat(20000) }, recentJudgments: [] }
  const archive = JSON.stringify(memory)
  const compact = memoryForModel(memory, { roleId: 'market' })
  assert(JSON.stringify(compact).length < archive.length / 4)
  assert.equal(compact.previousForecast.conditionalOnly, true); assert.equal(compact.previousForecast.scoringEligible, false)
  assert.equal(compact.previousForecast.forecastId, 'f')
  assert.deepEqual(compact.reports.map((item) => item.roleId), ['market', 'verification'])
  assert(!JSON.stringify(compact).includes('PRIVATE'))
  assert.equal(JSON.stringify(memory), archive)
})

test('probability comparison works with scoped historical memory and excludes changed versions', () => {
  const run = { runId: 'r', assignments: [], evidence: [], memory: { previousForecast: { predictionVersion: 1, probabilityYes: .4 } }, forecast: { runId: 'r', predictionId: 'p', predictionVersion: 1, probabilityYes: .5 } }
  assert(Math.abs(buildCollaboration(run).decision.delta - .1) < .00001)
  run.forecast.predictionVersion = 2
  assert.equal(buildCollaboration(run).decision.delta, null)
})
