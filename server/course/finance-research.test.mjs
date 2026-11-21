import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNewsSearchTool } from './news-search.mjs'
import { createFinancialMetricsTool } from './financial-metrics.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { FINANCE_CASES, runFinanceCase } from '../../scripts/finance-cases.mjs'
import { createCourseStore } from './course-store.mjs'
import { RuntimeError } from '../runtime/model-provider.mjs'
import { researchSummaryMessages, unsentSummaryRequest } from './research-summary.mjs'

const NOW = '2026-11-20T16:00:00.000Z'
test('budget preflight rejection may retry the unbilled summary once, without resetting paid usage', () => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  try {
    const request = store.createRequest({ purpose: 'research', question: '虚构财报', watch: false, budget: { maxTotalTokens: 160000, maxTokens: 8192 } })
    const runId = request.activeRunId
    for (const [assignmentId, roleId] of [['a', 'official'], ['b', 'verification']]) {
      store.createAssignment(runId, { assignmentId, roleId })
      store.saveAssignment(assignmentId, { status: 'completed', checkpoint: { usage: { modelRequests: 1 } }, report: { status: 'complete', evidenceIds: ['e'] } })
    }
    store.saveRun(runId, { status: 'failed', phase: 'review', state: { summaryResumeCount: 2, main: { calls: 2 } }, usage: { modelRequests: 3, totalTokens: 112860, unknownUsage: false }, error: { code: 'COURSE_BUDGET' } })
    assert(unsentSummaryRequest(store.requireRun(runId), store.listAssignments(runId)))
    const result = store.resumeResearchSummary(runId, { maxTokens: 16384 })
    assert.equal(result.state.summaryResumeCount, 2); assert.equal(result.usage.modelRequests, 3)
    assert.equal(result.budget.maxTokens, 16384); assert.equal(result.budget.maxTotalTokens, 160000)
    store.saveRun(runId, { status: 'failed', error: { code: 'COURSE_BUDGET' } })
    assert.throws(() => store.resumeResearchSummary(runId), { code: 'RESEARCH_RESUME_UNAVAILABLE' })
    const messages = researchSummaryMessages('原问题', [{ assignmentId: 'a', roleId: 'official', report: { status: 'complete', summary: '已有报告', evidenceIds: ['e'] }, checkpoint: { messages: [{ content: 'PRIVATE_CHECKPOINT' }] } }], [{ evidenceId: 'e', title: '已读正文', url: 'https://example.com', text: 'FULL_SOURCE_BODY' }])
    assert.match(JSON.stringify(messages), /已有报告/); assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_CHECKPOINT|FULL_SOURCE_BODY/)
  } finally { store.close() }
})
test('a second incomplete summary can be assembled without more model requests and keeps failure history', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'finance-assembly-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const mock = createCourseMockProvider(); let summaries = 0
  const provider = { ...mock, async complete(input) {
    const response = await mock.complete(input)
    if (response.message.tool_calls?.some((call) => call.function.name === 'submit_research_report')) {
      summaries++; throw new RuntimeError('MODEL_INCOMPLETE', '受控截断', { usage: { total_tokens: 100 } })
    }
    return response
  } }
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, provider, sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW }), now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  const created = service.createRequest({ purpose: 'research', question: '虚构财报核验' }); await service.idle()
  const runId = service.getRequest(created.requestId).run.runId
  for (let i = 0; i < 2; i++) { service.resumeResearchSummary(runId); await service.idle() }
  assert.equal(summaries, 3)
  assert.throws(() => service.resumeResearchSummary(runId), { code: 'RESEARCH_RESUME_LIMIT' })
  const failed = service.getRequest(created.requestId).run
  const result = service.assembleResearchReport(runId)
  assert.equal(result.researchReport.assemblyMode, 'harness'); assert.equal(result.researchReport.quality, 'limited')
  assert.equal(result.researchReport.summaryFailure.code, 'MODEL_INCOMPLETE')
  assert.deepEqual(result.usage, failed.usage); assert.equal(summaries, 3)
  assert.equal(result.runId, runId); assert.match(result.collaboration.conclusion, /裁决未完成/)
  assert.equal(result.events.filter((event) => event.type === 'run.finished' && event.payload.status === 'failed').length, 3)
  assert(result.researchReport.decisionNotes.every((note) => note.disposition === 'qualified'))
  assert.throws(() => service.assembleResearchReport(runId), { code: 'RESEARCH_ASSEMBLY_UNAVAILABLE' })
})
test('a truncated research summary resumes the same run once without repeating workers or tools', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'finance-summary-resume-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const mock = createCourseMockProvider(); let truncate = true
  const provider = { ...mock, async complete(input) {
    const response = await mock.complete(input)
    if (truncate && response.message.tool_calls?.some((call) => call.function.name === 'submit_research_report')) {
      truncate = false; throw new RuntimeError('MODEL_INCOMPLETE', '受控输出截断', { usage: { total_tokens: 100 } })
    }
    return response
  } }
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW }), provider, modelMode: 'mock', now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  const created = service.createRequest({ purpose: 'research', question: '核验虚构公司财报与管理层表述' }); await service.idle()
  const failed = service.getRequest(created.requestId)
  assert.equal(failed.run.error.code, 'MODEL_INCOMPLETE'); assert.equal(failed.run.phase, 'review')
  const ids = failed.run.assignments.map((item) => item.assignmentId), tools = failed.run.usage.toolCalls
  service.resumeResearchSummary(failed.run.runId); await service.idle()
  const completed = service.getRequest(created.requestId)
  assert.equal(completed.run.runId, failed.run.runId); assert.equal(completed.run.status, 'completed')
  assert.equal(completed.run.usage.toolCalls, tools); assert.deepEqual(completed.run.assignments.map((item) => item.assignmentId), ids)
  assert.equal(completed.run.summaryResumeCount, 1); assert(completed.researchReport)
  assert.equal(completed.run.events.filter((event) => event.type === 'research.published').length, 1)
  assert(completed.run.events.some((event) => event.type === 'run.finished' && event.payload.status === 'failed'))
  assert.throws(() => service.resumeResearchSummary(completed.run.runId), { code: 'RESEARCH_RESUME_UNAVAILABLE' })
})
test('research publisher rejects future or foreign evidence, forbids forecasts and seals one immutable report', () => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  try {
    const created = store.createRequest({ purpose: 'research', question: '财报核验', watch: false })
    const runId = created.activeRunId
    store.saveRun(runId, { topicId: 'research_topic' })
    const evidence = { evidenceId: 'read', topicId: 'research_topic', text: '已取得的财报原文', url: 'https://example.com/filing', contentHash: 'same', publishedAt: NOW }
    for (const [assignmentId, roleId] of [['a', 'official'], ['b', 'statistics']]) {
      store.recordEvidence(runId, evidence, assignmentId)
      store.createAssignment(runId, { assignmentId, roleId })
      store.saveAssignment(assignmentId, { status: 'completed', report: { status: 'complete', evidenceIds: ['read'] } })
    }
    store.recordEvidence(runId, { ...evidence, evidenceId: 'future', publishedAt: '2026-11-21T01:00:00.000Z' }, 'a')
    const candidate = { summary: '已核验财报事实', findings: [{ claim: '可回查原文', evidenceIds: ['read'] }], limitations: [], decisionNotes: [] }
    for (const id of ['foreign', 'future']) assert.throws(() => store.publishResearch(runId, { ...candidate, findings: [{ claim: '错误引用', evidenceIds: [id] }] }), { code: 'RESEARCH_EVIDENCE' })
    assert.throws(() => store.publishForecast(runId, { probabilityYes: .5 }, {}), { code: 'RESEARCH_PURPOSE' })
    const result = store.publishResearch(runId, candidate)
    assert.equal(store.publishResearch(runId, candidate).reportId, result.reportId)
    assert.throws(() => store.publishResearch(runId, { ...candidate, summary: '覆盖原研报' }), { code: 'RESEARCH_CONFLICT' })
    assert.equal(store.listResearchReports().length, 1)
  } finally { store.close() }
})
for (const spec of FINANCE_CASES) test('finance representative case: ' + spec.id, async () => {
  const result = await runFinanceCase(spec)
  assert(result.checks.length >= 5); assert.equal(result.metrics.forecasts, 0); assert.equal(result.metrics.reports, 1)
})
test('bilingual news search keeps channels, deduplicates tracking URLs and never manufactures evidence', async () => {
  const search = { timeoutMs: 1000, async execute({ query }) { return { status: 'ok', observedAt: NOW, data: { results: [{ url: query === '中文' ? 'https://news.example/story?utm_source=x' : 'https://news.example/story', title: 'Quarterly results', snippet: 'not evidence' }] }, usage: { providerRequests: 1 } } } }
  const result = await createNewsSearchTool(search).execute({ queryZh: '中文', queryEn: 'English' }, {})
  assert.equal(result.data.results.length, 1)
  assert.deepEqual(result.data.results[0].queryLanguages, ['zh', 'en'])
  assert.equal(result.usage.providerRequests, 2)
  assert.deepEqual(result.evidenceIds, [])
  search.execute = async ({ query }) => query === '中文' ? { status: 'error', error: { code: 'SOURCE_TIMEOUT' } } : { status: 'ok', data: { results: [] } }
  assert.equal((await createNewsSearchTool(search).execute({ queryZh: '中文', queryEn: 'English' }, {})).status, 'partial')
})

