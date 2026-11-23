import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { warningQuestion } from './warning-case.mjs'

// Explicit opt-in only. Never accepts, reads or persists a provider key.
if (!process.argv.includes('--start') && !process.argv.includes('--resume')) {
  console.log('先启动start:live并在模型连接页保存Key。显式运行：node scripts/live-warning-case.mjs --start [--base=http://127.0.0.1:4174]；中断后用--resume，不新建案例。')
  process.exit(0)
}
const base = new URL(process.argv.find(x => x.startsWith('--base='))?.slice(7) || 'http://127.0.0.1:4174')
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('Only a local research-room origin is allowed')
const stateFile = new URL('../.data/warning-live-driver.json', import.meta.url), archiveFile = new URL('../docs/evidence/warning-live-validation.json', import.meta.url)
async function api(path, body) {
  const response = await fetch(new URL('/api/v1/course/' + path, base), { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Local API request failed'), { code: data.error?.code })
  return data
}
let state
try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!state) {
  if (!process.argv.includes('--start')) throw Error('No saved run to resume')
  const config = await api('provider-connection')
  if (!config.configured) throw Error('请先在本地模型连接页保存临时Key；尚未发起模型请求。')
  const targetAt = new Date(Date.now() + 15 * 60000).toISOString()
  const request = await api('requests', warningQuestion(targetAt))
  state = { requestId: request.requestId, targetAt, base: base.origin, tokenLimit: request.budget?.maxTotalTokens || 80000 }
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true }); await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n')
} else if (state.base !== base.origin) throw Error('Saved run belongs to another local port; pass its --base URL')
console.log(JSON.stringify({ requestId: state.requestId, targetAt: state.targetAt, paidCaseLimit: 1, totalTokenLimit: state.tokenLimit || 160000 }))
let record, lastLogged = 0
for (;;) {
  record = await api('requests/' + state.requestId)
  const run = record.latestRun
  if (Date.now() - lastLogged > 30000) { console.log(JSON.stringify({ status: run.status, phase: run.phase, usage: run.usage, error: run.error })); lastLogged = Date.now() }
  if (run.status === 'failed' && run.phase === 'review' && run.error?.code === 'MODEL_INCOMPLETE' && !run.usage.unknownUsage && !run.summaryResumeCount && Date.now() < Date.parse(state.targetAt)) {
    await api('runs/' + run.runId + '/resume-summary', {}); continue
  }
  if (['completed', 'failed', 'insufficient', 'cancelled'].includes(run.status)) break
  await delay(3000)
}
if (record.forecast) {
  while (Date.now() < Date.parse(state.targetAt) + 1000) { await delay(Math.min(10000, Date.parse(state.targetAt) + 1000 - Date.now())); if (Date.now() - lastLogged > 30000) { console.log('预测已封存，等待目标时点；没有模型监听或重复取证。'); lastLogged = Date.now() } }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await api('requests/' + state.requestId + '/resolve', {}); break }
    catch (error) { if (error.code !== 'RESULT_SOURCE_UNAVAILABLE' || attempt === 2) { console.log(JSON.stringify({ resolutionError: error.code, message: error.message })); break }; await delay(5000) }
  }
}
record = await api('requests/' + state.requestId)
const run = record.latestRun
const archive = { version: 1, kind: 'warning-live-validation', notAccuracyBenchmark: true, capturedAt: new Date().toISOString(), requestId: record.requestId,
  title: '真实警告预测：发布到结果核验', question: record.question, mode: 'live', targetAt: state.targetAt, status: record.status,
  metrics: { runs: record.runs.length, forecasts: record.forecasts.length, modelRequests: run.usage.modelRequests, toolCalls: run.usage.toolCalls, totalTokens: run.usage.totalTokens },
  checks: [], forecast: record.forecast, result: record.result, normalized: record.normalized, error: run.error, assignments: run.assignments,
  snapshots: [{ label: '真实预测协作（只读）', status: run.status, collaboration: run.collaboration }],
  events: run.events.filter(e => ['team.selected', 'forecast.published', 'research.resume_requested', 'run.finished', 'resolution.recorded'].includes(e.type)) }
if (record.forecast) archive.checks.push('真实模型目标前发布预测')
if (new Set(run.assignments.filter(a => !a.followUp).map(a => a.roleId)).size === 3) archive.checks.push('从十类目录按题派出三类研究员，完成情况保留在逐份记录')
if (record.forecast?.reasoningClaims?.every(c => c.citations?.length)) archive.checks.push('预测依据保留逐条已读原文片段')
if (record.result) archive.checks.push('到期取得完整官方快照并单独保存结果', '计算单题Brier并保留资格标识')
await writeFile(archiveFile, JSON.stringify(archive, null, 2) + '\n')
console.log(JSON.stringify({ status: record.status, reportFile: 'docs/evidence/warning-live-validation.json', metrics: archive.metrics, outcome: record.result?.outcome ?? null, scores: record.result?.scores || [] }))
