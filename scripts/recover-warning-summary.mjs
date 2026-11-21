import { createCourseStore } from '../server/course/course-store.mjs'
import { researchSummaryMessages } from '../server/course/research-summary.mjs'
import { nativeTool } from '../server/course/course-contracts.mjs'
const runId = process.argv.find(x => x.startsWith('--run='))?.slice(6)
const db = process.argv.find(x => x.startsWith('--db='))?.slice(5)
const base = new URL(process.argv.find(x => x.startsWith('--base='))?.slice(7) || 'http://127.0.0.1:4174')
if (!runId || !db || base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw Error('Provide --run, --db and a local --base')
const store = createCourseStore({ path: db })
let requestId
try {
  const run = store.requireRun(runId), request = store.requireRequest(run.requestId), outputCap = 6000
  if (run.status !== 'failed' || run.phase !== 'review' || request.resolutionPolicy?.version !== 'hko-red-fire-observation-v1' || run.state.summaryResumeCount || run.usage.unknownUsage) throw Error('Only one final summary recovery of a failed bounded warning run is allowed')
  const assignments = store.listAssignments(runId)
  const gaps = assignments.filter(item => item.status === 'failed' && !item.report).map(item => ({ assignmentId: item.assignmentId, report: { status: 'blocked', summary: '【程序失败回执，非研究报告】该席未交付有效报告，不能视为独立核验完成。', evidenceIds: [], support: [], counterevidence: [], missingEvidence: ['独立核验未完成'], probability: null, completionMode: 'harness-failure-receipt' } }))
  const messages = researchSummaryMessages(request.question, assignments.map(item => ({ ...item, report: gaps.find(gap => gap.assignmentId === item.assignmentId)?.report || item.report })), store.evidenceFor(runId), { ...request.normalized, groundingPolicy: request.groundingPolicy })
  const reserve = Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(JSON.stringify(['propose_forecast', 'mark_insufficient'].map(nativeTool))) + outputCap + 2048
  if (run.usage.totalTokens + reserve > run.budget.maxTotalTokens) throw Error('Original remaining budget cannot safely cover this final request')
  console.log(JSON.stringify({ runId, requestId: request.requestId, paidRequestsRemaining: 1, originalTotalLimit: run.budget.maxTotalTokens, currentUsage: run.usage.totalTokens, reservedForSummary: reserve, outputCap }))
  if (!process.argv.includes('--apply')) { console.log('Dry run only; add --apply for the explicitly authorized one-request recovery.'); process.exit(0) }
  store.resumeResearchSummary(runId, { maxTokens: outputCap }); requestId = request.requestId
  for (const gap of gaps) store.saveAssignment(gap.assignmentId, { report: gap.report }, { type: 'assignment.gap_recorded', payload: { assignmentId: gap.assignmentId, summary: gap.report.summary, completionMode: 'harness-failure-receipt' } })
} finally { store.close() }
// Wake an idle pre-upgrade service. queueRun returns this already queued Run;
// the assertion prevents silently accepting a different/new prediction Run.
const response = await fetch(new URL('/api/v1/course/requests/' + requestId + '/check', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
const value = await response.json()
if (!response.ok || value.runId !== runId) throw Error('Recovery wake did not return the original Run; inspect before any retry')
console.log(JSON.stringify({ resumedRunId: value.runId, status: value.status, totalLimit: value.budget.maxTotalTokens }))