test('financial comparison uses actually read quotes and rejects wrong units, accounting and unsupported figures', async () => {
  const quote = 'Fictional revenue in USD billion: Q3 FY2027 120; Q3 FY2026 100 (GAAP).'
  const tool = createFinancialMetricsTool({ getEvidence: (id) => id === 'read' ? { text: quote } : null, now: () => NOW })
  const figure = (value, period) => ({ value, period, scale: 'billion', currency: 'USD', accounting: 'GAAP', evidenceId: 'read', quote })
  const args = { metric: 'revenue', comparison: 'year-over-year', current: figure(120, 'Q3 FY2027'), previous: figure(100, 'Q3 FY2026') }
  const result = await tool.execute(args)
  assert.equal(result.status, 'ok'); assert(Math.abs(result.data.growthPercent - 20) < .0001)
  for (const patch of [{ value: 999 }, { evidenceId: 'foreign' }, { accounting: 'non-GAAP' }, { currency: 'CNY' }, { period: 'Q3 FY2027' }, { scale: 'million' }, { period: 'Q2 FY2026' }]) {
    const rejected = await tool.execute({ ...args, previous: { ...args.previous, ...patch } })
    assert.equal(rejected.status, 'error')
  }
})

test('focused reading keeps provenance, supports both languages and caches each excerpt separately', async () => {
  const saved = []
  const text = '段'.repeat(4500) + ' Q3 FY2026 财报比较 Revenue $100 billion.'
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW, fixturePages: [{ url: 'https://example.com/filing', title: '财报', text }] })
  const tools = gateway.toolsFor({ roleId: 'statistics', onEvidence: (record) => { saved.push(record); return 'e' + saved.length } })
  assert(!tools.some((tool) => tool.toolId === 'search_news'))
  const fetch = tools.find((tool) => tool.toolId === 'fetch_page')
  await fetch.execute({ url: 'https://example.com/filing' }, {})
  const focused = await fetch.execute({ url: 'https://example.com/filing', focus: 'Q3 FY2026' }, {})
  assert.match(focused.data.text, /Revenue/); assert.equal(focused.data.language, 'zh'); assert(focused.data.excerptStart > 0)
  assert.equal(saved.length, 2)
  await fetch.execute({ url: 'https://example.com/filing', focus: 'Q3 FY2026' }, {})
  assert.equal(saved.length, 2)
})

