import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCourseService } from '../server/course/course-service.mjs'
import { createCourseMockProvider } from '../server/course/course-mock-provider.mjs'
import { createWebResearchGateway } from '../server/course/web-tools.mjs'
import { createWorkbenchService } from '../server/domain/workbench-service.mjs'

const NOW = '2026-11-20T04:00:00.000Z'
export const CASES = [
  { id: 'btc', title: 'BTC：固定基准与核验协作', question: '比特币未来24小时会下跌吗？' },
  { id: 'eth', title: 'ETH：资产匹配与独立取证', question: 'ETH未来24小时会上涨吗？' },
  { id: 'wrong-asset', title: '错资产报价：降级并保留缺口', question: 'BTC未来24小时会下跌吗？' },
  { id: 'no-quote', title: '报价不可用：继续调查但不伪造基准', question: 'BTC未来24小时会下跌吗？' },
  { id: 'gold', title: '黄金：不支持的结构化报价', question: '黄金未来24小时会下跌吗？' },
  { id: 'update', title: '新证据：局部复核与无变化检查', question: '比特币未来24小时会上涨吗？' },
  { id: 'recovery', title: '模型鉴权失败后恢复', question: '虚构科技展未来24小时会开幕吗？' },
]

export async function runCase(spec) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-collaboration-case-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  let revision = 1, blocked = spec.id === 'recovery'
  const mock = createCourseMockProvider()
  const provider = { ...mock, async complete(input) {
    if (blocked) throw Object.assign(new Error('模型认证失败，请重新配置连接。'), { code: 'MODEL_AUTH_FAILED', actionRequired: true, retryable: false })
    const response = await mock.complete(input)
    if (spec.id === 'wrong-asset') for (const call of response.message.tool_calls || []) if (call.function.name === 'get_market_quote') call.function.arguments = JSON.stringify({ pair: 'ETH-USD' })
    return response
  } }
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW, fixturePages: () => [
    { url: 'https://example.com/course-lab/official', title: '【虚构】公开状态', text: `【虚构协议案例】独立来源尚未确认未来结果。普通相关材料更新，第${revision}版。` },
    { url: 'https://example.com/course-lab/news', title: '【虚构】新闻线索', text: `【虚构协议案例】新闻转述筹备进展，第${revision}版；未证明目标事件已发生。` },
    { url: 'https://example.com/course-lab/verification', title: '【虚构】反证记录', text: `【虚构协议案例】核验研究员指出：计划与结果不同，第${revision}版。` },
  ] })
  const sourceTools = { capabilities: gateway.capabilities, toolsFor(options) {
    return gateway.toolsFor(options).map((tool) => spec.id === 'no-quote' && tool.toolId === 'get_market_quote' ? { ...tool, execute: async () => ({ status: 'error', data: null, evidenceIds: [], observedAt: NOW, summary: '【受控故障】现价暂不可用。', error: { code: 'QUOTE_UNAVAILABLE', retryable: false }, usage: null }) } : tool)
  } }
  const open = () => createCourseService({ path: join(folder, 'course.sqlite'), workbench, provider, sourceTools, modelMode: 'mock', now: () => NOW })
  let service = open()
  try {
    const created = service.createRequest({ question: spec.question, horizonHours: 24, watch: spec.id === 'update' })
    await service.idle()
    let record = service.getRequest(created.requestId)
    const checks = []
    const verify = (condition, text) => { assert(condition, `${spec.id}: ${text}`); checks.push(text) }
    const snapshots = []
    const snapshot = (label) => snapshots.push({ label, runId: record.run.runId, status: record.run.status, collaboration: record.run.collaboration,
      baseline: record.normalized?.baseline || null, usage: record.run.usage, error: record.run.error, forecastCount: record.forecasts.length })
    if (spec.id === 'recovery') {
      verify(record.run.status === 'failed' && record.run.error.code === 'MODEL_AUTH_FAILED', '鉴权失败停止执行并保留安全错误')
      snapshot('失败记录'); blocked = false
      service.check(created.requestId); await service.idle(); record = service.getRequest(created.requestId)
      verify(record.runs[0].status === 'failed' && record.run.status === 'completed', '同题重试成功，原失败历史保留')
    }
    verify(record.run.status === 'completed', '完整协作发布完成')
    verify(record.forecast.scoringEligible === false, '模拟结果不可计分')
    verify(record.run.collaboration.reviews.length > 0, '保存带证据的定向补查及答复')
    verify(record.forecast.decisionNotes.length === record.run.assignments.length, '各份报告均有公开裁决说明')
    if (['wrong-asset', 'no-quote', 'gold'].includes(spec.id)) {
      verify(record.normalized.conditionalOnly === true && !record.normalized.baseline.verified, '基准缺失或错配时保持条件估计')
      if (spec.id !== 'gold') verify(record.run.assignments.find((item) => item.roleId === 'market').report.status === 'insufficient', '首轮市场报告明确资料不足')
    } else if (['btc', 'eth', 'update'].includes(spec.id)) verify(record.normalized.baseline.pair === (spec.id === 'eth' ? 'ETH-USD' : 'BTC-USD'), '固定基准与原题资产匹配')
    snapshot('初次协作')
    if (spec.id === 'update') {
      const baseline = structuredClone(record.normalized.baseline), firstForecast = record.forecast.forecastId
      revision++
      service.check(created.requestId); await service.idle(); record = service.getRequest(created.requestId)
      verify(record.run.triage.kind === 'local' && record.run.collaboration.team.length === 2, '新正文触发相关研究员与核验席局部复核')
      assert.deepEqual(record.normalized.baseline, baseline)
      verify(record.run.memory.previousForecast.forecastId === firstForecast, '复核实际载入上一判断记忆，固定基准不变')
      snapshot('新证据局部复核')
      const count = record.forecasts.length
      service.check(created.requestId); await service.idle(); record = service.getRequest(created.requestId)
      verify(record.run.triage.kind === 'no_change' && record.forecasts.length === count && !record.run.assignments.length, '重复检查不派工、不增加概率点')
      snapshot('重复资料检查')
    }
    const lastRunId = record.run.runId
    const before = record.run.collaboration
    await service.close(); service = open()
    assert.deepEqual(service.getRun(lastRunId).collaboration, before)
    checks.push('关闭并重开SQLite后协作记录完整一致')
    return { ...spec, mode: 'mock', sourceMode: 'replay', notAccuracyBenchmark: true, checks, snapshots,
      metrics: { runs: record.runs.length, forecasts: record.forecasts.length, modelRequests: record.runs.reduce((sum, run) => sum + run.usage.modelRequests, 0),
        toolCalls: record.runs.reduce((sum, run) => sum + run.usage.toolCalls, 0), totalTokens: record.runs.reduce((sum, run) => sum + run.usage.totalTokens, 0) } }
  } finally { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) }
}

export async function runCases() {
  const cases = []
  for (const spec of CASES) cases.push(await runCase(spec))
  return { version: 1, generatedAt: new Date().toISOString(), fixtureClock: NOW, notAccuracyBenchmark: true,
    description: '受控虚构材料驱动真实本地工具与编排；模型回答及token均为协议模拟，不是DeepSeek实跑或预测准确率实验。', cases }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCases()
  const output = new URL('../web/demo/cases.json', import.meta.url)
  await mkdir(dirname(fileURLToPath(output)), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`已验证 ${result.cases.length} 个离线案例，生成 web/demo/cases.json（不含真实预测成绩）。`)
}
