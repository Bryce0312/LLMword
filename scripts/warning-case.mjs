import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCourseService } from '../server/course/course-service.mjs'
import { createCourseMockProvider } from '../server/course/course-mock-provider.mjs'
import { createWorkbenchService } from '../server/domain/workbench-service.mjs'
import { createWebResearchGateway } from '../server/course/web-tools.mjs'
import { WARNING_URL, WARNING_RULE, readWarnings } from '../server/course/weather-warning.mjs'
import { groundingPolicy } from '../server/domain/claim-grounding.mjs'
import { RuntimeError } from '../server/runtime/model-provider.mjs'

export function warningQuestion(targetAt) { return { question: '香港天文台在固定目标时点后的首次有界观察中，红色火灾危险警告是否仍有效？', mode: 'strict', watch: false,
  strict: { targetAt, resolutionSourceUrl: WARNING_URL, resolutionRule: WARNING_RULE, timezone: 'Asia/Shanghai' } } }

export async function runWarningCase({ truncateSummary = false, onModel } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'warning-prediction-')), workbenchPath = join(folder, 'domain.sqlite'), coursePath = join(folder, 'course.sqlite')
  let at = '2026-11-21T00:00:00.000Z', resolutionReads = 0, failRead = true
  const now = () => at, targetAt = '2026-11-21T00:15:00.000Z'
  const workbench = createWorkbenchService({ path: workbenchPath, now }), mock = createCourseMockProvider(), sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now })
  let truncated = false
  const provider = { ...mock, async complete(input) { await onModel?.(input); const response = await mock.complete(input); if (truncateSummary && !truncated && response.message.tool_calls?.some(call => call.function.name === 'propose_forecast')) { truncated = true; throw new RuntimeError('MODEL_INCOMPLETE', 'controlled truncation', { usage: { total_tokens: 100 } }) }; return response } }
  const open = () => createCourseService({ path: coursePath, workbench, provider, sourceTools, now, evidencePolicy: groundingPolicy,
    warningReader: async (args) => { resolutionReads++; if (failRead) throw Error('controlled source failure'); return readWarnings({ ...args, fixtureWarnings: {} }) } })
  let service = open()
  try {
    const created = service.createRequest(warningQuestion(targetAt)); await service.idle()
    if (truncateSummary) {
      const failed = service.getRequest(created.requestId); assert.equal(failed.run.error.code, 'MODEL_INCOMPLETE')
      const tools = failed.run.usage.toolCalls; service.resumeResearchSummary(failed.run.runId); await service.idle()
      assert.equal(service.getRequest(created.requestId).run.usage.toolCalls, tools)
    }
    const before = service.getRequest(created.requestId)
    assert.equal(before.run.status, 'completed', JSON.stringify({ error: before.run.error, workers: before.run.assignments.map(a => ({ role: a.roleId, status: a.status, error: a.error })) }))
    assert(before.forecast); assert.equal(before.forecast.groundingPolicy, groundingPolicy)
    assert.equal(before.run.assignments.filter(a => !a.followUp).length, 3)
    assert.equal(before.normalized.temporalPolicy, 'at_target')
    await assert.rejects(service.resolve(created.requestId), { code: 'RESULT_NOT_AVAILABLE' }); assert.equal(resolutionReads, 0)
    const oldForecast = JSON.stringify(before.forecast), oldEvidence = JSON.stringify(before.run.evidence), usage = JSON.stringify(before.run.usage)
    at = '2026-11-21T00:15:01.000Z'
    await assert.rejects(service.resolve(created.requestId), { code: 'RESULT_SOURCE_UNAVAILABLE' })
    assert.equal(service.getRequest(created.requestId).result, null)
    failRead = false
    const result = await service.resolve(created.requestId)
    assert.equal(result.outcome, 0); assert.equal(result.scoringEligible, false); assert(result.scores.every(s => s.scoringEligible === false))
    const reads = resolutionReads; assert.deepEqual(await service.resolve(created.requestId), result); assert.equal(resolutionReads, reads)
    const after = service.getRequest(created.requestId)
    assert.equal(JSON.stringify(after.forecast), oldForecast); assert.equal(JSON.stringify(after.run.evidence), oldEvidence); assert.equal(JSON.stringify(after.run.usage), usage)
    assert.equal(after.result.evidence[0].purpose, 'resolution'); assert.equal(after.result.scores[0].brier, before.forecast.probabilityYes ** 2)
    await service.close(); service = open(); assert.deepEqual(service.getRequest(created.requestId).result, result)
    return { version: 1, id: 'hko-red-fire', title: '红色火灾危险警告：预测到结果核验', question: before.question, mode: 'mock', notAccuracyBenchmark: true,
      checks: ['三类角色独立调用官方警告工具','逐条依据有已读原文片段','目标前禁止结果核验','来源失败不判No','目标后有效快照确定结果并计算协议Brier','重复核验不重复读取','原概率、证据和模型用量不回写','数据库重开结果一致'],
      metrics: { runs: 1, forecasts: 1, modelRequests: after.run.usage.modelRequests, toolCalls: after.run.usage.toolCalls, totalTokens: after.run.usage.totalTokens },
      snapshots: [{ label: '预测发布', status: before.run.status, collaboration: before.run.collaboration }, { label: '结果核验后（原预测保留）', status: after.run.status, collaboration: after.run.collaboration }], result }
  } finally { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = await runWarningCase(), path = new URL('../web/demo/warning-case.json', import.meta.url), cases = [data]
  // Public immutable live snapshots stay visible when a teammate regenerates mock cases.
  for (const name of ['warning-live-attempt-one.json', 'warning-live-validation.json']) {
    let archive
    try { archive = JSON.parse(await readFile(new URL('../docs/evidence/' + name, import.meta.url), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (archive.mode !== 'live' || archive.notAccuracyBenchmark !== true || !archive.requestId || !Array.isArray(archive.snapshots)) throw Error('Invalid public warning archive: ' + name)
    cases.push({ ...archive, id: 'hko-red-fire-' + archive.requestId, title: archive.forecast ? '真实警告预测：维护恢复与到期核验' : '真实警告预测：资料不足未发布' })
  }
  await mkdir(dirname(fileURLToPath(path)), { recursive: true }); await writeFile(path, JSON.stringify({ version: 1, notAccuracyBenchmark: true, cases }, null, 2) + '\n'); console.log(JSON.stringify({ checks: data.checks, metrics: data.metrics, result: data.result.outcome, publicLiveArchives: cases.length - 1 }))
}
