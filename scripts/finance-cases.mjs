import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCourseService } from '../server/course/course-service.mjs'
import { createCourseMockProvider } from '../server/course/course-mock-provider.mjs'
import { createWebResearchGateway } from '../server/course/web-tools.mjs'
import { createWorkbenchService } from '../server/domain/workbench-service.mjs'

const NOW = '2026-11-20T16:00:00.000Z'
const QUOTE = 'Fictional company revenue in USD billion, GAAP: Q3 FY2027 120; Q3 FY2026 100.'
export const FINANCE_CASES = [
  { id: 'financial-numbers', title: '【虚构】中英财报数字与会计口径', question: '核验虚构上市公司财报营收、同比口径和管理层表述' },
  { id: 'financial-timeline', title: '【虚构】旧引语、新闻时间线与行业机制', question: '核验虚构公司财报时间线、管理层新旧表述和行业影响机制' },
]
export async function runFinanceCase(spec) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-financial-case-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const mock = createCourseMockProvider()
  const diagnostics = []
  const action = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'finance_fixture_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls', usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 } })
  const provider = { ...mock, async complete(input) {
    const response = await mock.complete(input)
    const initial = JSON.parse(input.messages.find((message) => message.role === 'user').content)
    if (initial.kind === 'course-main') for (const message of input.messages.filter((message) => message.role === 'tool')) { const result = JSON.parse(message.content); if (result.error) diagnostics.push(result.error) }
    const report = response.message.tool_calls?.find((call) => call.function.name === 'submit_report')
    const calls = input.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.tool_calls || [])
    const read = [...calls].reverse().find((call) => call.function.name === 'fetch_page')
    const readResult = read && input.messages.findLast((message) => message.role === 'tool' && message.tool_call_id === read.id)
    if (report && readResult && initial.agentSpecId === 'official' && !calls.some((call) => call.function.name === 'fetch_page' && JSON.parse(call.function.arguments).url.endsWith('/official-cn'))) return action('fetch_page', { url: 'https://example.com/finance/official-cn' })
    if (report && readResult && initial.agentSpecId === 'statistics') {
      const comparison = calls.find((call) => call.function.name === 'compare_financial_metrics')
      if (!comparison) {
        const evidenceId = JSON.parse(readResult.content).evidenceIds[0]
        const figure = (value, period) => ({ value, period, scale: 'billion', currency: 'USD', accounting: 'GAAP', evidenceId, quote: QUOTE })
        return action('compare_financial_metrics', { metric: 'revenue', comparison: 'year-over-year', current: figure(120, 'Q3 FY2027'), previous: figure(100, 'Q3 FY2026') })
      }
      const result = JSON.parse(input.messages.find((message) => message.role === 'tool' && message.tool_call_id === comparison.id).content)
      assert.equal(result.status, 'ok')
      const args = JSON.parse(report.function.arguments); args.summary = `【虚构】已通过工具计算同口径收入同比增长${result.data.growthPercent.toFixed(2)}%，不是股价影响。`; report.function.arguments = JSON.stringify(args)
    }
    return response
  } }
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW, fixturePages: [
    { url: 'https://example.com/finance/official', title: 'Fictional company official quarterly results', text: '【虚构财报资料】' + QUOTE + ' Current spokesperson: interim CEO Alice. Prior-quarter remarks by founder Wang do not belong to this report.' },
    { url: 'https://example.com/finance/official-cn', title: '【虚构】公司官方中文财报', text: '【虚构财报资料】本期GAAP收入1200亿美元，去年同期1000亿美元；本期发言人为临时CEO Alice，创始人王华上一季度的引语不可移用于本期。同一公司中英文稿不是两份独立确认。' },
    { url: 'https://example.com/finance/news', title: '【虚构】中文媒体转述财报', text: '【虚构报道】媒体转述本期公司财报，并引述上一季度创始人旧话。应标记不同期间及转载来源，不能归为本期新增观点。AI需求可能带动收入，但尚未证明该表述导致股价或业绩变化。' },
  ] })
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools: gateway, provider, modelMode: 'mock', now: () => NOW })
  try {
    const created = service.createRequest({ purpose: 'research', question: spec.question, watch: false }); await service.idle()
    const record = service.getRequest(created.requestId), checks = []
    const verify = (value, text) => { assert(value, text + ': ' + JSON.stringify({ error: record.run.error, diagnostics: diagnostics.slice(-3), assignments: record.run.assignments.map((item) => ({ role: item.roleId, error: item.error })) })); checks.push(text) }
    verify(record.run.status === 'completed' && record.researchReport, '研报封存完成')
    verify(!record.forecast && !record.forecasts.length && !record.normalized, '没有概率、未来契约或预测成绩')
    verify(record.watch.status === 'off', '自动监听关闭')
    verify(record.run.assignments.every((item) => item.methodProfile?.version === 'finance-methods-v1'), '本次实际派工采用财报专项方法')
    if (spec.id === 'financial-numbers') {
      verify(record.evidence.some((item) => item.language === 'en') && record.evidence.some((item) => item.language === 'zh'), '中英文官方原文均实际读取')
      verify(record.run.events.some((event) => event.type === 'tool.completed' && event.payload.toolId === 'compare_financial_metrics'), '统计席实际执行增长率工具')
    } else verify(record.run.events.some((event) => event.type === 'tool.completed' && event.payload.toolId === 'search_news'), '新闻席实际执行双语检索')
    return { ...spec, purpose: 'research', mode: 'mock', notAccuracyBenchmark: true, checks,
      snapshots: [{ label: '财报协作研报', status: record.run.status, collaboration: record.run.collaboration }],
      metrics: { runs: 1, reports: 1, forecasts: 0, modelRequests: record.run.usage.modelRequests, toolCalls: record.run.usage.toolCalls, totalTokens: record.run.usage.totalTokens } }
  } finally { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) }
}
export async function runFinanceCases() {
  const cases = []
  for (const spec of FINANCE_CASES) cases.push(await runFinanceCase(spec))
  try {
    const live = JSON.parse(await readFile(new URL('../docs/evidence/finance-live-validation.json', import.meta.url), 'utf8'))
    for (const record of live.records || []) cases.push({ id: record.requestId, title: '真实存档：' + record.title, question: record.question, purpose: 'research', mode: 'live', notAccuracyBenchmark: true,
      checks: record.checks, metrics: record.metrics, reviewNotes: record.reviewNotes || [], snapshots: record.runs.map((run) => ({ label: '真实研报存档', status: run.status, collaboration: run.collaboration })) })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { version: 1, generatedAt: new Date().toISOString(), notAccuracyBenchmark: true, description: '虚构案例与真实运行存档分别标识；存档只读，不调用模型。财报解释不是预测准确率或投资收益成绩。', cases }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runFinanceCases(), output = new URL('../web/demo/finance-cases.json', import.meta.url)
  await mkdir(dirname(fileURLToPath(output)), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`财报案例 ${result.cases.length} 条已生成。`)
}