test('research publishes an immutable cited report without a forecast, target contract or automatic watch', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'finance-research-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const provider = createCourseMockProvider()
  const open = () => createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools, provider, modelMode: 'mock', now: () => NOW })
  let service = open()
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  const created = service.createRequest({ purpose: 'research', question: '核验虚构上市公司财报营收与管理层表述' })
  await service.idle()
  const result = service.getRequest(created.requestId)
  assert.equal(result.run.status, 'completed', JSON.stringify({ error: result.run.error, summary: result.run.summary }))
  assert(result.researchReport?.findings.length)
  assert.equal(result.forecast, null); assert.equal(result.forecasts.length, 0); assert.equal(result.normalized, null)
  assert.equal(result.watch.status, 'off'); assert.equal(result.researchReport.scoringEligible, false)
  assert.equal(result.run.collaboration.decision.kind, 'research_report')
  assert.equal(result.run.collaboration.decision.probabilityYes, null)
  assert(result.run.assignments.every((item) => item.methodProfile?.version === 'finance-methods-v1'))
  const before = result.researchReport
  await service.close(); service = open()
  assert.deepEqual(service.getRequest(result.requestId).researchReport, before)
  assert.throws(() => service.createRequest({ purpose: 'research', question: '财报', watch: true }), { code: 'INVALID_RESEARCH_INPUT' })
})
