import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import { setTimeout as delay } from 'node:timers/promises'
import { runWorker } from '../runtime/worker-loop.mjs'
import { abortable, checkCancelled } from '../runtime/model-provider.mjs'
import { getAgentCatalog } from '../domain/agent-catalog.mjs'
import { digest, validDate, validUrl } from '../domain/contracts.mjs'
import { createCourseStore, courseFailure } from './course-store.mjs'
import { nativeTool, validators } from './course-contracts.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { legacyMainSystem, modernMainSystem } from './course-prompts.mjs'
import { COURSE_ROLE_IDS, roleCatalogue, suggestedRoles, requestTime, makeTimeContext, timedQuestion, presetAssumptions, resolveRequestDeadline, hasTodayCalendarDeadline, requiresWeatherObservation } from './course-context.mjs'

const roles = COURSE_ROLE_IDS
const terminal = new Set(['completed', 'insufficient', 'failed', 'cancelled'])
const ajv = new Ajv({ allErrors: true, strict: true })
const urlKey = (url) => { try { const value = new URL(url); value.hash = ''; return value.href } catch { return url } }
const runtimeMessages = { BUDGET_EXHAUSTED: '研究员已用完本次调查预算，保留取得的证据和缺口。', DEADLINE_EXCEEDED: '调查任务已过执行期限。', MODEL_TIMEOUT: '模型请求超时，请稍后重试。', MODEL_NETWORK: '模型服务连接暂时失败，请稍后重试。',
  MODEL_HTTP: '模型服务拒绝请求，请检查服务配置后手动重试。', MODEL_BALANCE_REQUIRED: '模型服务余额不足，请确认账户额度后手动重试。', MODEL_AUTH_FAILED: '模型服务鉴权失败，请检查服务端凭据后手动重试。',
  MODEL_ACCESS_DENIED: '模型服务拒绝访问，请检查凭据、模型权限或服务设置后手动重试。', MODEL_RATE_LIMITED: '模型服务请求过于频繁，请稍后重试。', MODEL_SERVICE_UNAVAILABLE: '模型服务暂时不可用，请稍后重试。',
  SOURCE_BALANCE_REQUIRED: '联网资料服务余额不足，已暂停自动检查；确认账户额度后可手动重试。', SOURCE_AUTH_FAILED: '联网资料服务鉴权失败，已暂停自动检查；请检查服务端凭据。', SOURCE_ACCESS_DENIED: '联网资料服务拒绝访问，已暂停自动检查；请检查服务权限。',
  MODEL_PROTOCOL: '模型未返回合法的工具调用协议。', MODEL_INCOMPLETE: '模型输出未完整结束，可能达到输出长度上限，未保存为报告。', REPORT_REQUIRED: '研究员没有提交必需的结构化报告。' }
const hardProviderCodes = new Set(['MODEL_BALANCE_REQUIRED', 'MODEL_AUTH_FAILED', 'MODEL_ACCESS_DENIED', 'SOURCE_BALANCE_REQUIRED', 'SOURCE_AUTH_FAILED', 'SOURCE_ACCESS_DENIED'])
const blockingProviderFailure = (error) => hardProviderCodes.has(error?.code) || error?.code === 'MODEL_HTTP' && error.retryable === false
const errorValue = (error) => {
  error ||= {}
  const known = Object.hasOwn(runtimeMessages, error.code)
  const httpStatus = error.httpStatus ?? (known ? error.status : undefined)
  const actionRequired = blockingProviderFailure(error)
  return { code: error.courseSafe ? error.code : known ? error.code : 'COURSE_FAILED',
    message: known ? runtimeMessages[error.code] : error.courseSafe ? error.message : '本轮调查未能完成，请检查模型、来源或运行预算。', retryable: !actionRequired && Boolean(error.retryable),
    ...(known && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(known && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? { retryAfterMs: Math.min(Math.round(error.retryAfterMs), 30000) } : {}),
    ...(actionRequired ? { actionRequired: true } : {}) }
}
const compactContract = (value) => value ? Object.fromEntries(['question', 'type', 'object', 'timezone', 'targetAt', 'forecastClosesAt', 'resolutionRule', 'resolutionSource', 'unresolvablePolicy', 'temporalPolicy'].map((key) => [key, value[key]])) : null
const compactReport = (item) => ({ roleId: item.roleId, assignmentId: item.assignmentId, followUp: item.followUp,
  ...Object.fromEntries(['status', 'summary', 'evidenceIds', 'support', 'counterevidence', 'missingEvidence', 'probability'].map((key) => [key, item.report[key]])) })
const contractContext = (request, timeContext, latestReference) => request.normalized ? { ...compactContract(request.normalized), question: timedQuestion(request.question, timeContext, request.normalized.temporalPolicy),
  timeContext, defaultAssumptions: request.normalized.defaultAssumptions || [], baseline: request.normalized.baseline || null, currentReference: latestReference || request.normalized.currentReference || null,
  researchBasis: request.normalized.researchBasis || null, sourceLimitations: request.normalized.sourceLimitations || [] } : null
const explicitDate = (question) => /20\d\d[-/.年]\d{1,2}|\d{1,2}月\d{1,2}|(?:今天|明天|后天|下周|下个月|月底|星期[一二三四五六日天]|周[一二三四五六日天])|\b(?:tomorrow|today|next\s+(?:week|month))\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(question)
function durationHours(question) {
  const hour = /(\d+)\s*(?:小时|hours?\b|h\b)/i.exec(question)
  if (hour) return Number(hour[1])
  const day = /(\d+|一|二|两|三|四|五|六|七)\s*(?:天|days?\b)/i.exec(question)
  if (day) return (Number(day[1]) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 })[day[1]]) * 24
  return /(?:一周|1\s*week)/i.test(question) ? 168 : null
}

