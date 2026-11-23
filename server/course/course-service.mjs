import { isPriceDirection } from '../../web/course-price-direction.mjs'
import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import { setTimeout as delay } from 'node:timers/promises'
import { runWorker } from '../runtime/worker-loop.mjs'
import { abortable, checkCancelled } from '../runtime/model-provider.mjs'
import { digest, validDate, validUrl } from '../domain/contracts.mjs'
import { createCourseStore, courseFailure } from './course-store.mjs'
import { TRADING_DAY_OPTIONS, TRADING_DAY_CAPABILITIES, tradingMarketTimezone } from './trading-calendar.mjs'
import { totalTokenLimit, remainingTotalTokens, boundedOutputTokens } from './prediction-budget.mjs'
import { OUTPUT_LANGUAGES, withRequestOutputLanguage } from './output-language.mjs'
import { planModelCall, estimateModelInputTokens } from '../runtime/model-budget.mjs'
import { boundedForecastBudget, isBoundedForecast, effectiveRoleReports, reportScorecard, boundedMainMessages, assembleForecastCandidate, partialForecastSummary } from './bounded-forecast.mjs'
import { EXPLORATORY_DELIVERY_POLICY, isExploratoryForecast, selectExploratoryReports } from './exploratory-reports.mjs'
import { createRunEvidenceReader } from './run-evidence-reader.mjs'
import { officialSourceScope } from './official-source-scope.mjs'
import { FINANCIAL_TARGET_POLICY, financialTargetIssue, isExplicitListingQuestion } from './financial-target-policy.mjs'
import { FORECAST_WINDOW_POLICY, intakeWindowIssue, forecastWindowTextIssue } from './forecast-window-policy.mjs'
import { marketPricePair, reviewMarketReport } from './market-report.mjs'
import { buildCollaboration } from './collaboration.mjs'
import { memoryForModel } from './memory-policy.mjs'
import { researchProfile } from './research-profiles.mjs'
import { researchSummaryMessages, unsentSummaryRequest } from './research-summary.mjs'
import { investigationProfile } from './investigation-profiles.mjs'
import { groundingPolicy, groundingInstruction, validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { WARNING_URL, WARNING_POLICY, WARNING_RULE, readWarnings } from './weather-warning.mjs'
import { PRICE_URL, PRICE_POLICY, PRICE_RULE, readPriceSnapshot } from './market-resolution.mjs'
import { createFinancialMetricsTool } from './financial-metrics.mjs'
import { createRoleToolset } from './course-role-tools.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { legacyMainSystem, modernMainSystem, decisionInstruction } from './course-prompts.mjs'
import { COURSE_ROLE_IDS, roleCatalogue, suggestedRoles, requestTime, makeTimeContext, timedQuestion, presetAssumptions, resolveRequestDeadline, hasTodayCalendarDeadline, requiresWeatherObservation } from './course-context.mjs'

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
  now = () => new Date(), watchIntervalMs = 3_600_000, harnessVersion = 3, evidencePolicy = null, warningReader, priceReader } = {}) {
  if (!workbench?.createTopic || !workbench?.createPrediction || !sourceTools?.toolsFor || !workbench.listAgents) throw courseFailure('COURSE_CONFIG', '课程运行时需要领域工作台与实际来源网关。', 500)
  if (!['mock', 'live'].includes(modelMode) || !Number.isInteger(watchIntervalMs) || watchIntervalMs < 1000) throw courseFailure('COURSE_CONFIG', '模型模式或检查间隔无效。')
  if (![2, 3].includes(harnessVersion)) throw courseFailure('COURSE_CONFIG', '编排版本无效。')
  if (evidencePolicy !== null && evidencePolicy !== groundingPolicy) throw courseFailure('COURSE_CONFIG', '证据策略无效。')
  const store = createCourseStore({ path, now })
  const jobs = new Map()
  const resolvingRequests = new Set()
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
  const activeRoleSpecs = () => structuredClone(workbench.listAgents())
  function requireTeam(specs, request = {}, previousTeam = []) {
    const ids = new Set(specs.map(spec => spec.agentSpecId))
    const verifier = specs.some(spec => spec.agentSpecId === 'verification' && spec.origin === 'builtin')
    const price = request.resolutionPolicy?.version === PRICE_POLICY
    const warning = request.resolutionPolicy?.version === WARNING_POLICY
    const missing = !verifier || ids.size < 3 || previousTeam.some(id => !ids.has(id)) ||
      (price && !['market', 'statistics', 'verification'].every(id => ids.has(id))) ||
      (warning && (!ids.has('official') || !['industry', 'statistics'].some(id => ids.has(id))))
    if (missing) throw courseFailure('AGENT_TEAM_UNAVAILABLE', '当前可用研究员无法组成所需团队：需至少三种不同职责和原核验席；固定规则题及后续检查还需保留相应团队。请先调整研究员席位。', 409)
    return specs
  }
  function runRoleSpecs(runId) {
    const run = store.requireRun(runId)
    if (Array.isArray(run.state.roleSpecs)) return run.state.roleSpecs
    const request = store.requireRequest(run.requestId)
    const specs = activeRoleSpecs()
    // Pre-existing runs may not have a catalogue snapshot. Preserve every
    // already-assigned immutable version, including explicitly deleted history.
    for (const item of store.listAssignments(runId)) {
      let historical = item.baseAgentSpec
      if (!historical && item.config?.specVersion) {
        try { historical = workbench.getAgent(item.roleId, { specVersion: item.config.specVersion }) } catch {}
      }
      historical ||= item.agentSpec
      if (historical) {
        const index = specs.findIndex(spec => spec.agentSpecId === item.roleId)
        if (index >= 0) specs[index] = historical
        else specs.push(historical)
      }
    }
    requireTeam(specs, request, run.phase === 'watch_check' ? (request.team || []).map(item => item.roleId) : [])
    store.saveRun(runId, { state: { ...run.state, roleSpecs: structuredClone(specs) } })
    return specs
  }
  const roleToolsets = new Map()
  function roleToolsFor(runId) {
    const ids = runRoleSpecs(runId).map(spec => spec.agentSpecId)
    const key = JSON.stringify(ids)
    if (!roleToolsets.has(key)) roleToolsets.set(key, createRoleToolset(ids))
    return roleToolsets.get(key)
  }
  function defaultRoles(runId, question) {
    const request = store.requireRequest(store.requireRun(runId).requestId)
    const specs = runRoleSpecs(runId)
    if (request.resolutionPolicy?.version === WARNING_POLICY) return ['official', specs.some(spec => spec.agentSpecId === 'industry') ? 'industry' : 'statistics', 'verification']
    return suggestedRoles(question, specs)
  }
  const modern = (run) => run.harnessVersion >= 3
  const cycleOf = (run) => run.state.cycle || 1
  const followUpsUsed = (run) => run.state.followUpsUsed || 0
  const followUpLimit = (run) => { const request = store.requireRequest(run.requestId); return run.budget?.maxFollowUps ?? (request.purpose === 'research' || request.resolutionPolicy ? 1 : modern(run) ? 2 : 1) }
  const budgetView = (value) => Object.fromEntries(['strategy', 'deliveryPolicy', 'maxModelRequests', 'maxInvestigationRequests', 'maxToolCalls', 'maxTotalTokens', 'maxTokens', 'mainRequests', 'mainPhaseRequests', 'mainReserveTokens', 'maxFollowUps', 'reserveReportTokens', 'reportRepairRequests'].filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]))
  const exploratory = run => isExploratoryForecast(run, store.requireRequest(run.requestId))
  const reportView = runId => {
    const run = store.requireRun(runId), items = store.listAssignments(runId)
    return exploratory(run) ? selectExploratoryReports(items, store.evidenceFor(runId), { asOf: clock(), runId, unknownUsage: run.usage.unknownUsage }) : null
  }
  const modelReportItems = runId => {
    const items = store.listAssignments(runId), view = reportView(runId)
    if (!view) return items.filter(item => item.report).map(compactReport)
    return items.filter(item => item.report || item.partialReport).map(item => {
      const usable = view?.usable.find(candidate => candidate.assignmentId === item.assignmentId)
      return usable ? { ...compactReport(usable), reportQuality: usable.quality, reportOrigin: usable.reportOrigin, recommendedDisposition: usable.quality === 'partial' ? 'qualified' : 'adopted' }
        : { ...compactReport({ ...item, report: item.report || item.partialReport }), reportQuality: 'unusable', recommendedDisposition: 'rejected',
          probability: null, support: [], counterevidence: [], evidenceIds: [],
          missingEvidence: view.rejected.filter(rejected => rejected.assignmentId === item.assignmentId).flatMap(rejected => rejected.gaps).slice(0, 5),
          summary: '该席没有通过本轮实质证据与模型概率检查；原报告已封存，此处不将访问失败、免责声明或程序回执作为预测依据。' }
    })
  }
  const scoresFor = runId => {
    const view = reportView(runId)
    return view ? view.usable.map(item => ({ roleId: item.roleId, assignmentId: item.assignmentId, probabilityYes: item.report.probability,
      reportQuality: item.quality, reportOrigin: item.reportOrigin, evidenceCount: item.evidenceIds.length, summary: item.report.summary.slice(0, 450), missingEvidence: item.gaps }))
      : reportScorecard(store.listAssignments(runId))
  }
  const orchestrationView = (run) => modern(run) ? { cycle: cycleOf(run), maxCycles: followUpLimit(run) + 1, followUpsUsed: followUpsUsed(run), maxFollowUps: followUpLimit(run),
    investigationSteps: run.budget?.worker?.maxInvestigationRequests ?? Math.min(5, (run.budget?.worker?.maxModelRequests || 6) - 1),
    reportStep: run.budget?.worker?.maxInvestigationRequests ? run.budget.worker.maxInvestigationRequests + 1 : Math.min(6, run.budget?.worker?.maxModelRequests || 6),
    reportRepairRequests: run.budget?.worker?.reportRepairRequests || 0, stage: run.phase } : null
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
    if (terminal.has(run.status) || store.requireLiveRequest(run.requestId).status === 'stopped') throw courseFailure('COURSE_CANCELLED', '本题已经停止。', 409)
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
  const researchReservations = new Map()
  function providerFor(runId, { worker = false } = {}) {
    return { ...provider, async complete(input) {
      ensure(runId, input.signal)
      const run = store.requireRun(runId)
      // Apply the saved request policy before estimating/reserving every model call.
      // The helper clones messages, leaving durable checkpoints and sibling workers untouched.
      const request = store.requireRequest(run.requestId)
      input = withRequestOutputLanguage(input, request.outputLanguage)
      let reservation = 0
      if (request.outputLanguage !== undefined || isBoundedForecast(run) || request.purpose === 'research' || request.resolutionPolicy) {
        if (run.usage.unknownUsage) throw courseFailure('COURSE_USAGE_UNKNOWN', '部分请求用量未知，已停止继续付费调用。', 409)
        // UTF-8 bytes plus protocol overhead conservatively reserve input and
        // capped output for concurrent calls. Never print these private messages.
        const tokenLimit = totalTokenLimit(runBudget(runId))
        if (tokenLimit !== null) {
          reservation = (isBoundedForecast(run) ? estimateModelInputTokens(input.messages || [], input.tools || []) : Buffer.byteLength(JSON.stringify(input.messages || []), 'utf8') + Buffer.byteLength(JSON.stringify(input.tools || []), 'utf8')) + (input.maxTokens || runBudget(runId).maxTokens) + 2048
          const closeout = isBoundedForecast(run) && worker ? runBudget(runId).mainReserveTokens || 0 : 0
          if (run.usage.totalTokens + (researchReservations.get(runId) || 0) + reservation + closeout > tokenLimit) throw Object.assign(courseFailure('COURSE_BUDGET', '剩余预算不足以安全发起下一次模型请求，保留已取得资料与最终答复额度。', 409), { usage: { total_tokens: 0 }, requestNotSent: true })
        }
      }
      store.reserve(runId, 'modelRequests', runBudget(runId).maxModelRequests)
      if (reservation) researchReservations.set(runId, (researchReservations.get(runId) || 0) + reservation)
      try {
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
      } finally {
        if (reservation) researchReservations.set(runId, Math.max(0, (researchReservations.get(runId) || 0) - reservation))
      }
    } }
  }
  function toolsFor(runId, readerId, roleId, signal, { shared = false } = {}) {
    const currentRun = store.requireRun(runId)
    const request = store.requireRequest(currentRun.requestId)
    const normalized = request.normalized
    const specifiedSource = normalized?.resolutionSource?.url || request.strict?.resolutionSourceUrl
    const tools = sourceTools.toolsFor({ roleId, question: normalized || { question: request.question },
      ...(roleId === 'official' ? officialSourceScope(request, specifiedSource) : {}),
      allowSourceDiscovery: roleId === 'official' && modern(currentRun) && Boolean(currentRun.state.draft) && !normalized && !specifiedSource,
      legacySchemas: !request.groundingPolicy,
      marketResolution: request.resolutionPolicy?.version === PRICE_POLICY, cacheScope: runId,
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
    if (roleId === 'statistics') tools.push(createFinancialMetricsTool({ now: clock, getEvidence: (id) => store.evidenceFor(runId).find((item) => item.evidenceId === id && item.readBy.includes(readerId)) }))
    if (exploratory(currentRun) && (shared || store.listAssignments(runId).some(item => item.assignmentId === readerId && item.followUp))) tools.push(createRunEvidenceReader({
      runId, assignmentId: readerId, now: clock, getEvidence: id => store.evidenceFor(runId).find(item => item.evidenceId === id),
      onRead(record) { ensure(runId, signal); return store.recordEvidence(runId, record, readerId) },
    }))
    if (request.groundingPolicy && ['analogy', 'graph'].includes(roleId)) tools.push({ toolId: 'inspect_research_memory', version: 1, description: '读取本题在本轮开始时固定的公开历史摘要与支持/反证关系。旧证据须重读；此工具不写图、不生成本轮证据。', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return { status: 'ok', data: { memory: memoryForModel(currentRun.state.memory, { roleId }), referenceable: false, writesGraph: false }, evidenceIds: [], observedAt: clock(), summary: '已读取本轮固定历史摘要，没有写入关系或生成新证据。', error: null, usage: null } } })
    return tools.filter(tool => !request.resolutionPolicy || (request.resolutionPolicy.version === PRICE_POLICY ? ['get_market_quote','get_market_history'].includes(tool.toolId) : tool.toolId === 'get_weather_warning')).map((tool) => ({ ...tool, async execute(args, context) {
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
    const adequacy = reportView(value.runId)
    const assignments = store.listAssignments(value.runId).map(({ assignmentId, roleId, name, status, report, partialReport, followUp, objective, reason, checkpoint, error, cycle, config, review, methodProfile, investigationProfile }) => ({
      investigationProfile: investigationProfile ? { version: investigationProfile.version, roleId } : null, groundingPolicy: config?.groundingPolicy || null,
      review: review || null, methodProfile: methodProfile ? { version: methodProfile.version, roleId: methodProfile.roleId } : null,
      assignmentId, agentSpecId: roleId, roleId, name, status, report, partialReport: partialReport || null,
      usableReport: adequacy?.usable.find(item => item.assignmentId === assignmentId)?.report || null,
      followUp, objective, reason, cycle: cycle || 1, budget: budgetView(config?.budget), usage: checkpoint?.usage || null, error: error || null,
    }))
    const result = { runId: value.runId, requestId: value.requestId, status: value.status, phase: value.phase, trigger: value.trigger,
      topicId: value.topicId, predictionId: value.predictionId, predictionVersion: value.predictionVersion, modelMode: value.modelMode,
      sourceMode: value.sourceMode, createdAt: value.createdAt, updatedAt: value.updatedAt, usage: value.usage, error: value.error,
      harnessVersion: value.harnessVersion || 2, budget: budgetView(value.budget), draft: value.state.draft || null, orchestration: orchestrationView(value),
      summaryResumeCount: value.state.summaryResumeCount || 0, delivery: value.state.delivery || null, closeoutFailure: value.state.closeoutFailure || null,
      roleScores: isBoundedForecast(value) ? scoresFor(value.runId) : [],
      reportAdequacy: adequacy ? { roleCount: adequacy.roleCount, partialRoleCount: adequacy.partialRoleCount, completeRoleCount: adequacy.completeRoleCount, rejected: adequacy.rejected } : null,
      summaryRequestNotSent: unsentSummaryRequest(value, store.listAssignments(value.runId)),
      modelRef: value.modelRef || null, team: value.state.team || assignments.filter((item) => !item.followUp).map(({ roleId, name, objective, reason }) => ({ roleId, name, objective, reason })),
      triage: value.state.triage || null, memory: value.state.memory ? (({ historical, sourceRunIds, previousForecast, reportCount, relationCount, summary, policy, shortTerm, longTerm, recentJudgments }) => ({ historical, sourceRunIds, previousForecast, reportCount, relationCount, summary, policy, shortTerm, longTerm, recentJudgments }))(value.state.memory) : null,
      timeContext: value.state.timeContext || null, tradingHorizon: store.requireRequest(value.requestId).tradingHorizon || null, currentReference: value.state.latestReference || null,
      summary: value.message || '', budgetSummary: value.budgetSummary || null, directionOutlook: value.directionOutlook || null, assignments, events: store.listEvents({ runId: value.runId }),
      evidence: store.evidenceFor(value.runId), researchReport: store.listResearchReports({ requestId: value.requestId }).find((item) => item.runId === value.runId) || null,
      forecast: store.listForecasts({ requestId: value.requestId }).find((item) => item.runId === value.runId) || null }
    return { ...result, collaboration: buildCollaboration(result) }
  }
  function publicRequest(request) {
    const runs = store.listRuns({ requestId: request.requestId }).map(publicRun)
    const latestRun = runs.at(-1) || null
    const forecasts = store.listForecasts({ requestId: request.requestId })
    const { providerIdentity, ...safe } = request
    return { ...safe, watchEnabled: request.watch === true, modelMode: latestRun?.modelMode || safe.modelMode, sourceMode: latestRun?.sourceMode || safe.sourceMode,
      activeRunId: runs.find((run) => !terminal.has(run.status))?.runId || null,
      runs, run: latestRun, latestRun, forecast: forecasts.at(-1) || null, forecasts,
      researchReport: store.listResearchReports({ requestId: request.requestId }).at(-1) || null,
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
  function targetIssueFor(runId) {
    const run = store.requireRun(runId)
    return financialTargetIssue(store.requireRequest(run.requestId), store.listAssignments(runId), store.evidenceFor(runId), { runId, asOf: clock() })
  }
  function finishTargetClarification(runId) {
    const issue = targetIssueFor(runId)
    if (!issue) return false
    const run = store.requireRun(runId)
    const delivery = { kind: 'partial_research', generatedBy: 'harness', probabilityYes: null,
      summary: issue.message, reason: issue.code, evidenceIds: issue.evidenceIds, gaps: issue.nextActions,
      notice: '保留已取得的调查事实；未发布股价、代理标的或上市事件概率。请按明确的新题目创建任务。' }
    store.saveRun(runId, { state: { ...run.state, targetIssue: issue, delivery } })
    store.updateRequest(run.requestId, { message: issue.message, missingFields: issue.nextActions })
    // An unresolved security is not an automatic-monitoring plan. Keep the
    // user's original request and evidence, but do not pay to repeat it hourly.
    store.saveWatch(run.requestId, { status: 'off', nextDueAt: null, pauseReason: { code: issue.code, message: issue.message } })
    event(runId, 'question.target_unavailable', { agentSpecId: 'main', name: '执行框架', error: { code: issue.code, message: issue.message }, evidenceIds: issue.evidenceIds, summary: issue.message })
    store.saveRun(runId, { status: 'insufficient', phase: 'finished', message: issue.message }, [
      { eventId: `${runId}_finished`, type: 'run.finished', payload: { status: 'insufficient', summary: issue.message } },
    ])
    notify()
    return true
  }
  function assignment(runId, roleId, objective, reason, followUp = false, cycle = 1, review = null) {
    const run = store.requireRun(runId)
    const request = store.requireRequest(run.requestId)
    const template = runRoleSpecs(runId).find(item => item.agentSpecId === roleId)
    if (!template) throw courseFailure('AGENT_TEAM_UNAVAILABLE', '该研究员不在本轮已封存的可用目录内，不能重新启用已删除席位。', 409)
    const allowedTools = toolsFor(runId, 'main', roleId, jobs.get(runId)?.controller.signal, { shared: followUp }).map((tool) => tool.toolId)
    const workerBudget = runBudget(runId).worker
    if (isBoundedForecast(run)) objective += '\n执行边界：仅使用本次真实工具列表。NVDA等股票没有专用get_market_quote，读取公开行情页即可；工具不适用不是研究失败。网页价格只称候选参考，正式系统基准以contract.currentReference.verified为准。媒体转述保留出处，未获一手确认的重大消息不能写成已确认事实。'
    if (isBoundedForecast(run) && followUp) objective += '\n本次定向补查也须在报告probability中说明对原Yes命题估计维持还是更新（0至1）；主任务中的“仅核事实/不输出概率”不取消此报告要求。无依据才null，不把事实答复误作新预测已完成。'
    const methodProfile = isBoundedForecast(run) ? null : researchProfile(roleId, request.question)
    const methods = request.groundingPolicy && COURSE_ROLE_IDS.includes(roleId) ? investigationProfile(roleId) : null
    if (isBoundedForecast(run) && methods) methods.instructions += ' 本轮是有界事件预测：围绕分配方向收集2至3条有用信息，通常一次搜索加两次原文读取即可，不追求全网或完整财报复原。每条主张一个事实/推断，直接复制工具给出的citationHints真实片段，不重排JSON。用probability给出你对同一Yes命题的0至1估计，说明支持/反证和局限；完全没有依据才留null。未来结果尚未发生是预测前提，不是报告不能完成的理由。不得要求现在取得目标之后的收盘价；缺专用报价时只作有依据的条件性估计。summary≤180字，支持最多2条、反证1条；预算接近收尾立即交报告。涉及目标时间、日期翻译（如Nov改11月）、数值比较或预测的主张必须用inference；fact只概括引文直接含有的事实数字，不在fact里补任何契约日期。例：引文Nov 20 ... 125.53，fact可写“该页面显示价格125.53”，目标日期只放summary或inference。全报告优先1条支持+1条反证，原文能支持有限估计即可完成；暂时无法量化准确率不等于不能提供未校准的主观概率。只调用当前真实工具清单，不需要调查不存在的工具、未来价格或重复核验系统已封存日历。'
    if (request.resolutionPolicy && methods) methods.instructions += request.resolutionPolicy.version === PRICE_POLICY
      ? ' 本题只研究目标前已经发生的BTC-USDT数据，USDT不是USD。三席先get_market_quote(pair=BTC-USDT)取得本人现价；statistics还须get_market_history(pair=BTC-USDT)读取已关闭分钟桶统计，其他席可选历史。目标后的数据由系统到期读取，不是你现在要查找的材料；不要因为未来未知就拒绝当前事实报告。完成当前观察即可status=complete，未来不确定写入missingEvidence。quote/history.data.citationHints均为可直接逐字复制的短片段，优先使用；不能自己给JSON子集添右括号。support至少一条引用本人现价。fact只写片段明确数值；涉及目标时间、比较或未来方向标inference。systemObservedAt是系统取得时刻，不是成交时刻。三席同一Binance来源，不称独立市场。历史工具返回样本统计，原始K线单独归档，不能声称逐根读过或概率已校准。不要在原子主张中重复目标时间。summary≤160字，支持最多2条、反证1条，每条一个主张，最后预留报告修正机会。'
      : ' 本题是固定官方数据核验，不进行开放新闻搜索；只需get_weather_warning一次取得完整JSON，再立即提交一条当前事实和一条未来不确定性。JSON引用优先选连续短片段，不重排字段或改写值；最后保留一个报告修正机会。'
    const marketReportPolicy = roleId === 'market' && !request.normalized && !followUp && request.resolutionPolicy?.version !== PRICE_POLICY ? 'market-spot-baseline-v2' : null
    const assignmentId = `${runId}_${roleId}_${followUp ? modern(run) ? `followup_${cycle}` : 'followup' : 'initial'}`
    const prior = store.listAssignments(runId).find((item) => item.assignmentId === assignmentId)
    if (prior) return prior
    const draft = run.state.draft
    const followupContext = exploratory(run) ? '\n同轮材料通过read_run_evidence逐条复阅后才可引用。先复阅争议证据，搜索只为补实质缺口；不要反复提交未登记为本人读取的同伴编号。资料有限可交有依据的概率，把不足列入missingEvidence，不要求未来结果。'
      : '\n定向补查上下文：' + JSON.stringify(store.listAssignments(runId).filter((item) => item.report).map(compactReport))
    return store.createAssignment(runId, { assignmentId, roleId, name: template.name, objective, reason, followUp, cycle,
      baseAgentSpec: structuredClone(template), methodProfile, investigationProfile: methods,
      review,
      agentSpec: { ...template, allowedTools, extensionSlots: [null, null], limits: workerBudget,
        instructions: `${template.instructions}${methods ? '\n' + methods.instructions : ''}${request.groundingPolicy ? groundingInstruction : ''}${methodProfile ? '\n' + methodProfile.instructions : ''}${request.purpose === 'research' ? '\n这是已披露财报核验任务，只调查事实与表述，不需要未来价格或未来可结算契约。' : ''}\n本次最多${workerBudget.maxModelRequests}次模型请求、${workerBudget.maxToolCalls}次工具调用、累计${workerBudget.maxTotalTokens} tokens、单次输出最多${workerBudget.maxTokens} tokens。调查决策最多${workerBudget.maxInvestigationRequests || workerBudget.maxModelRequests - 1}次，报告阶段另留初报及${workerBudget.reportRepairRequests || 1}次修正；足够即可提前交，不必用满。summary≤300中文字；支持/反证各≤3条，每条一个有引文的主张；没有反证用空数组，不把“未找到资料”伪造为有出处的反证。不足列missingEvidence。网页失败换公开来源，不把摘要当正文。只引用实际返回的evidenceId；旧资料须本轮重读。目标时间使用timeContext服务器标签，不将Z解释成本地。当前事实不等于未来结果；不能因为未来未知、无准确率校准或专用股票报价而拒绝有据条件估计。${!request.normalized && request.purpose !== 'research' ? '\n当前是待核验草稿，主动找参考来源与规则，strict已填条件不能改写。' : ''}${followUp ? followupContext : '\n初始任务独立，不读取同伴新报告。'}${request.forecastWindowPolicy === FORECAST_WINDOW_POLICY ? '\n本轮概率的唯一截止是' + resolveRequestDeadline(request) + '；原问宽泛的“未来”不授权改成24个月或其他窗口。历史回看只作为证据，不能变成概率所属的预测期限。' : ''}` },
      config: { topicId: run.topicId, predictionId: run.predictionId || `prediction_${request.requestId}`, runId, assignmentId, agentInstanceId: `${assignmentId}_actor`,
        agentSpecId: roleId, specVersion: template.specVersion, objective: JSON.stringify({ task: objective,
          purpose: request.purpose || 'forecast', forecastPolicy: run.budget?.strategy || null, groundingPolicy: request.groundingPolicy || null, methodProfile, contract: contractContext(request, run.state.timeContext || requestTime(request, clock()), run.state.latestReference), draft: !request.normalized ? draft : null, strict: request.strict || null, cycle, timeContext: run.state.timeContext || requestTime(request, clock()),
          historicalMemory: memoryForModel(run.state.memory, { roleId }), newEvidenceIds: run.state.triage?.newEvidenceIds || [],
          review, disputedEvidence: review ? store.evidenceFor(runId).filter((item) => review.evidenceIds.includes(item.evidenceId)).map(({ evidenceId, title, url, text }) => ({ evidenceId, title, url, excerpt: text.slice(0, 600) })) : [] }),
        ...((isBoundedForecast(run) || request.purpose === 'research' || request.resolutionPolicy) && provider.settings?.protocol === 'deepseek' && provider.settings.thinking === 'enabled' ? { modelProfile: { version: 'bounded-research-v2', reasoningEffort: 'low', ...(isBoundedForecast(run) ? { reportThinking: 'disabled' } : {}) } } : {}),
        marketReportPolicy, groundingPolicy: request.groundingPolicy || null, allowedTools, inputEvidence: [], timePolicy: 'live',
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(), budget: workerBudget } })
  }
  async function runAssignments(runId, signal, followUp) {
    const current = store.requireRun(runId)
    const assignments = store.listAssignments(runId).filter((item) => Boolean(item.followUp) === followUp && (!followUp || !modern(current) || item.cycle === cycleOf(current)))
    const perform = async (item) => {
      if (item.status === 'completed') return item.report
      store.saveAssignment(item.assignmentId, { status: 'running' })
      const value = await runWorker({ provider: providerFor(runId, { worker: true }), assignment: item.config, agentSpec: item.agentSpec,
        tools: toolsFor(runId, item.assignmentId, item.roleId, signal), enabledToolIds: item.config.allowedTools, signal,
        resume: item.checkpoint, finishOnToolBudget: true,
        reportPolicy: item.config.groundingPolicy || item.config.marketReportPolicy ? { version: [item.config.marketReportPolicy, item.config.groundingPolicy].filter(Boolean).join('+'),
          check: item.config.groundingPolicy ? (report) => { try {
            const timeIssue = forecastWindowTextIssue([{ path: 'report.summary', text: report.summary }], store.requireRequest(current.requestId), current.state.timeContext)
            if (timeIssue) return timeIssue.message
            const claims = [...report.support, ...report.counterevidence]; if (report.status === 'complete' || claims.length) validateGroundedClaims(claims, store.evidenceFor(runId), { readerId: item.assignmentId, asOf: clock() }); return null
          } catch (error) { return error.message } } : undefined,
          review: (report) => item.config.marketReportPolicy ? reviewMarketReport({ question: store.requireRequest(current.requestId).question, report, evidence: store.evidenceFor(runId), readerId: item.assignmentId,
            ...(item.config.marketReportPolicy.endsWith('v2') ? { asOf: clock(), notBefore: current.createdAt } : {}) }) : report } : undefined,
        onCheckpoint(checkpoint) { ensure(runId, signal); store.saveAssignment(item.assignmentId, { checkpoint, report: checkpoint.report, partialReport: checkpoint.partialReport || null, status: checkpoint.report ? 'completed' : 'running' }) },
        onEvent(value) {
          const payload = { ...value.payload, ...(value.type === 'assignment.started' ? { objective: item.objective, summary: item.objective } : {}),
            assignmentId: item.assignmentId, agentSpecId: item.roleId, name: item.name, followUp }
          event(runId, value.type, payload, `${item.assignmentId}_${value.type}_${payload.toolCallId || payload.resultId || payload.modelRequestId || 'start'}`)
        },
      })
      store.saveAssignment(item.assignmentId, { status: 'completed', report: value.report, partialReport: value.partialReport || null })
      return value.report
    }
    const results = []
    if (store.requireRequest(current.requestId).resolutionPolicy) {
      // The contexts remain independent; serialize model work for this bounded
      // single-source task so concurrent reservations cannot consume report slots.
      for (const item of assignments) {
        const [result] = await Promise.allSettled([perform(item)])
        results.push(result)
        if (store.requireRequest(current.requestId).resolutionPolicy.version === PRICE_POLICY && (result.status === 'rejected' || result.value?.status !== 'complete')) {
          if (result.status === 'rejected') store.saveAssignment(item.assignmentId, { status: 'failed', error: errorValue(result.reason) })
          event(runId, 'assignment.completed', { assignmentId: item.assignmentId, agentSpecId: item.roleId, name: item.name, status: result.status === 'rejected' ? 'failed' : result.value.status, summary: '固定价格题该席没有有效完整报告，停止本轮，不以其他两席替代。' })
          for (const pending of store.listAssignments(runId).filter(a => a.status === 'queued')) store.saveAssignment(pending.assignmentId, { status: 'cancelled' })
          throw courseFailure('PRICE_TEAM_INCOMPLETE', '固定价格题三席必须完整；本轮保留缺口并停止，不继续无效汇总。', 409)
        }
      }
    } else results.push(...await Promise.allSettled(assignments.map(perform)))
    ensure(runId, signal)
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      if (result.status === 'rejected') {
        if (['BUDGET_EXHAUSTED', 'COURSE_BUDGET'].includes(result.reason.code) && store.requireRequest(current.requestId).purpose === 'research') {
          const item = assignments[index]
          const readIds = store.evidenceFor(runId).filter((evidence) => evidence.readBy.includes(item.assignmentId)).map((evidence) => evidence.evidenceId)
          if (readIds.length) {
            const report = { status: 'insufficient', summary: `程序生成的预算回执：已读取${readIds.length}份原文，但研究员未完成内容核验；以下引用不表示认可原文主张。`, evidenceIds: readIds,
              support: [], counterevidence: [], missingEvidence: ['研究预算耗尽，公开核验报告未完整生成。'], probability: null, nextSuggestion: '缩小子问题或核查已读来源。', generatedBy: 'harness-budget-receipt' }
            store.saveAssignment(item.assignmentId, { status: 'completed', report, error: errorValue(result.reason) })
            event(runId, 'assignment.completed', { assignmentId: item.assignmentId, agentSpecId: item.roleId, name: item.name, status: 'insufficient', summary: report.summary, evidenceIds: readIds })
            continue
          }
        }
        const gap = store.requireRequest(current.requestId).resolutionPolicy ? { report: { status: 'blocked', summary: '【程序失败回执，非研究报告】该席未完成有效报告，不能当作核验已经完成。', evidenceIds: [], support: [], counterevidence: [], missingEvidence: ['该席独立核验未完成'], probability: null, completionMode: 'harness-failure-receipt' } } : {}
        store.saveAssignment(assignments[index].assignmentId, { ...gap, status: 'failed', error: errorValue(result.reason) })
        event(runId, 'assignment.completed', { assignmentId: assignments[index].assignmentId, agentSpecId: assignments[index].roleId,
          name: assignments[index].name, status: 'blocked', summary: errorValue(result.reason).message })
      }
    }
    for (const item of store.listAssignments(runId)) {
      if (item.report) store.addRelations(runId, item.assignmentId, item.report)
      if (exploratory(store.requireRun(runId)) && item.partialReport) store.addRelations(runId, item.assignmentId, item.partialReport)
    }
    const latest = store.requireRun(runId)
    const currentRequest = store.requireRequest(latest.requestId)
    if (currentRequest.purpose === 'research' && !store.evidenceFor(runId).length && totalTokenLimit(runBudget(runId)) !== null && latest.usage.totalTokens >= totalTokenLimit(runBudget(runId)) * .7) {
      finish(runId, 'insufficient', '在本轮预算内未取得可引用原文，已停止继续搜索；搜索摘要不能当作核验事实。'); return
    }
    const compile = currentRequest.purpose !== 'research' && modern(latest) && !currentRequest.normalized
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
    const targetIssue = targetIssueFor(runId)
    if (targetIssue) throw courseFailure(targetIssue.code, targetIssue.message, 409)
    const strict = request.mode === 'strict' ? request.strict : null
    if (strict && ((strict.targetAt && Date.parse(args.targetAt) !== Date.parse(strict.targetAt)) ||
      (strict.resolutionRule && args.resolutionRule !== strict.resolutionRule) ||
      (strict.resolutionSourceUrl && urlKey(args.resolutionSourceUrl) !== urlKey(strict.resolutionSourceUrl)) ||
      (strict.timezone && args.timezone !== strict.timezone))) throw courseFailure('STRICT_CONTRACT_CHANGED', '主 Agent 不能改变用户已填写的目标、来源、时区或规则；未填项目应自动补充。')
    if (!validDate(args.targetAt) || !validDate(args.forecastClosesAt) || Date.parse(args.targetAt) <= Date.parse(clock())) throw courseFailure('INVALID_TARGET', '目标时间须为尚未到期的带时区时间。')
    const expectedTarget = resolveRequestDeadline(request, { preserveContract: false })
    if (!strict?.targetAt && !request.tradingHorizon && hasTodayCalendarDeadline(request.question) && (Date.parse(args.targetAt) !== Date.parse(expectedTarget) || Date.parse(args.forecastClosesAt) !== Date.parse(expectedTarget) || args.timezone !== (strict?.timezone || request.timezone))) throw courseFailure('TODAY_TARGET_MISMATCH', `“今天”锚定任务创建时的本地日期，targetAt和forecastClosesAt必须均为${expectedTarget}，时区保持${strict?.timezone || request.timezone}；重试不能顺延到新的日期。`)
    if (!strict?.targetAt && !request.tradingHorizon && !explicitDate(request.question) && (Date.parse(args.targetAt) !== Date.parse(expectedTarget) || Date.parse(args.forecastClosesAt) !== Date.parse(expectedTarget))) throw courseFailure('PRESET_TIME_MISMATCH', `本题相对时间目标必须保持为${expectedTarget}；可换时区显示但必须是同一时刻，不能直接把UTC钟面改成+08，并同步更正问题正文与规则中的时间。`)
    if (!strict?.targetAt && request.tradingHorizon && (Date.parse(args.targetAt) !== Date.parse(expectedTarget) || Date.parse(args.forecastClosesAt) !== Date.parse(expectedTarget) || args.timezone !== (strict?.timezone || request.timezone))) throw courseFailure('TRADING_TARGET_MISMATCH', `交易日窗口已由服务器按${request.tradingHorizon.marketLabel}日历封存；目标和停止发布时间均须为${expectedTarget}，显示时区保持${strict?.timezone || request.timezone}，不能改成自然日或延长窗口。`)
    if (!validUrl(args.resolutionSourceUrl)) throw courseFailure('UNVERIFIED_SOURCE', '结果来源链接无效。')
    const source = store.evidenceFor(runId).find((item) => urlKey(item.url) === urlKey(args.resolutionSourceUrl) && item.text.trim() &&
      (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(clock())))
    if (!source) throw courseFailure('UNVERIFIED_SOURCE', '指定来源未实际读取原文，不能把题目标为 ready。')
    const timeContext = makeTimeContext({ now: clock(), createdAt: request.createdAt, targetAt: args.targetAt, forecastClosesAt: args.forecastClosesAt, timezone: args.timezone, tradingHorizon: request.tradingHorizon })
    if (!strict && /20\d\d(?:年|[-/])\d{1,2}|\b\d{1,2}:\d{2}/.test(args.resolutionRule)) throw courseFailure('TIME_TEXT_FORMAT', '预设规则不要自行写绝对日期或钟面，请使用“目标时点”或{{TARGET_LOCAL}}，由服务器填入正确本地时间。')
    const listingEvent = request.financialTargetPolicy === FINANCIAL_TARGET_POLICY && isExplicitListingQuestion(request.question)
    const temporalPolicy = !listingEvent && (request.tradingHorizon || request.resolutionPolicy || /仍|还会是|还是|还在|继续(?:担任|任职)|是否担任|\bstill\b|\bremain\w*\b/i.test(request.question)) ? 'at_target' : 'by_target'
    const financial = !listingEvent && (Boolean(request.tradingHorizon) || /比特币|BTC|bitcoin|ETH|以太|股价|股票|价格|黄金|金价|白银|银价|\b(?:price|gold|silver)\b/i.test(request.question))
    const priceDown = /下跌|下滑|跌|回落|走低|下降|\b(?:fall\w*|drop\w*|declin\w*|decreas\w*|lower|down)\b/i.test(request.question)
    const priceDirection = Boolean(request.tradingHorizon) || priceDown || /回升|上涨|涨|走高|\b(?:rise\w*|risin\w*|recover\w*|up)\b/i.test(request.question)
    const expectedPair = request.resolutionPolicy?.version === PRICE_POLICY ? 'BTC-USDT' : marketPricePair(request.question)
    const marketReader = request.resolutionPolicy?.version === PRICE_POLICY ? store.listAssignments(runId).find(item => item.roleId === 'market' && !item.followUp)?.assignmentId : null
    const quoteProof = expectedPair && store.evidenceFor(runId).find((item) => item.marketQuote?.pair === expectedPair && (!marketReader || item.readBy.includes(marketReader)) && Number.isFinite(item.marketQuote.value) && item.marketQuote.value > 0 && validDate(item.marketQuote.observedAt) && Date.parse(item.marketQuote.observedAt) <= Date.parse(clock()))
    if (request.resolutionPolicy?.version === PRICE_POLICY && (!marketReader || !quoteProof || quoteProof.url !== PRICE_URL)) throw courseFailure('PRICE_BASELINE_REQUIRED', '固定价格契约须由本轮市场席先取得匹配现价，不能改用其他基准。')
    let currentReference = null
    if (financial) currentReference = quoteProof ? { kind: 'price', value: quoteProof.marketQuote.value, unit: quoteProof.marketQuote.currency, currency: quoteProof.marketQuote.currency,
      pair: quoteProof.marketQuote.pair, observedAt: quoteProof.marketQuote.observedAt, url: quoteProof.url, evidenceId: quoteProof.evidenceId,
      verified: true, synthetic: Boolean(quoteProof.fixture || quoteProof.synthetic), timestampMeaning: 'system-observation-time' }
      : { kind: 'directional', value: null, unit: null, observedAt: null, url: source.url, evidenceId: source.evidenceId, verified: false }
    if (marketReader && currentReference?.verified) currentReference.observedAt = quoteProof.readObservations.find(item => item.readerId === marketReader)?.obtainedAt || currentReference.observedAt
    const conditionalOnly = Boolean(args.forceConditional || (financial && !currentReference?.verified))
    const assumptions = [...new Set([...(request.mode === 'preset' ? presetAssumptions(request.question, timeContext) : []), ...(args.defaultAssumptions || []),
      ...(listingEvent ? ['本题是用户明确提出的上市事件，不预测现有股价或代理标的涨跌；上市传闻不等于已挂牌。'] : [])])]
    const sourceLimitations = [...(args.sourceLimitations || []), ...(conditionalOnly ? ['未取得可验证现价，数值基准缺失；仅作有公开资料依据的条件性方向估计，不计分。'] : []), ...(quoteProof ? ['报价时间为系统取得该公开价格的观察时间，不冒充交易所逐笔成交时间。'] : [])]
    let rule = args.resolutionRule.replaceAll('{{TARGET_LOCAL}}', timeContext.targetAtLocalLabel)
    if (!strict) {
      const window = `固定观察窗口为${timeContext.windowStartsAtLocalLabel}至${timeContext.targetAtLocalLabel}。`
      if (listingEvent) rule = `${window}本题只判断用户明确提出的上市事件：窗口内出现交易所正式上市或挂牌记录才可判为是；不能把私人股份转让、上市传闻、其他公司或指数上涨当作上市，也不能把未抓到资料判为否。结果无法核实时暂不结算。`
      else if (financial && priceDirection) rule = currentReference?.verified
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
      sourceLimitations, conditionalOnly, timeContext, temporalPolicy, ...(request.tradingHorizon ? { tradingHorizon: request.tradingHorizon } : {}),
      researchBasis: { mode: conditionalOnly ? 'conditional' : request.mode === 'strict' ? 'verified-source' : 'alternative-public',
        summary: conditionalOnly ? '实际读取公开资料的条件性估计；缺少数值基准，不计分。' : '已读取公开研究依据；这不等同于官方已经确认未来结果。' },
      temporalPolicyBasis: '课程首版语义启发式；目标时点状态题在T之前不能以当前状态结算。' }
    store.updateRequest(request.requestId, { predictionId: prediction.predictionId, predictionVersion: prediction.version, normalized, status: 'researching', message: '', missingFields: [], error: null })
    store.bindPrediction(runId, prediction.predictionId, prediction.version)
    store.saveRun(runId, { state: { ...store.requireRun(runId).state, timeContext, latestReference: currentReference } })
    return normalized
  }
  async function compileBoundedPrediction(runId) {
    const run = store.requireRun(runId), request = store.requireRequest(run.requestId)
    if (request.normalized) return request.normalized
    const available = store.evidenceFor(runId).filter(item => item.text?.trim() && (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(clock())))
    const strict = request.mode === 'strict' ? request.strict || {} : {}
    const reportIds = new Set((reportView(runId)?.usable || effectiveRoleReports(store.listAssignments(runId))).flatMap(item => item.report.evidenceIds))
    const source = strict.resolutionSourceUrl ? available.find(item => urlKey(item.url) === urlKey(strict.resolutionSourceUrl))
      : available.find(item => reportIds.has(item.evidenceId) && !item.marketQuote) || available.find(item => reportIds.has(item.evidenceId)) || available[0]
    if (!source) throw courseFailure('UNVERIFIED_SOURCE', '未取得可读取的题目来源，保留调查结果，不创建虚假的可核验契约。')
    const time = run.state.timeContext || requestTime(request, clock())
    const normalized = await normalize(runId, { question: request.question, object: run.state.draft?.object || request.question,
      targetAt: strict.targetAt || time.targetAtUtc, forecastClosesAt: strict.targetAt || time.forecastClosesAtUtc,
      timezone: strict.timezone || time.timezone, resolutionSourceUrl: source.url,
      resolutionRule: strict.resolutionRule || '在目标时点按题目展示的默认口径与公开记录判断原命题是否成立；只有真实结果记录才能结算，不能以未查到资料判为否。',
      unresolvablePolicy: '来源不可读、定义或结果无法核实时暂不结算，保留来源限制。',
      watchQuery: request.question.slice(0, 120), interpretation: run.state.draft?.interpretation || '按用户原问、固定时间窗口和已读原文继续研究。',
      sourceLimitations: ['结果参考链接来自本轮已读资料，不保证该网页能提供未来的结构化结算记录。'] })
    event(runId, 'contract.compiled', { agentSpecId: 'main', name: '执行框架', summary: '已按固定时间窗口和子Agent实际读到的来源核定题目；此步骤由程序完成，没有新增模型调用。' })
    return normalized
  }
  async function closeoutBounded(runId, cause) {
    const run = store.requireRun(runId)
    if (terminal.has(run.status)) return
    if (finishTargetClarification(runId)) return
    const outputLanguage = store.requireRequest(run.requestId).outputLanguage
    const error = typeof cause === 'string' ? { code: 'BOUNDED_CLOSEOUT', message: cause } : { code: cause.code, message: cause.message }
    const reason = error.message
    store.saveRun(runId, { state: { ...run.state, closeoutFailure: error } })
    let failure = reason
    try {
      await compileBoundedPrediction(runId)
      const candidate = assembleForecastCandidate(store.listAssignments(runId), store.evidenceFor(runId), { outputLanguage })
      if (candidate && !run.usage.unknownUsage) {
        store.publishForecast(runId, candidate, workbench.getPrediction(store.requireRun(runId).predictionId))
        event(runId, 'budget.closeout', { agentSpecId: 'main', name: '执行框架', summary: outputLanguage === 'en' ? 'No model calls added. Valid researcher reports were assembled with an explicit program-aggregation label; verification and citation checks remain in force.' : '未追加模型调用，按有效研究员报告作明确标记的程序汇集；保留独立核验和引用守卫。', reason, error })
        finish(runId, 'completed', outputLanguage === 'en' ? 'This run has ended. Evidence-backed researcher estimates were assembled by the program and require review; the lead agent’s final decision is incomplete.' : '本轮已结束：已汇集研究员的有据估计；主Agent最终裁决未完成，结果标记为程序汇集、需复核。')
        return
      }
    } catch (error) { failure = `${reason}；${errorValue(error).message}` }
    const delivery = partialForecastSummary(store.listAssignments(runId), store.evidenceFor(runId), failure, { outputLanguage })
    const message = `${delivery.summary} ${delivery.gaps.join('；')} ${delivery.notice}`
    store.saveRun(runId, { state: { ...store.requireRun(runId).state, delivery } })
    store.updateRequest(run.requestId, { message, missingFields: delivery.gaps })
    event(runId, 'budget.closeout', { agentSpecId: 'main', name: '执行框架', summary: delivery.notice, reason: failure, error })
    finish(runId, 'insufficient', message)
  }
  async function executeMain(runId, signal) {
    let run = ensure(runId, signal)
    let state = structuredClone(run.state)
    const request = store.requireRequest(run.requestId)
    const phase = run.phase
    if (finishTargetClarification(runId)) return
    if (isBoundedForecast(run) && phase === 'prepare') {
      try {
        await compileBoundedPrediction(runId)
        store.saveRun(runId, { phase: 'review' })
      } catch (error) { await closeoutBounded(runId, errorValue(error)) }
      return
    }
    if (request.resolutionPolicy?.version === PRICE_POLICY && phase === 'review' && (!state.priceFinalSnapshot || Date.parse(clock()) - Date.parse(state.priceFinalSnapshot.refreshedAt) > 120000)) {
      const freshTools = toolsFor(runId, 'main', 'main', signal), results = {}
      for (const name of ['get_market_quote','get_market_history']) {
        const tool = freshTools.find(tool => tool.toolId === name), toolCallId = `${runId}_review_${name}_${state.priceRefreshCount || 0}`
        event(runId, 'tool.started', { agentSpecId: 'main', name: '主 Agent', toolCallId, toolId: name, summary: '汇总前读取最新行情；初始基准保持固定。' })
        const result = await tool.execute({ pair: 'BTC-USDT' }, { runId, assignmentId: 'main', agentInstanceId: `${runId}_main`, toolCallId, signal })
        event(runId, result.status === 'error' ? 'tool.failed' : 'tool.completed', { agentSpecId: 'main', name: '主 Agent', toolCallId, toolId: name, status: result.status, summary: result.summary, evidenceIds: result.evidenceIds })
        if (result.status !== 'ok') throw courseFailure('PRICE_FRESH_SOURCE_REQUIRED', '汇总前未取得有效最新行情，停止发布并保留缺口。', 409)
        results[name] = result
      }
      const quote = results.get_market_quote.data
      state.priceFinalSnapshot = { refreshedAt: clock(), quoteEvidenceId: quote.evidenceId, historyEvidenceId: results.get_market_history.evidenceIds[0] }
      state.priceRefreshCount = (state.priceRefreshCount || 0) + 1
      state.latestReference = { kind: 'price', pair: quote.pair, value: quote.value, currency: quote.currency, unit: quote.currency, observedAt: quote.observedAt, url: quote.url, evidenceId: quote.evidenceId, verified: true, synthetic: Boolean(quote.synthetic), timestampMeaning: 'system-observation-time' }
      store.saveRun(runId, { state })
    }
    const gatewayTools = toolsFor(runId, 'main', 'main', signal)
    const remainingFollowUps = followUpLimit(run) - (modern(run) ? followUpsUsed(run) : Number(Boolean(state.followUpDone)))
    const allowedNames = request.resolutionPolicy?.version === PRICE_POLICY && phase === 'review' ? ['propose_forecast','mark_insufficient'] : (request.purpose === 'research' || request.resolutionPolicy) && state.summaryResumeCount ? [request.purpose === 'research' ? 'submit_research_report' : 'propose_forecast', 'mark_insufficient'] : phase === 'intake' ? ['draft_and_delegate'] : phase === 'prepare' ? ['normalize_prediction', 'mark_insufficient'] : phase === 'triage' ? ['triage_update', 'mark_insufficient'] : phase === 'plan' ? ['delegate_work', 'mark_insufficient'] : [
      ...(remainingFollowUps > 0 ? ['request_followup'] : []), request.purpose === 'research' ? 'submit_research_report' : 'propose_forecast', 'mark_insufficient',
    ]
    if (exploratory(run) && phase === 'review' && reportView(runId).usable.length) {
      const index = allowedNames.indexOf('mark_insufficient'); if (index >= 0) allowedNames.splice(index, 1)
    }
    const mainResearchAllowed = phase === 'prepare' && !modern(run)
    const roleTools = roleToolsFor(runId)
    // The native tool schemas are shared; per-request deadline constraints must
    // never leak into another request or a restored legacy run.
    const advertised = structuredClone(mainResearchAllowed ? gatewayTools.map((tool) => ({ type: 'function', function: { name: tool.toolId, description: tool.description, parameters: tool.inputSchema } })).concat(allowedNames.map(name => roleTools.native(name))) : allowedNames.map(name => roleTools.native(name)))
    if (request.forecastWindowPolicy === FORECAST_WINDOW_POLICY) for (const tool of advertised) if (tool.function.name === 'draft_and_delegate') {
      tool.function.parameters.required = [...new Set([...tool.function.parameters.required, 'targetAt'])]
      tool.function.parameters.properties.targetAt = { type: 'string', const: resolveRequestDeadline(request) }
      tool.function.description += ` 必须targetAt原样回显${resolveRequestDeadline(request)}；所有题意、解释、假设和任务只能研究此封存期限，不得自选24个月或其他未来窗口。`
    }
    if (isBoundedForecast(run)) for (const tool of advertised) if (tool.function.name === 'propose_forecast') {
      tool.function.description += ' 本轮主Agent只提交概率、短总结和逐报告decisionNotes。请省略reasoningClaims；执行框架会从你采纳或保留条件的报告中，沿用已校验且在evidenceIds内的原始主张与引用，不需重新改写证据。outcomeKnown=false、outcome=null；evidenceAdequacy只能adequate或limited。资料有限的可用报告可以qualified，缺基准或校准说明限制，不等于没有预测。'
    }
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
        nowISO: clock(), purpose: request.purpose || 'forecast', groundingPolicy: request.groundingPolicy || null, timezone: request.strict?.timezone || request.timezone, targetAt: resolveRequestDeadline(request),
        deliveryPolicy: run.budget.deliveryPolicy || null, reportAdequacy: exploratory(run) ? ((view) => ({ roleCount: view.roleCount, partialRoleCount: view.partialRoleCount, completeRoleCount: view.completeRoleCount, rejected: view.rejected }))(reportView(runId)) : null,
        mode: request.mode, strict: request.strict || null, timeContext: state.timeContext || requestTime(request, clock()),
        defaultAssumptions: request.mode === 'preset' ? presetAssumptions(request.question, state.timeContext || requestTime(request, clock())) : [],
        normalized: contractContext(request, state.timeContext || requestTime(request, clock()), state.latestReference), draft: state.draft || null, orchestration: orchestrationView(run), historicalMemory: memoryForModel(state.memory),
        roleCatalogue: ['intake', 'plan'].includes(phase) ? roleCatalogue(runRoleSpecs(runId)) : [], defaultRoleIds: defaultRoles(runId, request.question), selectedRoleIds: state.triage?.selectedRoleIds?.length ? state.triage.selectedRoleIds : undefined,
        capabilityRequirements: request.resolutionPolicy?.version === PRICE_POLICY ? { requiredRoleIds: ['market','statistics','verification'], tools: ['get_market_quote','get_market_history'], instruction: '只分配目标前当前数据的研究：market取得本人现价基准，statistics取得本人现价及已关闭历史统计，verification核对本人现价字段、单位和当前时间。禁止要求研究员现在获取目标后的结果；未来未知不影响当前事实报告完整性。Binance BTC-USDT不是USD，未来概率未校准。汇总前系统再读最新行情，初始基准不变。' } : request.resolutionPolicy ? { requiredRoleIds: ['official', 'verification'], thirdRoleOptions: ['industry', 'statistics'], onlyTool: 'get_weather_warning', instruction: '固定官方完整JSON，无须全网调查；当前状态只支持未来推断，不能提前结算。' } : isBoundedForecast(run) ? { spotQuotePairs: ['BTC-USD','ETH-USD'], instruction: '仅BTC/ETH匹配资产才有专用get_market_quote；NVDA等股票安排公开行情页/新闻取证，不要求不存在的工具。取证上限以本次派工预算为准，优先搜索后读原文，报告给同一Yes命题的未校准概率，不追求未来结果、全套财报或重复核验封存日历。网页价格只是参考候选，不得宣称系统基准已verified。重大传闻必须保留转述来源和未确认限制。' } : null,
        previousTeam: request.team?.map((item) => item.roleId) || defaultRoles(runId, request.question), changeHints: state.changeHints || null,
        newEvidence: phase === 'triage' ? store.evidenceFor(runId).filter((item) => state.triage?.newEvidenceIds?.includes(item.evidenceId)).map(({ evidenceId, title, text, url, marketQuote }) => ({ evidenceId, title, text: text.slice(0, 1000), url, marketQuote })) : [],
        followUpDone: Boolean(state.followUpDone), followUpsRemaining: remainingFollowUps, reports: modelReportItems(runId),
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
        if (isBoundedForecast(run) && (state.main.calls >= runBudget(runId).mainRequests || (state.main.phaseCalls || 0) >= (run.budget.mainPhaseRequests || 2))) {
          await closeoutBounded(runId, { code: 'MAIN_BUDGET', message: '主Agent已达到本阶段的有界调用次数，停止追加研究。' }); return
        }
        if (state.main.calls >= runBudget(runId).mainRequests) throw courseFailure('MAIN_BUDGET', '主 Agent 已达到本轮调用上限。')
        if (phase === 'intake' && (state.main.phaseCalls || 0) >= 2) throw courseFailure('INTAKE_LIMIT', '题意整理未在两次有效决策内完成，未伪造派工；可检查模型协议后手动重试。')
        const used = store.requireRun(runId).usage
        const limits = runBudget(runId)
        state.main.baseSystem ||= (modern(run) ? modernMainSystem : state.main.messages[0].content.replace('10角色目录', '本轮可用角色目录')) + '\n只使用本轮roleCatalogue和工具schema列出的精确角色ID，不得恢复已删除席位；自定义名称不能冒充verification。' + decisionInstruction + (request.groundingPolicy ? groundingInstruction : '') + (request.purpose === 'research' ? '\n当前purpose=research：核验已披露财报和表述，直接submit_research_report，不创建未来契约或概率。' : '')
        state.main.messages[0].content = state.main.baseSystem + `\n[本轮执行规则与预算]\n阶段=${phase}；第${cycleOf(run)}个协作周期。你只整理、派工、核验报告和总结；v3初始不得先联网研究。若timeContext带tradingHorizon，交易日、市场日历、目标收盘与计数规则均由服务器封存，禁止用自然日乘24换算；题意中的其他相对词不能改写所选窗口。交易日任务仅提供股票/证券/基金标的也可继续，默认研究目标收盘相对本轮可核验基准是否上涨；代码、上市地、类型和基准仍须核验，无基准只作不计分条件估计，不编造价格或净值。intake最多2次有效决策且只调用draft_and_delegate；临时服务故障每步最多3次传输尝试，均计入总预算。研究员前最多5次决策调查、第6次只报告；资料足够可提前报告。会后最多2次定向补查，当前剩余${remainingFollowUps}次，不能无限搜索或为了展示凑轮数。\n单次输出上限${limits.maxTokens} tokens（含供应商思考/输出计量），主Agent总请求上限${limits.mainRequests}，已预留${state.main.calls}次；全轮模型上限${limits.maxModelRequests}、工具${limits.maxToolCalls}、${totalTokenLimit(limits) === null ? '总 token 不设上限' : `累计${totalTokenLimit(limits)} tokens`}。当前已用模型${used.modelRequests}、工具${used.toolCalls}、tokens ${used.totalTokens}；剩余模型${Math.max(0, limits.maxModelRequests - used.modelRequests)}、工具${Math.max(0, limits.maxToolCalls - used.toolCalls)}、tokens ${remainingTotalTokens(limits, used.totalTokens) ?? '不限'}。重试也计费，达到上限停止。\n公开文字简洁：题意/解释≤200中文字；每人任务≤300字、理由≤100字；总结≤400字，分歧和限制每条≤120字、各≤5条。字数是写作目标、token是实际执行上限，两者不能等同。不要输出隐藏推理或把无来源内容充作证据。`
        if (isBoundedForecast(run)) state.main.messages[0].content = state.main.baseSystem + `\n[有界预测执行规则]\n当前${phase}，每阶段最多${limits.mainPhaseRequests || 2}次模型决策（含修正），全轮主Agent最多${limits.mainRequests}次。intake只做短rewrite并派3种差异职责，不得联网。研究员各自收集2至3条信息并给同一Yes命题的probability。prepare由程序核定，不需模型重复整理。review只比较报告、概率及支持/反证，给出propose_forecast；最多${remainingFollowUps}次定向补查。不能把未来尚未知晓作为现在不能预测的理由，也不能编造基准或结算。sourceLimitations允许有，有限真实资料可以作明确限制的条件估计。概率不是证据充分度或投票正确率。最终必须逐份处理报告的assignmentId；无有效证据则说明缺口。\n单次输出上限${limits.maxTokens} tokens，含供应商计量的思考和答复；${totalTokenLimit(limits) === null ? '总 token 不设上限' : `总额度${totalTokenLimit(limits)} tokens`}，剩余模型${Math.max(0, limits.maxModelRequests - used.modelRequests)}次。题意≤200字，每人任务≤200字，汇总≤400字。按工具schema提交，无需展开隐藏推理或重抄长段来源。`
        if (isBoundedForecast(run)) state.main.messages[0].content += '\n最终汇总不要重新编写reasoningClaims，请省略该可选字段；harness沿用你decisionNotes采纳/保留的报告中已经验证的原文依据，你只决定概率、解释影响和分歧。不得把尚未核定的报价升格为系统固定基准，条件估计明确写“条件估计”。'
        if (exploratory(run)) state.main.messages[0].content += `\n[本题探索估计标准]\n预算更新：每阶段最多${limits.mainPhaseRequests}次有效决策；全轮主Agent最多${limits.mainRequests}次，补查剩余${remainingFollowUps}次。子Agent调查上限6次，报告及2次修正另计，仍受10次总调用和实际token约束。\n本题要输出有依据的未来方向和概率，不是现在证明未来结果。reportQuality=partial/status=insufficient表示材料有限，不表示所有发现无效；scorecard已过滤无关页脚、空引用和程序回执。只要至少一席有本人已读的实质原文和真实模型概率，就综合可用报告propose_forecast，给初步条件估计、evidenceAdequacy=limited、公开缺口；资料越少体现为不确定与需复核，不强求全部席完整或统计校准。只有访问失败、免责声明或没有实质原文才是不能估计的不足。\n逐份列decisionNotes，仅引用该报告实际evidenceIds。完整报告可adopted，部分报告优先qualified，纯来源失败/程序回执rejected且evidenceIds可空；不要把别席编号挂在它名下。已封存的交易日不需重复查日历，股票无专用报价也可作网页依据的条件估计。补查先用read_run_evidence实际复阅指定材料，不能因收到编号就直接声称本人读取。`
        if (request.forecastWindowPolicy === FORECAST_WINDOW_POLICY) state.main.messages[0].content += `\n[唯一预测期限]\n本题窗口和targetAt已由用户选择及服务器规则封存为${resolveRequestDeadline(request)}（${(state.timeContext || requestTime(request, clock())).targetAtLocalLabel}）。draft_and_delegate必须包含精确targetAt回显。question、interpretation、defaultAssumptions、每个研究员任务以及最后probabilityYes/summary必须针对同一截止；“未来”不能另选24个月。历史回看可用于取证，不是预测窗口。发现报告用了其他期限应拒绝或要求重做，不能静默缩期限沿用原概率。`
        const messages = isBoundedForecast(run) ? boundedMainMessages(state.main.messages, scoresFor(runId))
          : request.resolutionPolicy && phase === 'review' || request.purpose === 'research' && state.summaryResumeCount
            ? researchSummaryMessages(request.question, store.listAssignments(runId), store.evidenceFor(runId), request.resolutionPolicy ? { ...request.normalized, groundingPolicy: request.groundingPolicy || null, priceResolution: request.resolutionPolicy.version === PRICE_POLICY, latestReference: state.latestReference, priceFinalSnapshot: state.priceFinalSnapshot } : null) : structuredClone(state.main.messages)
        const admission = isBoundedForecast(run) ? planModelCall({ messages, tools: advertised, maxTotalTokens: totalTokenLimit(limits), usedTotalTokens: used.totalTokens,
          maxOutputTokens: limits.maxTokens, reserveTokens: 2048, minOutputTokens: 1024 }) : null
        if (admission && (!admission.canCall || used.modelRequests >= limits.maxModelRequests || used.unknownUsage)) {
          await closeoutBounded(runId, { code: used.unknownUsage ? 'COURSE_USAGE_UNKNOWN' : 'COURSE_BUDGET', message: used.unknownUsage ? '部分模型请求用量未知，停止追加付费调用，保留已有资料。' : '剩余输入与输出预算不足，使用已有真实报告收尾。' }); return
        }
        state.main.calls += 1
        state.main.currentAttempt = (state.main.currentAttempt || 0) + 1
        store.saveRun(runId, { state })
        const timeout = AbortSignal.timeout(runBudget(runId).timeoutMs)
        const combined = AbortSignal.any([signal, timeout])
        try {
          response = await abortable(() => providerFor(runId).complete({ messages, tools: advertised, signal: combined,
            maxTokens: admission ? admission.maxTokens : boundedOutputTokens(runBudget(runId), store.requireRun(runId).usage.totalTokens),
            ...((isBoundedForecast(run) || request.purpose === 'research' || request.resolutionPolicy) && provider.settings?.protocol === 'deepseek' && provider.settings.thinking === 'enabled' ? { reasoningEffortOverride: 'low' } : {}) }), combined)
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
        if (!roleTools.validate(call.function.name, args)) throw courseFailure('MAIN_ARGUMENTS', '主 Agent 的动作未通过格式校验。' + JSON.stringify(roleTools.validationErrors?.(call.function.name) || []))
        if (call.function.name === 'draft_and_delegate') {
          if (phase !== 'intake' || !modern(run)) throw courseFailure('DRAFT_STAGE', '只能在新轮题意整理阶段生成草稿并派工。')
          const timeIssue = intakeWindowIssue(args, request, state.timeContext || requestTime(request, clock()))
          if (timeIssue) throw courseFailure(timeIssue.code, timeIssue.message, 409)
          const selected = args.assignments.map((item) => item.roleId)
          if (new Set(selected).size !== 3 || !selected.includes('verification')) throw courseFailure('DELEGATION_ROLES', '首次需三种不同职责且包含核验席。')
          if (request.resolutionPolicy?.version === PRICE_POLICY ? !['market','statistics','verification'].every(role => selected.includes(role)) : request.resolutionPolicy && (!selected.includes('official') || !selected.some(role => ['industry', 'statistics'].includes(role)))) throw courseFailure('DELEGATION_CAPABILITY', request.resolutionPolicy?.version === PRICE_POLICY ? '固定价格题需要market、statistics、verification三席。' : '本题使用固定官方警告工具：需official与verification，第三席从industry/statistics选择。新闻搜索不能替代完整官方快照。')
          state.draft = { status: 'draft', question: args.question, originalQuestion: request.question, object: args.object,
            interpretation: args.interpretation, defaultAssumptions: args.defaultAssumptions || [],
            targetAt: request.forecastWindowPolicy === FORECAST_WINDOW_POLICY ? args.targetAt : resolveRequestDeadline(request), timezone: request.strict?.timezone || request.timezone, sourceVerified: false,
            ...(request.forecastWindowPolicy === FORECAST_WINDOW_POLICY ? { forecastWindowPolicy: FORECAST_WINDOW_POLICY, modelDeclaredTargetAt: args.targetAt } : {}),
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
          const previousTeam = request.team?.map((item) => item.roleId) || defaultRoles(runId, request.question)
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
          assignment(runId, args.roleId, args.objective, args.reason, true, state.cycle || 1, {
            objective: args.objective, reason: args.reason, evidenceIds: args.evidenceIds, requestedAt: clock(),
            parentAssignmentIds: store.listAssignments(runId).filter((item) => item.report?.evidenceIds.some((id) => args.evidenceIds.includes(id))).map((item) => item.assignmentId),
          })
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
            if (isBoundedForecast(run)) store.saveRun(runId, { state: { ...store.requireRun(runId).state, delivery: partialForecastSummary(store.listAssignments(runId), available, args.message, { outputLanguage: request.outputLanguage }) } })
            finish(runId, 'insufficient', args.message); finished = true; result = { status: 'insufficient', data: args }
          }
        } else if (call.function.name === 'submit_research_report') {
          store.publishResearch(runId, args)
          finish(runId, 'completed', '研报已封存，可查看财报发现、引用、限制与协作裁决。')
          finished = true; result = { status: 'ok' }
        } else if (call.function.name === 'propose_forecast') {
          const targetIssue = targetIssueFor(runId)
          if (targetIssue) throw courseFailure(targetIssue.code, targetIssue.message, 409)
          const timeIssue = forecastWindowTextIssue([{ path: 'forecast.summary', text: args.summary }], request, state.timeContext || requestTime(request, clock()))
          if (timeIssue) throw courseFailure(timeIssue.code, timeIssue.message, 409)
          if (isBoundedForecast(run)) {
            const view = reportView(runId)
            const reports = view?.usable || effectiveRoleReports(store.listAssignments(runId)), notes = args.decisionNotes || []
            const cited = new Set(args.evidenceIds), accepted = new Set(notes.filter(note => ['adopted', 'qualified'].includes(note.disposition)).map(note => note.assignmentId))
            if (reports.some(item => !notes.some(note => note.assignmentId === item.assignmentId))) throw courseFailure('DECISION_EVIDENCE', '请逐份处理有效报告的assignmentId，说明采纳、保留条件或拒绝；不能用空裁决代替汇总。')
            const claims = reports.filter(item => accepted.has(item.assignmentId))
              .flatMap(item => [...item.report.support, ...item.report.counterevidence].filter(claim => claim.evidenceIds.every(id => cited.has(id)))).slice(0, 8)
            if (args.reasoningClaims?.length) {
              const available = store.evidenceFor(runId)
              let original, supplied
              try { original = validateGroundedClaims(claims, available, { asOf: clock() }); supplied = validateGroundedClaims(args.reasoningClaims, available, { asOf: clock() }) }
              catch (error) { throw courseFailure('CLAIM_GROUNDING', error.message) }
              if (supplied.some(claim => !original.some(item => digest(item) === digest(claim)))) throw courseFailure('CLAIM_GROUNDING', '本轮汇总依据须沿用已采纳报告的原始主张；请省略reasoningClaims，由框架传递引用。新推断可在summary中明确说明。')
            }
            args.reasoningClaims = claims
          }
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
      if (isBoundedForecast(run)) event(runId, 'action.rejected', { agentSpecId: 'main', name: '主 Agent', toolId: call.function.name, error: result.error, summary: result.summary })
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
      runRoleSpecs(runId)
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
      if (isBoundedForecast(store.requireRun(runId)) && ['COURSE_BUDGET', 'BUDGET_EXHAUSTED', 'MAIN_BUDGET', 'MAIN_PROTOCOL', 'INTAKE_LIMIT', 'MODEL_INCOMPLETE'].includes(error.code)) {
        await closeoutBounded(runId, errorValue(error)); return
      }
      const saved = errorValue(error)
      const resumeSuffix = store.requireRun(runId).state.summaryResumeCount ? '_' + store.requireRun(runId).state.summaryResumeCount : ''
      store.saveRun(runId, { status: 'failed', error: saved, message: saved.message }, [{ eventId: `${runId}_failed${resumeSuffix}`, type: 'run.finished', payload: { status: 'failed', summary: saved.message, error: saved } }])
      notify()
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (stopping) return
    pauseKnownProviderFailures()
    for (const watch of store.listWatches()) {
      if (watch.status === 'active' && isPriceDirection(store.requireRequest(watch.requestId))) {
        store.saveWatch(watch.requestId, { status: 'off', nextDueAt: null })
      }
    }
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
      if (terminal.has(run.status) || jobs.has(run.runId) || store.requireRequest(run.requestId).deleted) continue
      if (isPriceDirection(store.requireRequest(run.requestId))) {
        const message = '旧版三分类调查在升级后归档，已有记录保留。继续预测请创建新的二元任务。'
        store.saveRun(run.runId, { status: 'insufficient', phase: 'finished', message }, [
          { eventId: run.runId + '_legacy_archived', type: 'run.finished', payload: { status: 'insufficient', summary: message } },
        ])
        continue
      }
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => execute(run.runId, controller)).finally(() => { jobs.delete(run.runId); notify(); pump(); schedule() })
      jobs.set(run.runId, { controller, promise })
    }
  }
  return {
    metadata: store.metadata,
    capabilities: { stage: 'course-adaptive', modelMode, modelRef: provider.model || 'injected', sourceMode,
      groundingPolicy: evidencePolicy, tradingDayHorizons: TRADING_DAY_CAPABILITIES, outputLanguages: [...OUTPUT_LANGUAGES],
      reasoningSettings: provider.settings ? Object.fromEntries(['thinking', 'reasoningEffort', 'timeoutMs', 'maxOutputTokens', 'protocol'].map((key) => [key, provider.settings[key]])) : null,
      sources: sourceTools.capabilities, supervisor: true, get roles() { return activeRoleSpecs().map(spec => spec.agentSpecId) }, get roleCatalogue() { return roleCatalogue(activeRoleSpecs()) },
      get teamAvailability() { try { requireTeam(activeRoleSpecs()); return { available: true, minimumRoles: 3, requiredRoleIds: ['verification'] } } catch (error) { return { available: false, code: error.code, message: error.message, minimumRoles: 3, requiredRoleIds: ['verification'] } } }, nativeToolProtocol: true, persistent: true, watchPlans: true, forecastPublishing: true, historyMemory: true, watchTriage: true,
      orchestration: { harnessVersion, intake: harnessVersion >= 3 ? 'rewrite-and-delegate' : 'research-before-delegate', maxCycles: harnessVersion >= 3 ? 3 : 2, maxFollowUps: harnessVersion >= 3 ? 2 : 1, investigationSteps: 5, reportStep: 6 },
      limits: { maxConcurrentRuns: 1, workers: 3, localWorkers: 2, followUps: 2, modelRequestsPerWorker: 6, toolsPerWorker: 6, modelRequestsPerRun: 40, toolCallsPerRun: 64, get totalTokensPerRun() { return store.getSettings().predictionBudget.maxTotalTokens }, maxOutputTokens: maxOutput, timeoutMs, watchIntervalMs } },
    createRequest(input, options) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) throw courseFailure('INVALID_QUESTION', '请输入一句具体事件问题。')
      if (Object.keys(input).some((key) => !['question', 'horizonHours', 'horizonTradingDays', 'market', 'timezone', 'mode', 'watch', 'strict', 'purpose', 'outputLanguage'].includes(key)) ||
        (input.watch !== undefined && typeof input.watch !== 'boolean')) throw courseFailure('INVALID_COURSE_INPUT', '不支持手工材料、工具授权或其他隐藏配置。')
      if (Object.hasOwn(input, 'outputLanguage') && !OUTPUT_LANGUAGES.includes(input.outputLanguage)) throw courseFailure('INVALID_OUTPUT_LANGUAGE', '输出语言须为en或zh-CN。')
      const trading = input.horizonTradingDays !== undefined
      if (trading && (!TRADING_DAY_OPTIONS.includes(input.horizonTradingDays) || input.horizonHours !== undefined || input.purpose === 'research')) throw courseFailure('INVALID_TRADING_HORIZON', '预测交易日窗口须为1、3、5或20，不能与小时窗口或研报目的混用。')
      if (input.market !== undefined && !trading) throw courseFailure('INVALID_TRADING_MARKET', '市场上下文只用于交易日窗口。')
      const tradingTimezone = trading ? tradingMarketTimezone(input.question, input.market) : null
      if (input.horizonHours !== undefined && (!Number.isInteger(input.horizonHours) || input.horizonHours < 1 || input.horizonHours > 168)) throw courseFailure('INVALID_PRESET', '窗口应为一至一百六十八小时。')
      if (input.purpose !== undefined && !['forecast', 'research'].includes(input.purpose)) throw courseFailure('INVALID_PURPOSE', '任务目的须为forecast或research。')
      if (input.purpose === 'research' && (input.strict || input.mode === 'strict' || input.watch === true)) throw courseFailure('INVALID_RESEARCH_INPUT', '研报不使用预测契约或自动监听。')
      const data = { purpose: input.purpose || 'forecast', question: input.question.trim(), ...(trading ? { horizonTradingDays: input.horizonTradingDays, ...(input.market !== undefined ? { market: input.market } : {}) } : { horizonHours: durationHours(input.question) ?? input.horizonHours ?? 48 }), timezone: input.timezone || tradingTimezone || 'Asia/Shanghai',
        mode: input.mode || 'preset', watch: input.watch === true, modelMode, sourceMode, providerIdentity: identity, modelRef: provider.model || null, budget, harnessVersion }
      if (Object.hasOwn(input, 'outputLanguage')) data.outputLanguage = input.outputLanguage
      if (evidencePolicy) data.groundingPolicy = evidencePolicy
      if (data.purpose === 'research') { data.watch = false; data.budget = { ...budget, maxModelRequests: 24, maxToolCalls: 36, maxTotalTokens: 160000, mainRequests: 8, maxTokens: Math.min(maxOutput, 16384), worker: { ...budget.worker, maxModelRequests: 5, maxTotalTokens: 40000, maxTokens: Math.min(maxOutput, 8192), reserveReportTokens: 12000 } } }
      if ((!trading && (!Number.isInteger(data.horizonHours) || data.horizonHours < 1 || data.horizonHours > 168)) || !['preset', 'strict'].includes(data.mode)) throw courseFailure('INVALID_PRESET', '窗口应为一至一百六十八小时，模式为preset或strict。')
      try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format() } catch { throw courseFailure('INVALID_TIMEZONE', '请选择有效时区。') }
      if (data.mode === 'strict') {
        const strict = input.strict ?? {}
        if (typeof strict !== 'object' || Array.isArray(strict) || Object.keys(strict).some((key) => !['targetAt', 'resolutionRule', 'resolutionSourceUrl', 'timezone'].includes(key)) ||
          (strict.targetAt !== undefined && (!validDate(strict.targetAt) || Date.parse(strict.targetAt) <= Date.parse(clock()))) ||
          (strict.resolutionRule !== undefined && (typeof strict.resolutionRule !== 'string' || !strict.resolutionRule.trim() || strict.resolutionRule.length > 4000)) ||
          (strict.resolutionSourceUrl !== undefined && !validUrl(strict.resolutionSourceUrl))) throw courseFailure('INVALID_STRICT_CONTRACT', '请修正已填写的日期、规则或来源；空缺字段可由主 Agent 自动补充。')
        data.strict = { ...strict }
        if (data.purpose === 'forecast' && marketPricePair(data.question) === 'BTC-USD' && strict.resolutionSourceUrl === PRICE_URL && strict.resolutionRule === PRICE_RULE && validDate(strict.targetAt)) {
          data.resolutionPolicy = { version: PRICE_POLICY, targetAt: new Date(strict.targetAt).toISOString(), observationWindowMs: 300000 }
          data.budget = { ...budget, maxModelRequests: 28, maxToolCalls: 12, maxTotalTokens: 300000, mainRequests: 8, maxTokens: Math.min(maxOutput, 16384), worker: { ...budget.worker, maxModelRequests: 6, maxToolCalls: 2, maxTotalTokens: 80000, maxTokens: Math.min(maxOutput, 8192), reserveReportTokens: 14000 } }
          data.watch = false
        }
        if (data.purpose === 'forecast' && /香港天文台/.test(data.question) && /红色火灾危险警告/.test(data.question) && strict.resolutionSourceUrl === WARNING_URL && strict.resolutionRule === WARNING_RULE) {
          data.resolutionPolicy = { version: WARNING_POLICY, targetAt: new Date(strict.targetAt).toISOString(), observationWindowMs: 300000 }
          data.budget = { ...budget, maxModelRequests: 18, maxToolCalls: 12, maxTotalTokens: 80000, mainRequests: 6, maxTokens: Math.min(maxOutput, 8192), worker: { ...budget.worker, maxModelRequests: 4, maxToolCalls: 2, maxTotalTokens: 18000, maxTokens: Math.min(maxOutput, 4096), reserveReportTokens: 7000 } }
          data.watch = false
        }
        if (strict.timezone !== undefined) {
          if (typeof strict.timezone !== 'string' || !strict.timezone.trim()) throw courseFailure('INVALID_TIMEZONE', '严格模式时区无效。')
          try { new Intl.DateTimeFormat('en', { timeZone: strict.timezone }).format() } catch { throw courseFailure('INVALID_TIMEZONE', '严格模式时区无效。') }
        }
      }
      // Stable creation input keeps idempotent retries independent of later UI
      // settings. The store allocates the actual bounded budget at first snapshot.
      if (data.purpose === 'forecast' && !data.resolutionPolicy && harnessVersion >= 3) data.budget = boundedForecastBudget({ ...budget,
        ...(data.mode === 'preset' ? { deliveryPolicy: EXPLORATORY_DELIVERY_POLICY } : {}) }, budget.maxTotalTokens)
      if (data.budget.deliveryPolicy === EXPLORATORY_DELIVERY_POLICY) {
        data.groundingPolicy ||= groundingPolicy
        data.financialTargetPolicy = FINANCIAL_TARGET_POLICY
        data.forecastWindowPolicy = FORECAST_WINDOW_POLICY
      }
      const specs = requireTeam(activeRoleSpecs(), data)
      const result = store.createRequest(data, { ...options, ...(data.purpose === 'forecast' ? { predictionBudget: store.getSettings().predictionBudget } : {}) })
      const createdRun = store.requireRun(result.activeRunId || result.latestRunId)
      if (!terminal.has(createdRun.status) && !Array.isArray(createdRun.state.roleSpecs)) store.saveRun(createdRun.runId, { state: { ...createdRun.state, roleSpecs: specs } })
      notify(); pump(); return publicRequest(result)
    },
    getSettings: () => store.getSettings(),
    updateSettings: (input) => store.updateSettings(input),
    listRequests: () => store.listRequests().map(publicRequest),
    listDeletedRequestIds: () => store.listDeletedRequestIds(),
    listDeletedPredictionIds: () => store.listDeletedPredictionIds(),
    deleteRequest(requestId, input) {
      const request = store.requireRequest(requestId)
      if (!request.deleted && (resolvingRequests.has(requestId) || store.listRuns({ requestId }).some(run => jobs.has(run.runId)))) {
        throw courseFailure('REQUEST_IN_USE', '任务仍在执行，请等待完成后再删除历史。', 409)
      }
      const receipt = store.deleteRequest(requestId, input)
      notify(); schedule(); return receipt
    },
    getRequest: (requestId) => publicRequest(store.requireRequest(requestId)),
    getRun: (runId) => publicRun(store.requireRun(runId)),
    resumeResearchSummary(runId) { const current = store.requireRun(runId), request = store.requireRequest(current.requestId); const run = store.resumeResearchSummary(runId, { maxTokens: Math.min(maxOutput, request.resolutionPolicy ? 6000 : 16384) }); notify(); pump(); return publicRun(run) },
    assembleResearchReport(runId) { store.publishResearch(runId, null, { assemble: true }); notify(); return publicRun(store.requireRun(runId)) },
    async resolve(requestId) {
      const request = store.requireLiveRequest(requestId), old = store.getResult(requestId)
      if (old) return old
      if (![WARNING_POLICY, PRICE_POLICY].includes(request.resolutionPolicy?.version) || !request.normalized || request.status === 'stopped' || request.activeRunId) throw courseFailure('RESOLUTION_UNAVAILABLE', '此任务尚无可核验的固定预测。', 409)
      const target = Date.parse(request.normalized.targetAt), at = Date.parse(clock())
      if (at < target) throw courseFailure('RESULT_NOT_AVAILABLE', '目标时点尚未到达。', 409)
      if (at > target + 300000) throw courseFailure('RESOLUTION_WINDOW', '已错过5分钟观察窗口，保持不可核验。', 409)
      if (resolvingRequests.has(requestId)) throw courseFailure('REQUEST_IN_USE', '本题正在核验结果，请等待完成。', 409)
      resolvingRequests.add(requestId)
      try {
        let source
        const price = request.resolutionPolicy.version === PRICE_POLICY
        try { source = await (price ? priceReader || readPriceSnapshot : warningReader || readWarnings)({ now: clock, mode: request.modelMode === 'mock' ? 'mock' : 'live' }) } catch { throw courseFailure('RESULT_SOURCE_UNAVAILABLE', '来源未返回有效快照；不能将网络失败登记为No，可在观察窗口内重试。', 409) }
        const result = price ? store.recordPriceResult(requestId, source) : store.recordWarningResult(requestId, source); notify(); return result
      } finally { resolvingRequests.delete(requestId) }
    },
    listRuns: (options) => store.listRuns(options).map(publicRun),
    listEvents: (options) => store.listEvents(options),
    listForecasts: (options) => store.listForecasts(options),
    graph: (options) => ({ relations: store.listRelations(options) }),
    check(requestId) {
      const requestForTeam = store.requireLiveRequest(requestId)
      const existingRun = requestForTeam.activeRunId && store.requireRun(requestForTeam.activeRunId)
      if (!existingRun || terminal.has(existingRun.status)) requireTeam(activeRoleSpecs(), requestForTeam, (requestForTeam.team || []).map(item => item.roleId))
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