export function createCourseService({ path, workbench, provider = createCourseMockProvider(), modelMode = 'mock', sourceTools,
  now = () => new Date(), watchIntervalMs = 3_600_000, harnessVersion = 3 } = {}) {
  if (!workbench?.createTopic || !workbench?.createPrediction || !sourceTools?.toolsFor) throw courseFailure('COURSE_CONFIG', '课程运行时需要领域工作台与实际来源网关。', 500)
  if (!['mock', 'live'].includes(modelMode) || !Number.isInteger(watchIntervalMs) || watchIntervalMs < 1000) throw courseFailure('COURSE_CONFIG', '模型模式或检查间隔无效。')
  if (![2, 3].includes(harnessVersion)) throw courseFailure('COURSE_CONFIG', '编排版本无效。')
  const store = createCourseStore({ path, now })
  const jobs = new Map()
  const listeners = new Set()
  const identity = provider.configurationId || provider.model || 'injected-course-provider'
  const sourceMode = sourceTools.capabilities?.sourceMode || (sourceTools.capabilities?.mode === 'mock' ? 'replay' : 'unavailable')
  const thinking = provider.settings?.thinking === 'enabled'
  const maxOutput = Math.min(thinking ? 32768 : 4800, provider.settings?.outputCapConfigured ? provider.settings.maxOutputTokens : thinking ? 16384 : 4800)
  const timeoutMs = Math.min(300000, Math.max(provider.settings?.timeoutMs || 0, thinking ? 180000 : 90000))
  const budget = { maxTotalTokens: 300000, maxModelRequests: 40, maxToolCalls: 64, mainRequests: 16, maxTokens: maxOutput, timeoutMs,
    worker: { maxModelRequests: 6, maxToolCalls: 6, maxTotalTokens: 65536, maxTokens: maxOutput, timeoutMs, maxRetries: 1 } }
  const configuration = { providerIdentity: identity, modelRef: provider.model || null, modelMode, sourceMode, budget, harnessVersion }
  const legacyBudget = { maxModelRequests: 32, maxToolCalls: 48, mainRequests: 12, maxTokens: 2400, timeoutMs: 60000,
    worker: { maxModelRequests: 5, maxToolCalls: 4, maxTotalTokens: 32000, maxTokens: 2400, timeoutMs: 60000, maxRetries: 1 } }
  const runBudget = (runId) => store.requireRun(runId).budget || legacyBudget
  const modern = (run) => run.harnessVersion >= 3
  const cycleOf = (run) => run.state.cycle || 1
  const followUpsUsed = (run) => run.state.followUpsUsed || 0
  const followUpLimit = (run) => modern(run) ? 2 : 1
  const budgetView = (value) => Object.fromEntries(['maxModelRequests', 'maxToolCalls', 'maxTotalTokens', 'maxTokens', 'mainRequests'].filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]))
  const orchestrationView = (run) => modern(run) ? { cycle: cycleOf(run), maxCycles: 3, followUpsUsed: followUpsUsed(run), maxFollowUps: 2,
    investigationSteps: 5, reportStep: 6, stage: run.phase } : null
  let stopping = false
  let timer
  let lastEmitted = store.listEvents({ limit: 1000 }).at(-1)?.seq || 0
  const clock = () => store.clock()
  const notify = () => {
    while (true) {
      const batch = store.listEvents({ afterSeq: lastEmitted, limit: 1000 })
      for (const event of batch) { lastEmitted = event.seq; for (const listener of listeners) { try { listener(event) } catch {} } }
      if (batch.length < 1000) break
    }
  }
  function ensure(runId, signal) {
    checkCancelled(signal)
    if (stopping) throw courseFailure('SERVICE_STOPPED', '服务正在关闭，检查点保留。', 409)
    const run = store.requireRun(runId)
    if (terminal.has(run.status) || store.requireRequest(run.requestId).status === 'stopped') throw courseFailure('COURSE_CANCELLED', '本题已经停止。', 409)
    return run
  }
  const event = (runId, type, payload, eventId) => { store.event(runId, { type, payload, ...(eventId ? { eventId } : {}) }); notify() }
  function pauseProviderWatch(requestId, failure) {
    const request = store.requireRequest(requestId)
    if (request.status === 'stopped') return
    const reason = errorValue(failure)
    store.saveWatch(requestId, { status: 'paused_provider', nextDueAt: null, pauseReason: { ...reason, actionRequired: true }, blockedAt: clock() })
  }
  function registerProviderFault(runId, failure, toolEvent) {
    const run = store.requireRun(runId)
    if (terminal.has(run.status)) return
    const saved = errorValue(failure)
    if (run.usage.modelRequests > 0 && !run.usage.unknownUsage) store.recordUsage(runId, undefined)
    for (const item of store.listAssignments(runId)) if (!['completed', 'failed', 'cancelled'].includes(item.status)) {
      store.saveAssignment(item.assignmentId, { status: 'failed', error: saved })
    }
    store.saveRun(runId, { status: 'failed', error: saved, message: saved.message, state: { ...run.state, providerFault: saved } }, [
      ...(toolEvent ? [{ eventId: `${runId}_provider_tool_${toolEvent.toolCallId}`, type: 'tool.failed', payload: { ...toolEvent, status: 'error', summary: saved.message, evidenceIds: [] } }] : []),
      { eventId: `${runId}_provider_blocked`, type: 'run.finished', payload: { status: 'failed', summary: saved.message, error: saved } },
    ])
    pauseProviderWatch(run.requestId, saved)
    notify()
    jobs.get(runId)?.controller.abort()
  }
  function pauseKnownProviderFailures() {
    for (const watch of store.listWatches()) {
      if (watch.status !== 'active') continue
      const latest = store.listRuns({ requestId: watch.requestId }).at(-1)
      if (latest?.status === 'failed' && blockingProviderFailure(latest.error)) pauseProviderWatch(watch.requestId, latest.error)
    }
  }
  function providerFor(runId) {
    return { ...provider, async complete(input) {
      ensure(runId, input.signal)
      store.reserve(runId, 'modelRequests', runBudget(runId).maxModelRequests)
      let result
      try { result = await provider.complete(input) }
      catch (error) {
        if (!stopping && !terminal.has(store.requireRun(runId).status)) {
          try { store.recordUsage(runId, error?.usage?.total_tokens, error?.usage) }
          catch (budgetError) { if (error?.usage) budgetError.usage = error.usage; throw budgetError }
        }
        if (blockingProviderFailure(error)) registerProviderFault(runId, error)
        throw error
      }
      ensure(runId, input.signal)
      store.recordUsage(runId, result.usage?.total_tokens, result.usage)
      return result
    } }
  }
  function toolsFor(runId, readerId, roleId, signal) {
    const currentRun = store.requireRun(runId)
    const request = store.requireRequest(currentRun.requestId)
    const normalized = request.normalized
    const specifiedSource = normalized?.resolutionSource?.url || request.strict?.resolutionSourceUrl
    const tools = sourceTools.toolsFor({ roleId, question: normalized || { question: request.question },
      sourceDomains: roleId === 'official' && specifiedSource ? [new URL(specifiedSource).hostname] : undefined,
      allowSourceDiscovery: roleId === 'official' && modern(currentRun) && Boolean(currentRun.state.draft) && !normalized && !specifiedSource,
      async onEvidence(record) {
        const run = ensure(runId, signal)
        if (!record.text?.trim() || !validUrl(record.url)) throw courseFailure('SOURCE_TEXT_REQUIRED', '仅有链接或摘要不能登记为已读原文。')
        const contentHash = `sha256:${createHash('sha256').update(record.text).digest('hex')}`
        const evidenceId = `course_evidence_${digest([run.topicId, record.url, record.title, contentHash, record.publishedAt || null]).slice(0, 32)}`
        const input = { evidenceId, title: record.title.slice(0, 240) || '已取得原文', text: record.text.slice(0, 4000), url: record.url,
          publishedAt: record.publishedAt || null, predictionIds: [],
          sourceMode: record.sourceMode === 'live' ? 'live' : 'replay' }
        const saved = workbench.addEvidence(run.topicId, input)
        const proof = { ...record, ...saved, text: record.text, contentHash, predictionId: run.predictionId,
          predictionVersion: run.predictionVersion, topicId: run.topicId, fixture: Boolean(record.fixture) }
        store.recordEvidence(runId, proof, readerId)
        return { evidenceId: saved.evidenceId }
      },
    })
    return tools.map((tool) => ({ ...tool, async execute(args, context) {
      ensure(runId, signal)
      const key = `${readerId}:${context.toolCallId}`
      const input = { toolId: tool.toolId, args }
      const previous = store.getReceipt(runId, key, input)
      let result = previous
      if (!result) {
        store.reserve(runId, 'toolCalls', runBudget(runId).maxToolCalls)
        result = await tool.execute(tool.toolId === 'search_web' ? { ...args, maxResults: Math.min(args.maxResults || 2, 5) } : args, { ...context, signal: context.signal || signal })
      }
      ensure(runId, signal)
      if (!previous) store.saveReceipt(runId, key, input, result)
      const sourceStatus = result.error?.httpStatus
      if (result.status === 'error' && ([401, 402, 403].includes(sourceStatus) || ['SOURCE_BALANCE_REQUIRED', 'SOURCE_AUTH_FAILED', 'SOURCE_ACCESS_DENIED', 'SEARCH_BALANCE_REQUIRED', 'SEARCH_AUTH_FAILED'].includes(result.error?.code))) {
        const sourceCode = sourceStatus === 402 || /BALANCE/.test(result.error.code) ? 'SOURCE_BALANCE_REQUIRED' : sourceStatus === 401 || /AUTH_FAILED/.test(result.error.code) ? 'SOURCE_AUTH_FAILED' : 'SOURCE_ACCESS_DENIED'
        const failure = Object.assign(courseFailure(sourceCode, runtimeMessages[sourceCode]), { httpStatus: sourceStatus || ({ SOURCE_BALANCE_REQUIRED: 402, SOURCE_AUTH_FAILED: 401, SOURCE_ACCESS_DENIED: 403 })[sourceCode], actionRequired: true })
        registerProviderFault(runId, failure, { agentSpecId: roleId, assignmentId: readerId, name: roleId === 'main' ? '后台与主 Agent 来源检查' : roleId, toolCallId: context.toolCallId, toolId: tool.toolId })
        throw failure
      }
      if (tool.toolId === 'search_web' && result.data?.results) {
        const watch = store.getWatch(request.requestId)
        const candidateKnown = { ...(watch?.candidateKnown || {}) }
        for (const candidate of result.data.results) candidateKnown[urlKey(candidate.url)] = digest({ url: candidate.url, title: candidate.title, snippet: candidate.snippet, publishedAt: candidate.publishedAt })
        store.saveWatch(request.requestId, { candidateKnown })
      }
      return result
    } }))
  }
  function publicRun(value) {
    if (!value) return null
    const assignments = store.listAssignments(value.runId).map(({ assignmentId, roleId, name, status, report, followUp, objective, reason, checkpoint, error, cycle, config }) => ({
      assignmentId, agentSpecId: roleId, roleId, name, status, report, followUp, objective, reason, cycle: cycle || 1, budget: budgetView(config?.budget), usage: checkpoint?.usage || null, error: error || null,
    }))
    return { runId: value.runId, requestId: value.requestId, status: value.status, phase: value.phase, trigger: value.trigger,
      topicId: value.topicId, predictionId: value.predictionId, predictionVersion: value.predictionVersion, modelMode: value.modelMode,
      sourceMode: value.sourceMode, createdAt: value.createdAt, updatedAt: value.updatedAt, usage: value.usage, error: value.error,
      harnessVersion: value.harnessVersion || 2, budget: budgetView(value.budget), draft: value.state.draft || null, orchestration: orchestrationView(value),
      modelRef: value.modelRef || null, team: value.state.team || assignments.filter((item) => !item.followUp).map(({ roleId, name, objective, reason }) => ({ roleId, name, objective, reason })),
      triage: value.state.triage || null, memory: value.state.memory ? (({ historical, sourceRunIds, previousForecast, reportCount, relationCount, summary, policy, shortTerm, longTerm, recentJudgments }) => ({ historical, sourceRunIds, previousForecast, reportCount, relationCount, summary, policy, shortTerm, longTerm, recentJudgments }))(value.state.memory) : null,
      timeContext: value.state.timeContext || null, currentReference: value.state.latestReference || null,
      summary: value.message || '', assignments, events: store.listEvents({ runId: value.runId }),
      evidence: store.evidenceFor(value.runId), forecast: store.listForecasts({ requestId: value.requestId }).find((item) => item.runId === value.runId) || null }
  }
  function publicRequest(request) {
    const runs = store.listRuns({ requestId: request.requestId }).map(publicRun)
    const latestRun = runs.at(-1) || null
    const forecasts = store.listForecasts({ requestId: request.requestId })
    const { providerIdentity, ...safe } = request
    return { ...safe, modelMode: latestRun?.modelMode || safe.modelMode, sourceMode: latestRun?.sourceMode || safe.sourceMode,
      activeRunId: runs.find((run) => !terminal.has(run.status))?.runId || null,
      runs, run: latestRun, latestRun, forecast: forecasts.at(-1) || null, forecasts,
      watch: store.getWatch(request.requestId), result: store.getResult(request.requestId),
      evidence: [...new Map(runs.flatMap((run) => run.evidence).map((item) => [item.evidenceId, item])).values()],
      relations: store.listRelations({ requestId: request.requestId }) }
  }
  function scheduleWatch(requestId) {
    const request = store.requireRequest(requestId)
    const previous = store.getWatch(requestId)
    const known = { ...(previous?.known || {}) }
    for (const run of store.listRuns({ requestId })) for (const item of store.evidenceFor(run.runId)) known[urlKey(item.url)] = item.contentHash
    const closesAt = request.normalized?.forecastClosesAt || resolveRequestDeadline(request)
    const ended = store.getResult(requestId) || Date.parse(closesAt) <= Date.parse(clock())
    return store.saveWatch(requestId, { status: request.watch === false ? 'off' : ended ? 'completed' : 'active', known,
      lastReference: store.listForecasts({ requestId }).at(-1)?.currentReference || previous?.lastReference || request.normalized?.currentReference || null,
      policySummary: '先去重；价格累计变化至少0.5%或出现新相关正文才分诊。普通变化相关研究员加核验两人，重大或冲突召回本题团队；不等所有来源轮询完成。',
      query: request.normalized?.watchQuery || request.question.slice(0, 120), intervalMs: watchIntervalMs,
      nextDueAt: request.watch === false || ended ? null : new Date(Math.min(Date.parse(closesAt), Date.parse(clock()) + watchIntervalMs)).toISOString() })
  }
  function finish(runId, status, message) {
    const run = store.requireRun(runId)
    scheduleWatch(run.requestId)
    store.saveRun(runId, { status, phase: 'finished', message }, [{ eventId: `${runId}_finished`, type: 'run.finished', payload: { status, summary: message } }])
    notify()
  }
  function assignment(runId, roleId, objective, reason, followUp = false, cycle = 1) {
    const run = store.requireRun(runId)
    const request = store.requireRequest(run.requestId)
    const template = workbench.getAgent?.(roleId) || getAgentCatalog().find((item) => item.agentSpecId === roleId)
    const allowedTools = toolsFor(runId, 'main', roleId, jobs.get(runId)?.controller.signal).map((tool) => tool.toolId)
    const workerBudget = runBudget(runId).worker
    const assignmentId = `${runId}_${roleId}_${followUp ? modern(run) ? `followup_${cycle}` : 'followup' : 'initial'}`
    const prior = store.listAssignments(runId).find((item) => item.assignmentId === assignmentId)
    if (prior) return prior
    const draft = run.state.draft
    return store.createAssignment(runId, { assignmentId, roleId, name: template.name, objective, reason, followUp, cycle,
      agentSpec: { ...template, allowedTools, extensionSlots: [null, null], limits: workerBudget,
        instructions: `${template.instructions}\n本次最多${workerBudget.maxModelRequests}次模型请求、${workerBudget.maxToolCalls}次工具调用、累计${workerBudget.maxTotalTokens} tokens、单次输出最多${workerBudget.maxTokens} tokens。前最多5次模型决策调查，证据够可提前报告；第6次或工具预算用尽只submit_report，不凑轮数。2至4个取证动作后尽快submit_report，不反复确认全网。summary≤300中文字；支持/反证各≤3条，每条≤120字；不足列缺口。网页404或登录限制应尝试工具建议的替代公开来源，不把一次失败视作任务结束。只引用实际工具返回的evidenceId。历史记忆含同题近7天最多4次实质判断及近90天来源关系；比较历史概率和支持/反证因素，指出本轮新增或改变之处。旧资料不是本轮新证据，必须重新读取才可引用。有限资料可以给条件化判断，不得伪造基准值。目标时间只能使用timeContext服务器本地标签，禁止自行将Z时钟解释成本地；文字需日期时用{{TARGET_LOCAL}}，由服务器展示。当前事实不等于未来目标结果。${!request.normalized ? '\n题目当前是待核验草稿，尚无正式可结算契约。主动寻找并读取可靠结果来源，核查规则/实体/基准，不需要等主Agent先给材料；strict已填来源与条件必须核查，不能改写。' : ''}${followUp ? '\n第' + cycle + '轮定向补查/答复上下文：' + JSON.stringify(store.listAssignments(runId).filter((item) => item.report).map(compactReport)) : '\n本轮初始任务独立，不读取同伴新报告。'}` },
      config: { topicId: run.topicId, predictionId: run.predictionId || `prediction_${request.requestId}`, runId, assignmentId, agentInstanceId: `${assignmentId}_actor`,
        agentSpecId: roleId, specVersion: template.specVersion, objective: JSON.stringify({ task: objective,
          contract: contractContext(request, run.state.timeContext || requestTime(request, clock()), run.state.latestReference), draft: !request.normalized ? draft : null, strict: request.strict || null, cycle, timeContext: run.state.timeContext || requestTime(request, clock()),
          historicalMemory: run.state.memory || null, newEvidenceIds: run.state.triage?.newEvidenceIds || [] }),
        allowedTools, inputEvidence: [], timePolicy: 'live',
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(), budget: workerBudget } })
  }
  async function runAssignments(runId, signal, followUp) {
    const current = store.requireRun(runId)
    const assignments = store.listAssignments(runId).filter((item) => Boolean(item.followUp) === followUp && (!followUp || !modern(current) || item.cycle === cycleOf(current)))
    const results = await Promise.allSettled(assignments.map(async (item) => {
      if (item.status === 'completed') return item.report
      store.saveAssignment(item.assignmentId, { status: 'running' })
      const value = await runWorker({ provider: providerFor(runId), assignment: item.config, agentSpec: item.agentSpec,
        tools: toolsFor(runId, item.assignmentId, item.roleId, signal), enabledToolIds: item.config.allowedTools, signal,
        resume: item.checkpoint, finishOnToolBudget: true,
        onCheckpoint(checkpoint) { ensure(runId, signal); store.saveAssignment(item.assignmentId, { checkpoint, report: checkpoint.report, status: checkpoint.report ? 'completed' : 'running' }) },
        onEvent(value) {
          const payload = { ...value.payload, ...(value.type === 'assignment.started' ? { objective: item.objective, summary: item.objective } : {}),
            assignmentId: item.assignmentId, agentSpecId: item.roleId, name: item.name, followUp }
          event(runId, value.type, payload, `${item.assignmentId}_${value.type}_${payload.toolCallId || payload.resultId || payload.modelRequestId || 'start'}`)
        },
      })
      store.saveAssignment(item.assignmentId, { status: 'completed', report: value.report })
      return value.report
    }))
    ensure(runId, signal)
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      if (result.status === 'rejected') {
        store.saveAssignment(assignments[index].assignmentId, { status: 'failed', error: errorValue(result.reason) })
        event(runId, 'assignment.completed', { assignmentId: assignments[index].assignmentId, agentSpecId: assignments[index].roleId,
          name: assignments[index].name, status: 'blocked', summary: errorValue(result.reason).message })
      }
    }
    for (const item of store.listAssignments(runId)) if (item.report) store.addRelations(runId, item.assignmentId, item.report)
    const latest = store.requireRun(runId)
    const compile = modern(latest) && !store.requireRequest(latest.requestId).normalized
    store.saveRun(runId, { phase: compile ? 'prepare' : 'review', state: { ...latest.state, followUpDone: followUp || latest.state.followUpDone } })
    event(runId, 'meeting.started', { name: '主 Agent', agentSpecId: 'main', cycle: cycleOf(latest), summary: followUp ? `第${cycleOf(latest)}轮补查/答复完成，主 Agent 重新核对证据与未解决争议。` : compile ? '首批独立调查返回，主 Agent 根据真实证据核定题目，再汇报与质询。' : '独立报告已返回，主 Agent 检查争议与缺口。' })
  }
  async function checkSources(runId, signal) {
    const run = store.requireRun(runId)
    const request = store.requireRequest(run.requestId)
    const watch = store.getWatch(request.requestId) || { known: {}, checks: 0, query: request.question.slice(0, 120) }
    if (store.getResult(request.requestId) || Date.parse(request.normalized.forecastClosesAt) <= Date.parse(clock())) { finish(runId, 'insufficient', '目标已到期或结果已登记，停止更新预测。'); return }
    const tools = toolsFor(runId, 'main', 'main', signal)
    const call = async (name, args, number) => {
      const toolCallId = `watch_${number}_${name}`
      event(runId, 'tool.started', { agentSpecId: 'main', name: '后台检查', toolId: name, toolCallId }, `${runId}_${toolCallId}_start`)
      const value = await tools.find((item) => item.toolId === name).execute(args, { runId, predictionId: run.predictionId, assignmentId: 'main', toolCallId, signal })
      event(runId, value.status === 'error' ? 'tool.failed' : 'tool.completed', { agentSpecId: 'main', name: '后台检查', toolId: name, toolCallId, status: value.status, summary: value.summary, evidenceIds: value.evidenceIds }, `${runId}_${toolCallId}_done`)
      return value
    }
    const oldHashes = new Set(Object.values(watch.known || {}))
    const reference = watch.lastReference || request.normalized.baseline || request.normalized.currentReference
    const changes = () => store.evidenceFor(runId).filter((item) => {
      if (oldHashes.has(item.contentHash)) return false
      if (item.marketQuote && reference?.value) return Math.abs(item.marketQuote.value / reference.value - 1) >= 0.005
      return true
    })
    const pair = request.normalized.baseline?.pair
    if (pair && tools.some((tool) => tool.toolId === 'get_market_quote')) await call('get_market_quote', { pair }, 'quote')
    const requiredUrl = request.normalized.resolutionSource.url
    if (!store.evidenceFor(runId).some((item) => item.url === requiredUrl)) await call('fetch_page', { url: requiredUrl }, 'source')
    if (!changes().length) {
      const search = await call('search_web', { query: watch.query || request.question.slice(0, 120) }, 0)
      const candidateUrls = (search.data?.results || []).filter((candidate) => {
        const previous = watch.candidateKnown?.[urlKey(candidate.url)]
        return !previous || previous !== digest({ url: candidate.url, title: candidate.title, snippet: candidate.snippet, publishedAt: candidate.publishedAt }) || Object.hasOwn(watch.known || {}, urlKey(candidate.url))
      }).map((candidate) => candidate.url)
      const urls = [...new Set([...candidateUrls, ...Object.keys(watch.known || {})])].filter((url) => url !== requiredUrl).slice(0, 6)
      for (let index = 0; index < urls.length; index++) {
        await call('fetch_page', { url: urls[index] }, index + 1)
        if (changes().length) break
      }
    }
    const acquired = store.evidenceFor(runId)
    const fresh = changes()
    const changed = fresh.length > 0
    const known = { ...(watch.known || {}) }
    for (const item of acquired) known[urlKey(item.url)] = item.contentHash
    const latest = pair && acquired.find((item) => item.marketQuote?.pair === pair)
    const latestReference = latest ? { kind: 'price', value: latest.marketQuote.value, unit: latest.marketQuote.currency, currency: latest.marketQuote.currency,
      pair, observedAt: latest.marketQuote.observedAt, url: latest.url, evidenceId: latest.evidenceId, verified: true,
      synthetic: Boolean(latest.fixture || latest.synthetic), timestampMeaning: 'system-observation-time' } : run.state.latestReference || reference || null
    const triage = { kind: changed ? 'local' : 'no_change', reason: changed ? '首批新原文已取得，立即交主 Agent 分诊。' : '内容重复、价格变化未达阈值或来源不可读，不新增概率。',
      selectedRoleIds: [], newEvidenceIds: fresh.map((item) => item.evidenceId), duplicateCount: acquired.filter((item) => oldHashes.has(item.contentHash)).length,
      comparedToRunId: run.state.memory?.sourceRunIds?.[0] || null }
    const changeHints = { major: fresh.some((item) => /重大|冲突|major|contradict/i.test(item.text)) || Boolean(latest && reference?.value && Math.abs(latest.marketQuote.value / reference.value - 1) >= 0.05) }
    store.saveWatch(request.requestId, { known, lastTriage: triage, checks: (watch.checks || 0) + 1, lastCheckAt: clock(), lastChangeAt: changed ? clock() : watch.lastChangeAt || null })
    store.saveRun(runId, { phase: changed ? 'triage' : run.phase, state: { ...store.requireRun(runId).state, triage, changeHints, latestReference } })
    if (!changed) { event(runId, 'watch.triaged', { triage }); finish(runId, 'completed', acquired.length ? '没有新的有效材料，保留上一条概率，不重复发布。' : '本次原文不可读，保留判断与来源缺口。'); return }
    event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: '检测到新的原文内容，本轮重新派工核查，不回填过去概率。' })
  }
  async function normalize(runId, args) {
    const run = store.requireRun(runId)
    const request = store.requireRequest(run.requestId)
    const strict = request.mode === 'strict' ? request.strict : null
    if (strict && ((strict.targetAt && Date.parse(args.targetAt) !== Date.parse(strict.targetAt)) ||
      (strict.resolutionRule && args.resolutionRule !== strict.resolutionRule) ||
      (strict.resolutionSourceUrl && urlKey(args.resolutionSourceUrl) !== urlKey(strict.resolutionSourceUrl)) ||
      (strict.timezone && args.timezone !== strict.timezone))) throw courseFailure('STRICT_CONTRACT_CHANGED', '主 Agent 不能改变用户已填写的目标、来源、时区或规则；未填项目应自动补充。')
    if (!validDate(args.targetAt) || !validDate(args.forecastClosesAt) || Date.parse(args.targetAt) <= Date.parse(clock())) throw courseFailure('INVALID_TARGET', '目标时间须为尚未到期的带时区时间。')
    const expectedTarget = resolveRequestDeadline(request, { preserveContract: false })
    if (!strict?.targetAt && hasTodayCalendarDeadline(request.question) && (Date.parse(args.targetAt) !== Date.parse(expectedTarget) || Date.parse(args.forecastClosesAt) !== Date.parse(expectedTarget) || args.timezone !== (strict?.timezone || request.timezone))) throw courseFailure('TODAY_TARGET_MISMATCH', `“今天”锚定任务创建时的本地日期，targetAt和forecastClosesAt必须均为${expectedTarget}，时区保持${strict?.timezone || request.timezone}；重试不能顺延到新的日期。`)
    if (!strict?.targetAt && !explicitDate(request.question) && (Date.parse(args.targetAt) !== Date.parse(expectedTarget) || Date.parse(args.forecastClosesAt) !== Date.parse(expectedTarget))) throw courseFailure('PRESET_TIME_MISMATCH', `本题相对时间目标必须保持为${expectedTarget}；可换时区显示但必须是同一时刻，不能直接把UTC钟面改成+08，并同步更正问题正文与规则中的时间。`)
    if (!validUrl(args.resolutionSourceUrl)) throw courseFailure('UNVERIFIED_SOURCE', '结果来源链接无效。')
    const source = store.evidenceFor(runId).find((item) => urlKey(item.url) === urlKey(args.resolutionSourceUrl) && item.text.trim() &&
      (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(clock())))
    if (!source) throw courseFailure('UNVERIFIED_SOURCE', '指定来源未实际读取原文，不能把题目标为 ready。')
    const timeContext = makeTimeContext({ now: clock(), createdAt: request.createdAt, targetAt: args.targetAt, forecastClosesAt: args.forecastClosesAt, timezone: args.timezone })
    if (!strict && /20\d\d(?:年|[-/])\d{1,2}|\b\d{1,2}:\d{2}/.test(args.resolutionRule)) throw courseFailure('TIME_TEXT_FORMAT', '预设规则不要自行写绝对日期或钟面，请使用“目标时点”或{{TARGET_LOCAL}}，由服务器填入正确本地时间。')
    const temporalPolicy = /仍|还会是|还是|还在|继续(?:担任|任职)|是否担任|\bstill\b|\bremain\w*\b/i.test(request.question) ? 'at_target' : 'by_target'
    const financial = /比特币|BTC|bitcoin|ETH|以太|股价|股票|价格|黄金|金价|白银|银价|\b(?:price|gold|silver)\b/i.test(request.question)
    const priceDown = /下跌|下滑|跌|回落|走低|下降|\b(?:fall\w*|drop\w*|declin\w*|decreas\w*|lower|down)\b/i.test(request.question)
    const priceDirection = priceDown || /回升|上涨|涨|走高|\b(?:rise\w*|risin\w*|recover\w*|up)\b/i.test(request.question)
    const expectedPair = /比特币|BTC|bitcoin/i.test(request.question) ? 'BTC-USD' : /ETH|以太/i.test(request.question) ? 'ETH-USD' : null
    const quoteProof = expectedPair && store.evidenceFor(runId).find((item) => item.marketQuote?.pair === expectedPair && Number.isFinite(item.marketQuote.value) && item.marketQuote.value > 0 && validDate(item.marketQuote.observedAt) && Date.parse(item.marketQuote.observedAt) <= Date.parse(clock()))
    let currentReference = null
    if (financial) currentReference = quoteProof ? { kind: 'price', value: quoteProof.marketQuote.value, unit: quoteProof.marketQuote.currency, currency: quoteProof.marketQuote.currency,
      pair: quoteProof.marketQuote.pair, observedAt: quoteProof.marketQuote.observedAt, url: quoteProof.url, evidenceId: quoteProof.evidenceId,
      verified: true, synthetic: Boolean(quoteProof.fixture || quoteProof.synthetic), timestampMeaning: 'system-observation-time' }
      : { kind: 'directional', value: null, unit: null, observedAt: null, url: source.url, evidenceId: source.evidenceId, verified: false }
    const conditionalOnly = Boolean(args.forceConditional || (financial && !currentReference?.verified))
    const assumptions = [...new Set([...(request.mode === 'preset' ? presetAssumptions(request.question, timeContext) : []), ...(args.defaultAssumptions || [])])]
    const sourceLimitations = [...(args.sourceLimitations || []), ...(conditionalOnly ? ['未取得可验证现价，数值基准缺失；仅作有公开资料依据的条件性方向估计，不计分。'] : []), ...(quoteProof ? ['报价时间为系统取得该公开价格的观察时间，不冒充交易所逐笔成交时间。'] : [])]
    let rule = args.resolutionRule.replaceAll('{{TARGET_LOCAL}}', timeContext.targetAtLocalLabel)
    if (!strict) {
      const window = `固定观察窗口为${timeContext.windowStartsAtLocalLabel}至${timeContext.targetAtLocalLabel}。`
      if (financial && priceDirection) rule = currentReference?.verified
        ? `${window}目标时点${currentReference.pair}公开价格${priceDown ? '低于' : '高于'}固定基准${currentReference.value} ${currentReference.unit}记为是，否则为否；基准来自${currentReference.url}，系统观察于${currentReference.observedAt}。来源不可得时暂不结算。`
        : `${window}当前没有可核实的数值基准，仅输出条件性方向估计，不作为可计分的价格涨跌题；补齐基准需另建契约版本。`
      else if (/马斯克|elonmusk/i.test(request.question) && /推特|发帖|tweet/i.test(request.question)) rule = `${window}默认核验X公开账号@elonmusk在该窗口是否有公开原创、回复、引用或转发，任一条成立即是。假设须公开展示；来源访问失败不视为未发帖，待替代公开记录核验。`
      else if (/下雨|降雨|降水|\brain(?:fall)?\b/i.test(request.question)) rule = `${window}仅当可核验的实况观测记录证明研究地点或已明确说明的代表观测站在窗口内出现可测降水，才判定降雨已实现。天气预报、降雨概率和预报图只作为概率研究依据，不能单独作为YES或实际结果。若无法取得对应地点/站点的实况或代表性未确认，暂不结算；不能把未抓到记录判为无雨。`
      else rule = `${window}${rule}`
    }
    const input = { type: 'binary', question: timedQuestion(request.question, timeContext, temporalPolicy), object: args.object, timezone: args.timezone,
      targetAt: args.targetAt, forecastClosesAt: args.forecastClosesAt, resolutionRuleVersion: 1, resolutionRule: rule,
      resolutionSource: { kind: request.mode === 'strict' ? 'specified_source' : 'public_research_reference', url: source.url }, unresolvablePolicy: args.unresolvablePolicy, options: [], status: 'ready' }
    const prediction = workbench.createPrediction(run.topicId, { ...input, predictionId: `prediction_${request.requestId}` }, { idempotencyKey: `${request.requestId}_prediction` })
    const normalized = { ...prediction, watchQuery: args.watchQuery, sourceVerified: true, sourceEvidenceId: source.evidenceId,
      interpretation: args.interpretation || args.question, defaultAssumptions: assumptions, currentReference, baseline: currentReference,
      sourceLimitations, conditionalOnly, timeContext, temporalPolicy,
      researchBasis: { mode: conditionalOnly ? 'conditional' : request.mode === 'strict' ? 'verified-source' : 'alternative-public',
        summary: conditionalOnly ? '实际读取公开资料的条件性估计；缺少数值基准，不计分。' : '已读取公开研究依据；这不等同于官方已经确认未来结果。' },
      temporalPolicyBasis: '课程首版语义启发式；目标时点状态题在T之前不能以当前状态结算。' }
    store.updateRequest(request.requestId, { predictionId: prediction.predictionId, predictionVersion: prediction.version, normalized, status: 'researching', message: '', missingFields: [], error: null })
    store.bindPrediction(runId, prediction.predictionId, prediction.version)
    store.saveRun(runId, { state: { ...store.requireRun(runId).state, timeContext, latestReference: currentReference } })
    return normalized
  }
  async function executeMain(runId, signal) {
    let run = ensure(runId, signal)
    let state = structuredClone(run.state)
    const request = store.requireRequest(run.requestId)
    const phase = run.phase
    const gatewayTools = toolsFor(runId, 'main', 'main', signal)
    const remainingFollowUps = followUpLimit(run) - (modern(run) ? followUpsUsed(run) : Number(Boolean(state.followUpDone)))
    const allowedNames = phase === 'intake' ? ['draft_and_delegate'] : phase === 'prepare' ? ['normalize_prediction', 'mark_insufficient'] : phase === 'triage' ? ['triage_update', 'mark_insufficient'] : phase === 'plan' ? ['delegate_work', 'mark_insufficient'] : [
      ...(remainingFollowUps > 0 ? ['request_followup'] : []), 'propose_forecast', 'mark_insufficient',
    ]
    const mainResearchAllowed = phase === 'prepare' && !modern(run)
    const advertised = mainResearchAllowed ? gatewayTools.map((tool) => ({ type: 'function', function: { name: tool.toolId, description: tool.description, parameters: tool.inputSchema } })).concat(allowedNames.map(nativeTool)) : allowedNames.map(nativeTool)
    state.main ||= { messages: [{ role: 'system', content: legacyMainSystem }], calls: 0 }
    const contextKey = `${phase}:${modern(run) ? cycleOf(run) : Boolean(state.followUpDone)}`
    if (state.main.phase !== contextKey && !state.main.pending) {
      // Preserve the audit privately, but never pay to re-send earlier source
      // bodies or protocols to a new supervisory stage. Budget/call counts stay
      // on the same run, and workers retain their independent checkpoints.
      if (state.main.phase && state.main.messages.length > 1) {
        state.main.phaseArchive ||= []
        state.main.phaseArchive.push({ contextKey: state.main.phase, archivedAt: clock(), messages: structuredClone(state.main.messages) })
      }
      state.main.messages = [state.main.messages[0]]
      state.main.phase = contextKey
      state.main.phaseCalls = 0
      state.main.messages.push({ role: 'user', content: JSON.stringify({ kind: 'course-main', phase, question: request.question,
        nowISO: clock(), timezone: request.strict?.timezone || request.timezone, targetAt: resolveRequestDeadline(request),
        mode: request.mode, strict: request.strict || null, timeContext: state.timeContext || requestTime(request, clock()),
        defaultAssumptions: request.mode === 'preset' ? presetAssumptions(request.question, state.timeContext || requestTime(request, clock())) : [],
        normalized: contractContext(request, state.timeContext || requestTime(request, clock()), state.latestReference), draft: state.draft || null, orchestration: orchestrationView(run), historicalMemory: state.memory || null,
        roleCatalogue: roleCatalogue(), selectedRoleIds: state.triage?.selectedRoleIds?.length ? state.triage.selectedRoleIds : undefined,
        previousTeam: request.team?.map((item) => item.roleId) || suggestedRoles(request.question), changeHints: state.changeHints || null,
        newEvidence: phase === 'triage' ? store.evidenceFor(runId).filter((item) => state.triage?.newEvidenceIds?.includes(item.evidenceId)).map(({ evidenceId, title, text, url, marketQuote }) => ({ evidenceId, title, text: text.slice(0, 1000), url, marketQuote })) : [],
        followUpDone: Boolean(state.followUpDone), followUpsRemaining: remainingFollowUps, reports: store.listAssignments(runId).filter((item) => item.report).map(compactReport),
        assignmentStatus: store.listAssignments(runId).map(({ roleId, status, error, followUp }) => ({ roleId, status, followUp, error: error || null })),
        reviewFocus: store.listAssignments(runId).filter((item) => item.followUp).map(({ roleId, objective, reason }) => ({ roleId, objective, reason })),
        evidence: store.evidenceFor(runId).map(({ evidenceId, title, url, contentHash, sourceMode, text, marketQuote }) => ({ evidenceId, title, url, contentHash, sourceMode, ...(phase === 'prepare' ? { excerpt: text.slice(0, 1000), marketQuote: marketQuote || null } : {}) })),
        instruction: phase === 'intake' ? '本阶段只能draft_and_delegate：简短整理用户原问，标出常识假设，立即选择三位不同职责（含核验）并安排他们调查来源、规则与基准；不要自己预先搜索，不输出预测。草稿不是ready契约。' : phase === 'prepare' ? modern(run) ? '子Agent已先取证。直接根据其报告和已读evidence编译normalize_prediction，来源必须选择已读原文，strict原样保留。不要重复研究或要求用户提供材料；若真实来源缺失，明确缺口。今天/今日/today必须使用server targetAt。' : 'BTC/ETH优先get_market_quote；再搜索和读公开原文，404换来源；preset用默认常识假设继续，不把常见缺项丢给用户。今天/今日/today无具体时刻时必须原样使用server targetAt，其为创建当天本地日终，不是未来24小时。' : phase === 'plan' ? '从roleCatalogue选匹配本题的不同职责，含核验。局部只2人，初始/重大3人，公开理由。' : phase === 'triage' ? '只根据去重后的新资料和历史比较分诊，不把历史内容当新发现。' : `本轮是第${cycleOf(run)}次汇报与质询；剩余${remainingFollowUps}次定向补查机会，证据足够即可总结，不凑满循环。指出具体支持/反证与未解决分歧；必要时request_followup向相关角色提出带证据的问题，下一轮比较其答复。机会用尽必须propose_forecast或mark_insufficient。比较上一判断和本轮支持/反证；说明为何改变或维持概率。有限资料可以条件估计，无真实原文不得捏造判断。发布时sourceLimitations根据本轮实际来源仅列未解决缺口（可以空数组）；准备缺口可能已解决。预报不是已实现天气结果。`,
      }) })
    }
    if (!state.main.pending && state.main.pendingQueue?.length) {
      state.main.pending = state.main.pendingQueue.shift()
      store.saveRun(runId, { state })
    }
    if (!state.main.pending) {
      let response
      for (;;) {
        if ((state.main.currentAttempt || 0) >= 3) {
          const last = state.main.lastRetry || { code: 'MODEL_SERVICE_UNAVAILABLE', message: runtimeMessages.MODEL_SERVICE_UNAVAILABLE, retryable: true }
          throw Object.assign(courseFailure(last.code, last.message), last)
        }
        if (state.main.retryNotBefore) {
          const remaining = Math.max(0, Date.parse(state.main.retryNotBefore) - Date.now())
          if (remaining) await delay(remaining, undefined, { signal })
        }
        ensure(runId, signal)
        if (state.main.calls >= runBudget(runId).mainRequests) throw courseFailure('MAIN_BUDGET', '主 Agent 已达到本轮调用上限。')
        if (phase === 'intake' && (state.main.phaseCalls || 0) >= 2) throw courseFailure('INTAKE_LIMIT', '题意整理未在两次有效决策内完成，未伪造派工；可检查模型协议后手动重试。')
        state.main.calls += 1
        state.main.currentAttempt = (state.main.currentAttempt || 0) + 1
        const used = store.requireRun(runId).usage
        const limits = runBudget(runId)
        state.main.baseSystem ||= modern(run) ? modernMainSystem : state.main.messages[0].content
        state.main.messages[0].content = state.main.baseSystem + `\n[本轮执行规则与预算]\n阶段=${phase}；第${cycleOf(run)}个协作周期。你只整理、派工、核验报告和总结；v3初始不得先联网研究。intake最多2次有效决策且只调用draft_and_delegate；临时服务故障每步最多3次传输尝试，均计入总预算。研究员前最多5次决策调查、第6次只报告；资料足够可提前报告。会后最多2次定向补查，当前剩余${remainingFollowUps}次，不能无限搜索或为了展示凑轮数。\n单次输出上限${limits.maxTokens} tokens（含供应商思考/输出计量），主Agent总请求上限${limits.mainRequests}，已预留${state.main.calls}次；全轮模型上限${limits.maxModelRequests}、工具${limits.maxToolCalls}、累计${limits.maxTotalTokens} tokens。当前已用模型${used.modelRequests}、工具${used.toolCalls}、tokens ${used.totalTokens}；剩余模型${Math.max(0, limits.maxModelRequests - used.modelRequests)}、工具${Math.max(0, limits.maxToolCalls - used.toolCalls)}、tokens ${Math.max(0, limits.maxTotalTokens - used.totalTokens)}。重试也计费，达到上限停止。\n公开文字简洁：题意/解释≤200中文字；每人任务≤300字、理由≤100字；总结≤400字，分歧和限制每条≤120字、各≤5条。字数是写作目标、token是实际执行上限，两者不能等同。不要输出隐藏推理或把无来源内容充作证据。`
        store.saveRun(runId, { state })
        const timeout = AbortSignal.timeout(runBudget(runId).timeoutMs)
        const combined = AbortSignal.any([signal, timeout])
        try {
          response = await abortable(() => providerFor(runId).complete({ messages: structuredClone(state.main.messages), tools: advertised, signal: combined,
            maxTokens: Math.max(1, Math.min(runBudget(runId).maxTokens, runBudget(runId).maxTotalTokens - store.requireRun(runId).usage.totalTokens)) }), combined)
          state.main.phaseCalls = (state.main.phaseCalls || 0) + 1
          state.main.currentAttempt = 0; state.main.retryNotBefore = null; state.main.lastRetry = null
          break
        } catch (error) {
          if (signal.aborted || stopping || terminal.has(store.requireRun(runId).status)) throw error
          const cause = timeout.aborted ? Object.assign(courseFailure('MODEL_TIMEOUT', runtimeMessages.MODEL_TIMEOUT), { retryable: true }) : error
          if (!cause.retryable || state.main.currentAttempt >= 3) throw cause
          const retryAfterMs = Math.min(Number.isFinite(cause.retryAfterMs) && cause.retryAfterMs >= 0 ? cause.retryAfterMs : 250 * 2 ** (state.main.currentAttempt - 1), 30000)
          state.main.lastRetry = errorValue(cause)
          state.main.retryNotBefore = new Date(Date.now() + retryAfterMs).toISOString()
          store.saveRun(runId, { state })
          event(runId, 'model.retrying', { agentSpecId: 'main', name: '主 Agent', attempt: state.main.currentAttempt, maxAttempts: 3,
            retryAfterMs, error: state.main.lastRetry, summary: '模型服务短暂失败，已安排有上限的重试；停止跟踪可取消。' })
        }
      }
      ensure(runId, signal)
      const calls = response.message?.tool_calls || []
      if (response.message?.role !== 'assistant' || !Array.isArray(calls) || calls.some((call) => typeof call.id !== 'string' || !call.id.trim() || call.id.length > 120 || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) throw courseFailure('MAIN_PROTOCOL', '主 Agent 返回的工具消息缺少合法调用编号或参数。')
      state.main.messages.push(response.message)
      const readOnlyBatch = mainResearchAllowed && calls.length <= 6 && calls.every((call) => gatewayTools.some((tool) => tool.toolId === call.function.name))
      if (!calls.length || calls.some((call) => !advertised.some((tool) => tool.function.name === call.function.name)) || (calls.length > 1 && !readOnlyBatch)) {
        state.main.protocolRepairs = (state.main.protocolRepairs || 0) + 1
        for (const call of calls) state.main.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'error', error: { code: 'MAIN_PROTOCOL', message: '本阶段必须调用允许的动作；规范、派工和候选须一次一个，只有只读搜索和读取可成批。' } }) })
        let context = {}; try { context = JSON.parse(state.main.messages.findLast((message) => message.role === 'user')?.content || '{}') } catch {}
        state.main.messages.push({ role: 'user', content: JSON.stringify({ ...context, instruction: '请调用当前工具完成动作，不用自然语言代替工具。规范、派工和候选每次一个；可以先搜索，再读取原文。' }) })
        store.saveRun(runId, { state })
        if (state.main.protocolRepairs > 2) throw courseFailure('MAIN_PROTOCOL', '主 Agent 多次没有返回允许的结构化动作。')
        return
      }
      state.main.pendingQueue = structuredClone(calls.slice(1))
      state.main.pending = structuredClone(calls[0])
      store.saveRun(runId, { state })
    }
    const call = state.main.pending
    let result
    let nextPhase = phase
    let finished = false
    try {
      const args = JSON.parse(call.function.arguments)
      if (mainResearchAllowed && gatewayTools.some((tool) => tool.toolId === call.function.name)) {
        const tool = gatewayTools.find((item) => item.toolId === call.function.name)
        if (!ajv.compile(tool.inputSchema)(args)) throw courseFailure('INVALID_ARGUMENTS', '搜索或读取参数无效。')
        event(runId, 'tool.started', { agentSpecId: 'main', name: '主 Agent', toolCallId: call.id, toolId: tool.toolId }, `${runId}_main_${call.id}_start`)
        result = await tool.execute(args, { runId, assignmentId: 'main', agentInstanceId: `${runId}_main`, toolCallId: call.id, signal })
        event(runId, result.status === 'error' ? 'tool.failed' : 'tool.completed', { agentSpecId: 'main', name: '主 Agent', toolCallId: call.id, toolId: tool.toolId, status: result.status, summary: result.summary, evidenceIds: result.evidenceIds }, `${runId}_main_${call.id}_done`)
      } else {
        if (!validators[call.function.name]?.(args)) throw courseFailure('MAIN_ARGUMENTS', '主 Agent 的动作未通过格式校验。')
        if (call.function.name === 'draft_and_delegate') {
          if (phase !== 'intake' || !modern(run)) throw courseFailure('DRAFT_STAGE', '只能在新轮题意整理阶段生成草稿并派工。')
          const selected = args.assignments.map((item) => item.roleId)
          if (new Set(selected).size !== 3 || !selected.includes('verification')) throw courseFailure('DELEGATION_ROLES', '首次需三种不同职责且包含核验席。')
          state.draft = { status: 'draft', question: args.question, originalQuestion: request.question, object: args.object,
            interpretation: args.interpretation, defaultAssumptions: args.defaultAssumptions || [],
            targetAt: resolveRequestDeadline(request), timezone: request.strict?.timezone || request.timezone, sourceVerified: false,
            notice: '待核验题意草稿；来源、规则和数值基准由子Agent调查后核定，不是正式预测。' }
          state.cycle = 1; state.followUpsUsed = 0
          store.saveRun(runId, { state })
          for (const item of args.assignments) assignment(runId, item.roleId, item.objective, item.reason)
          state.team = store.listAssignments(runId).filter((item) => !item.followUp).map(({ roleId, name, objective, reason }) => ({ roleId, name, objective, reason }))
          state.triage = { ...state.triage, selectedRoleIds: selected }
          store.updateRequest(run.requestId, { team: state.team })
          result = { status: 'ok', data: { draft: state.draft, assignments: args.assignments } }; nextPhase = 'workers'
          event(runId, 'question.drafted', { draft: state.draft })
          event(runId, 'team.selected', { team: state.team, cycle: 1, reason: '先整理题意与分工，来源核查交由独立研究员。' })
          event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: `题意草稿已整理，立即派出3位研究员取证；不等主 Agent 预先研究。${args.interpretation}` })
        } else if (call.function.name === 'normalize_prediction') {
          const normalized = await normalize(runId, args)
          state.timeContext = normalized.timeContext; state.latestReference = normalized.currentReference
          result = { status: 'ok', data: contractContext(store.requireRequest(run.requestId), normalized.timeContext) }; nextPhase = modern(run) && state.team?.length ? 'review' : 'plan'
          event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: `已按明确展示的假设整理：${normalized.question}` })
        } else if (call.function.name === 'triage_update') {
          const previousTeam = request.team?.map((item) => item.roleId) || suggestedRoles(request.question)
          const selected = args.kind === 'team' ? previousTeam : args.roleIds
          if (args.kind === 'local' && (selected.length !== 2 || !selected.includes('verification'))) throw courseFailure('TRIAGE_TEAM', '局部复核须为相关研究员和核验席两人。')
          state.triage = { ...state.triage, kind: args.kind === 'irrelevant' ? 'no_change' : args.kind, reason: args.reason, selectedRoleIds: selected }
          store.saveWatch(run.requestId, { lastTriage: state.triage })
          event(runId, 'watch.triaged', { triage: state.triage })
          if (args.kind === 'irrelevant') { store.saveRun(runId, { state }); finish(runId, 'completed', '新资料与本题无实质关系，保留已有概率。'); finished = true }
          else { result = { status: 'ok', data: state.triage }; nextPhase = 'plan' }
        } else if (call.function.name === 'delegate_work') {
          const selected = args.assignments.map((item) => item.roleId)
          const expected = state.triage?.kind === 'local' ? 2 : 3
          if (selected.length !== expected || new Set(selected).size !== expected || !selected.includes('verification') ||
            (state.triage?.selectedRoleIds?.length && selected.some((role) => !state.triage.selectedRoleIds.includes(role)))) throw courseFailure('DELEGATION_ROLES', `本轮需要${expected}个不同职责且包含核验席，遵守分诊范围。`)
          for (const item of args.assignments) assignment(runId, item.roleId, item.objective, item.reason)
          state.team = store.listAssignments(runId).filter((item) => !item.followUp).map(({ roleId, name, objective, reason }) => ({ roleId, name, objective, reason }))
          if (!request.team || state.triage?.kind === 'initial') store.updateRequest(run.requestId, { team: state.team })
          state.triage = { ...state.triage, selectedRoleIds: selected }
          result = { status: 'ok', data: { assignments: args.assignments } }; nextPhase = 'workers'
          event(runId, 'team.selected', { team: state.team, reason: state.triage?.reason || '主 Agent 按题选择差异职责。' })
          event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: `按本题需要派出${expected}位研究员，各自取证并说明选择理由。` })
        } else if (call.function.name === 'request_followup') {
          if (remainingFollowUps <= 0) throw courseFailure('FOLLOWUP_LIMIT', '定向复查次数已用完，请提交汇总或明确资料不足。')
          const visible = new Set(store.evidenceFor(runId).map((item) => item.evidenceId))
          if (!args.evidenceIds.length || args.evidenceIds.some((item) => !visible.has(item))) throw courseFailure('FOLLOWUP_EVIDENCE', '补查须指向实际争议材料。')
          if (modern(run)) {
            state.followUpsUsed = followUpsUsed(run) + 1; state.cycle = 1 + state.followUpsUsed
            store.saveRun(runId, { state })
          }
          assignment(runId, args.roleId, args.objective, args.reason, true, state.cycle || 1)
          result = { status: 'ok', data: args }; nextPhase = 'followup'
          event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: `第${state.cycle || 2}轮质询与补查：${args.reason}`, evidenceIds: args.evidenceIds, followUp: true, cycle: state.cycle || 2 })
        } else if (call.function.name === 'mark_insufficient') {
          const available = store.evidenceFor(runId)
          if (phase === 'prepare' && request.mode === 'preset' && available.length && /账号|类型|窗口|阈值|基准|参照|定义|口径|歧义|规则|平台|account|ambig|threshold|baseline/i.test(args.message + args.missingFields.join(' '))) {
            const time = requestTime(request, clock())
            const quote = available.find((item) => item.marketQuote?.pair === (/ETH|以太/i.test(request.question) ? 'ETH-USD' : 'BTC-USD'))
            const basis = quote || available.find((item) => !item.marketQuote) || available[0]
            const normalized = await normalize(runId, { question: request.question, object: request.question, targetAt: time.targetAtUtc,
              forecastClosesAt: time.forecastClosesAtUtc, timezone: time.timezone, resolutionRule: '按公开展示的默认假设与固定目标窗口核验，替代公开材料用于研究，无法确认则不结算。',
              resolutionSourceUrl: basis.url, unresolvablePolicy: '证据不足或来源不可用时不结算，不把未抓到资料视为否。', watchQuery: request.question.slice(0, 120),
              forceConditional: !quote, interpretation: '预设模式采用已明示的常识假设继续调查。', sourceLimitations: [args.message.slice(0, 1000)] })
            state.timeContext = normalized.timeContext; state.latestReference = normalized.currentReference
            nextPhase = modern(run) && state.team?.length ? 'review' : 'plan'; result = { status: 'ok', data: contractContext(store.requireRequest(run.requestId), normalized.timeContext), summary: '常见细项已用公开假设补全，继续独立研究，不要求用户填技术表单。' }
            event(runId, 'meeting.message', { agentSpecId: 'main', name: '主 Agent', summary: '已用默认窗口和明确展示的假设补全常见细项，继续调查；资料限制已保留。' })
          } else {
            store.updateRequest(run.requestId, { missingFields: args.missingFields, message: args.message })
            finish(runId, 'insufficient', args.message); finished = true; result = { status: 'insufficient', data: args }
          }
        } else if (call.function.name === 'propose_forecast') {
          if (args.outcomeKnown) {
            if (requiresWeatherObservation(request)) throw courseFailure('WEATHER_OBSERVATION_REQUIRED', '当前仅可发布天气概率，请将outcomeKnown设为false；降雨实况需人工或后续结构化观测验证，通用网页不能证明YES或NO结果。')
            const source = store.requireRequest(run.requestId).normalized.resolutionSource.url
            if (!store.evidenceFor(runId).some((item) => item.url === source && args.evidenceIds.includes(item.evidenceId))) throw courseFailure('RESULT_EVIDENCE', '已知结果必须引用指定结果来源的原文。')
            store.recordResult(run.requestId, { outcome: args.outcome, evidenceIds: args.evidenceIds, summary: args.summary })
            finish(runId, 'insufficient', '指定来源已给出结果，已登记事实，停止发布预测。')
          } else {
            const current = workbench.getPrediction(store.requireRun(runId).predictionId)
            store.publishForecast(runId, args, current)
            finish(runId, 'completed', '本轮判断已封存，可查看概率、证据关系及下一次检查。')
          }
          notify(); finished = true; result = { status: 'ok' }
        }
      }
    } catch (error) {
      ensure(runId, signal)
      result = { status: 'error', error: errorValue(error), summary: errorValue(error).message, data: null, evidenceIds: [] }
    }
    if (!finished) {
      state.main.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      state.main.pending = null
      store.saveRun(runId, { state, phase: nextPhase })
    }
  }
  async function execute(runId, controller) {
    try {
      let run = ensure(runId, controller.signal)
      const request = store.requireRequest(run.requestId)
      if (run.providerIdentity !== identity || run.sourceMode !== sourceMode) throw courseFailure('COURSE_CONFIGURATION_CHANGED', '中断旧轮次的模型或来源配置已改变，请以新的检查轮次继续；旧记录保留。', 409)
      store.saveRun(runId, { status: 'running' })
      const deadline = request.normalized?.forecastClosesAt || resolveRequestDeadline(request)
      if (Date.parse(deadline) <= Date.parse(clock())) { finish(runId, 'insufficient', '目标时间已到，停止准备和预测更新。'); return }
      if (!run.topicId) {
        const topic = workbench.createTopic({ topicId: `topic_${request.requestId}`, title: request.question.slice(0, 200), background: request.question,
          sourceMode: modelMode === 'mock' || sourceMode !== 'live' ? 'replay' : 'live' }, { idempotencyKey: `${request.requestId}_topic` })
        store.updateRequest(run.requestId, { topicId: topic.topicId, status: 'researching' })
        store.saveRun(runId, { topicId: topic.topicId })
      }
      run = store.requireRun(runId)
      if (!run.state.memory) {
        const memory = store.buildMemory(run.requestId, { excludeRunId: runId, predictionVersion: run.predictionVersion, asOf: run.createdAt })
        store.saveRun(runId, { state: { ...run.state, memory, timeContext: requestTime(store.requireRequest(run.requestId), clock()),
          triage: { kind: 'initial', reason: '首次按题选择差异职责。', selectedRoleIds: [], newEvidenceIds: [], duplicateCount: 0 } } })
        event(runId, 'memory.loaded', { memory: { historical: true, sourceRunIds: memory.sourceRunIds, previousForecast: memory.previousForecast, reportCount: memory.reportCount, relationCount: memory.relationCount, summary: memory.summary, policy: memory.policy, shortTerm: memory.shortTerm, longTerm: memory.longTerm } })
      }
      while (!terminal.has(store.requireRun(runId).status)) {
        run = ensure(runId, controller.signal)
        if (run.phase === 'watch_check') await checkSources(runId, controller.signal)
        else if (run.phase === 'workers' || run.phase === 'followup') await runAssignments(runId, controller.signal, run.phase === 'followup')
        else await executeMain(runId, controller.signal)
      }
    } catch (error) {
      if (stopping || controller.signal.aborted || terminal.has(store.requireRun(runId).status)) return
      const saved = errorValue(error)
      store.saveRun(runId, { status: 'failed', error: saved, message: saved.message }, [{ eventId: `${runId}_failed`, type: 'run.finished', payload: { status: 'failed', summary: saved.message, error: saved } }])
      notify()
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (stopping) return
    pauseKnownProviderFailures()
    const active = store.listWatches().filter((watch) => watch.status === 'active' && watch.nextDueAt)
    if (!active.length) return
    const at = Math.min(...active.map((watch) => Date.parse(watch.nextDueAt)))
    timer = setTimeout(() => {
      for (const watch of store.listWatches()) {
        if (watch.status === 'active' && watch.nextDueAt && Date.parse(watch.nextDueAt) <= Date.parse(clock())) {
          try {
            store.queueRun(watch.requestId, 'watch', configuration)
            store.saveWatch(watch.requestId, { nextDueAt: new Date(Date.parse(clock()) + watchIntervalMs).toISOString() })
          } catch {}
        }
      }
      pump(); schedule()
    }, Math.max(20, Math.min(2147483647, at - Date.parse(clock()))))
    timer.unref()
  }
  function pump() {
    if (stopping) return
    for (const run of store.listRuns()) {
      if (jobs.size >= 1) break
      if (terminal.has(run.status) || jobs.has(run.runId)) continue
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => execute(run.runId, controller)).finally(() => { jobs.delete(run.runId); notify(); pump(); schedule() })
      jobs.set(run.runId, { controller, promise })
    }
  }
  return {
    metadata: store.metadata,
    capabilities: { stage: 'course-adaptive', modelMode, modelRef: provider.model || 'injected', sourceMode,
      reasoningSettings: provider.settings ? Object.fromEntries(['thinking', 'reasoningEffort', 'timeoutMs', 'maxOutputTokens', 'protocol'].map((key) => [key, provider.settings[key]])) : null,
      sources: sourceTools.capabilities, supervisor: true, roles, roleCatalogue: roleCatalogue(), nativeToolProtocol: true, persistent: true, watchPlans: true, forecastPublishing: true, historyMemory: true, watchTriage: true,
      orchestration: { harnessVersion, intake: harnessVersion >= 3 ? 'rewrite-and-delegate' : 'research-before-delegate', maxCycles: harnessVersion >= 3 ? 3 : 2, maxFollowUps: harnessVersion >= 3 ? 2 : 1, investigationSteps: 5, reportStep: 6 },
      limits: { maxConcurrentRuns: 1, workers: 3, localWorkers: 2, followUps: 2, modelRequestsPerWorker: 6, toolsPerWorker: 6, modelRequestsPerRun: 40, toolCallsPerRun: 64, totalTokensPerRun: 300000, maxOutputTokens: maxOutput, timeoutMs, watchIntervalMs } },
    createRequest(input, options) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) throw courseFailure('INVALID_QUESTION', '请输入一句具体事件问题。')
      if (Object.keys(input).some((key) => !['question', 'horizonHours', 'timezone', 'mode', 'watch', 'strict'].includes(key)) ||
        (input.watch !== undefined && typeof input.watch !== 'boolean')) throw courseFailure('INVALID_COURSE_INPUT', '不支持手工材料、工具授权或其他隐藏配置。')
      if (input.horizonHours !== undefined && (!Number.isInteger(input.horizonHours) || input.horizonHours < 1 || input.horizonHours > 168)) throw courseFailure('INVALID_PRESET', '窗口应为一至一百六十八小时。')
      const data = { question: input.question.trim(), horizonHours: durationHours(input.question) ?? input.horizonHours ?? 48, timezone: input.timezone || 'Asia/Shanghai',
        mode: input.mode || 'preset', watch: input.watch !== false, modelMode, sourceMode, providerIdentity: identity, modelRef: provider.model || null, budget, harnessVersion }
      if (!Number.isInteger(data.horizonHours) || data.horizonHours < 1 || data.horizonHours > 168 || !['preset', 'strict'].includes(data.mode)) throw courseFailure('INVALID_PRESET', '窗口应为一至一百六十八小时，模式为preset或strict。')
      try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format() } catch { throw courseFailure('INVALID_TIMEZONE', '请选择有效时区。') }
      if (data.mode === 'strict') {
        const strict = input.strict ?? {}
        if (typeof strict !== 'object' || Array.isArray(strict) || Object.keys(strict).some((key) => !['targetAt', 'resolutionRule', 'resolutionSourceUrl', 'timezone'].includes(key)) ||
          (strict.targetAt !== undefined && (!validDate(strict.targetAt) || Date.parse(strict.targetAt) <= Date.parse(clock()))) ||
          (strict.resolutionRule !== undefined && (typeof strict.resolutionRule !== 'string' || !strict.resolutionRule.trim() || strict.resolutionRule.length > 4000)) ||
          (strict.resolutionSourceUrl !== undefined && !validUrl(strict.resolutionSourceUrl))) throw courseFailure('INVALID_STRICT_CONTRACT', '请修正已填写的日期、规则或来源；空缺字段可由主 Agent 自动补充。')
        data.strict = { ...strict }
        if (strict.timezone !== undefined) {
          if (typeof strict.timezone !== 'string' || !strict.timezone.trim()) throw courseFailure('INVALID_TIMEZONE', '严格模式时区无效。')
          try { new Intl.DateTimeFormat('en', { timeZone: strict.timezone }).format() } catch { throw courseFailure('INVALID_TIMEZONE', '严格模式时区无效。') }
        }
      }
      const result = store.createRequest(data, options)
      notify(); pump(); return publicRequest(result)
    },
    listRequests: () => store.listRequests().map(publicRequest),
    getRequest: (requestId) => publicRequest(store.requireRequest(requestId)),
    getRun: (runId) => publicRun(store.requireRun(runId)),
    listRuns: (options) => store.listRuns(options).map(publicRun),
    listEvents: (options) => store.listEvents(options),
    listForecasts: (options) => store.listForecasts(options),
    graph: (options) => ({ relations: store.listRelations(options) }),
    check(requestId) {
      const run = store.queueRun(requestId, 'manual', configuration)
      if (run.status === 'queued') {
        const request = store.requireRequest(requestId)
        store.updateRequest(requestId, { error: null, message: '已创建新的检查轮次，正在重新尝试。', missingFields: [] })
        store.saveWatch(requestId, { status: request.watch === false ? 'off' : 'active', pauseReason: null, nextDueAt: null, manualRetryAt: clock() })
      }
      notify(); pump(); return publicRun(run)
    },
    stop(requestId) {
      const value = store.stop(requestId)
      for (const run of store.listRuns({ requestId })) jobs.get(run.runId)?.controller.abort()
      notify(); schedule(); return publicRequest(value)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    resume() { pump(); schedule() },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs.values()].map((job) => job.promise)) },
    async close() {
      if (stopping) return
      stopping = true; clearTimeout(timer)
      for (const job of jobs.values()) job.controller.abort()
      await Promise.allSettled([...jobs.values()].map((job) => job.promise))
      listeners.clear(); store.close()
    },
  }
}
