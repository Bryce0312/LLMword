import { h, dataContent, dataLink, link, button, header, empty, field, input, textarea, formError, api, write, toast, goto, fmt, sourceLink } from './workbench-core.js'
import { createCourseProjection, projectCourseSnapshot, courseForecastPoints } from './course-projection.mjs'
import { createCourseRoom } from './workbench-course-room.js'
import { courseChart } from './workbench-course-chart.js'
import { guardCourseSubmission, isMissingCourseApi, unavailableCourseCapability } from './course-capability.mjs'
import { courseTeam, courseRoleName, normalizeCourseRole } from './course-team.mjs'
import { courseRequestProgress, courseStatusLabel as statusLabel, isCourseTerminal as isTerminal, courseReasoningLabel } from './course-status.mjs'
import { courseRuns, selectCourseRoomRun, courseRunLabel, courseAnswerProvenance, courseRunBelongsToRequest } from './course-runs.mjs'
import { courseRequestFailure, courseRequestAction, courseRequestCanStop } from './course-errors.mjs'
import { courseWorkflowView, courseUsageText } from './course-workflow.mjs'
import { courseMemoryPolicyLines } from './course-memory.mjs'
import { renderCollaboration } from './course-collaboration.js'
import { formatCourseProbability, courseProbabilityPair } from './course-probability.mjs'

const requestId = (record) => record.requestId ?? record.id
const requestRunId = (record) => record.activeRunId ?? record.latestRunId ?? record.runId ?? record.run?.runId ?? record.latestRun?.runId
const recordsOpenByRun = new Map()
const modelText = (data, ctx) => (data.modelMode ?? ctx.cache.config.modelMode) === 'live' ? '真实模型' : (data.modelMode ?? ctx.cache.config.modelMode) === 'mock' ? '模拟模型' : '模型模式未提供'
const sourceText = (data) => ({ live: '联网来源', replay: '历史／测试快照', fixture: '测试快照', provided: '用户提供材料' })[data.sourceMode] ?? '来源模式未提供'
function requestStateLabel(data) {
  return courseRequestProgress(data).label
}
export function courseWatchEnabled(record = {}) {
  if (record.purpose === 'research') return false
  if (typeof record.watchEnabled === 'boolean') return record.watchEnabled
  if (typeof record.watch === 'boolean') return record.watch
  return ['active', 'paused_provider', 'completed'].includes(record.watch?.status)
}
function saveRequest(ctx, record) {
  const id = requestId(record); if (!id) return
  const previous = (ctx.cache.courseRequests ?? []).find((r) => requestId(r) === id)
  ctx.cache.courseRequests = (ctx.cache.courseRequests ?? []).filter((r) => requestId(r) !== id).concat(record)
  if (JSON.stringify([courseRequestProgress(previous ?? {}), previous?.normalized?.question, previous?.forecast?.forecastId, requestRunId(previous ?? {})]) !== JSON.stringify([courseRequestProgress(record), record.normalized?.question, record.forecast?.forecastId, requestRunId(record)])) ctx.refreshSidebar()
}

export function courseStartForm(ctx, { standalone = false, headingId } = {}) {
  const prior = ctx.courseRetryInput ?? {}; ctx.courseRetryInput = null
  const financialEntry = document.body.dataset.financialEntry === 'true'
  const strictModeHidden = () => financialEntry || document.body.dataset.hideStrictMode === 'true'
  let horizonHours = prior.horizonHours ?? 48
  let horizonTradingDays = [1, 3, 5, 20].includes(prior.horizonTradingDays) ? prior.horizonTradingDays : 5
  let mode = strictModeHidden() ? 'preset' : prior.mode ?? 'preset'
  let strictTarget
  const localTime = (date) => new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const form = h('form', financialEntry ? 'cc-start-form cc-financial-form' : 'cc-start-form'); form.noValidate = true
  const modes = h('div', 'cc-mode-tabs'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '题目模式')
  const strict = h('div', 'cc-strict-fields wb-form-grid'); strict.hidden = mode !== 'strict'
  const presetButton = button('直接提问', () => setMode('preset'), 'cc-mode')
  const strictButton = button('严格模式', () => setMode('strict'), 'cc-mode')
  function setMode(value) { mode = strictModeHidden() ? 'preset' : value; strict.hidden = mode !== 'strict'; presetButton.setAttribute('aria-pressed', String(mode === 'preset')); strictButton.setAttribute('aria-pressed', String(mode === 'strict')) }
  modes.append(presetButton, strictButton); setMode(mode)
  const purpose = document.createElement('select'); purpose.setAttribute('aria-label', '研究目的')
  for (const [value, label] of [['forecast', '事件预测'], ['research', '财报解读与表述核验']]) { const option = h('option', '', label); option.value = value; purpose.append(option) }
  purpose.value = prior.purpose || 'forecast'
  let question
  if (financialEntry) {
    const title = h('h2', 'cc-financial-question-title', '写下一个你关注的股票证券基金'); title.id = 'cc-financial-question-title'
    question = input(prior.question ?? ''); question.name = 'question'; question.id = 'field-question'; question.autocomplete = 'off'; question.spellcheck = false
    question.setAttribute('aria-labelledby', headingId || title.id)
    const questionError = h('small', 'wb-field-error'); questionError.dataset.fieldError = 'question'
    if (!headingId) form.append(title)
    form.append(h('div', 'wb-field', question, questionError))
  } else {
    form.append(h('label', '', '研究目的 ', purpose), modes, h('h2', '', '你希望研究什么？'))
    question = field(form, 'question', '写下一句希望跟踪的问题', textarea(prior.question ?? '', 2))
  }
  question.placeholder = financialEntry ? '例如：腾讯控股、00700.HK、沪深300ETF（A股）、NVDA（美股）' : '例如：核验英伟达最新财报的营收、指引及管理层表述'; question.maxLength = 2000
  const chips = h('div', 'cc-horizon-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', financialEntry ? '预测窗口（交易日）' : '预测窗口')
  const chipButtons = []
  const horizonOptions = financialEntry ? [[1, '1 个交易日'], [3, '3 个交易日'], [5, '5 个交易日'], [20, '20 个交易日']] : [[24, '24 小时'], [48, '48 小时'], [168, '7 天']]
  for (const [value, name] of horizonOptions) {
    const chip = button(name, () => {
      if (financialEntry) horizonTradingDays = value; else horizonHours = value
      for (const b of chipButtons) b.setAttribute('aria-pressed', String(Number(financialEntry ? b.dataset.tradingDays : b.dataset.hours) === value))
      if (!financialEntry && strictTarget && !strictTarget.dataset.userEdited) strictTarget.value = localTime(new Date(Date.now() + value * 3600000))
    }, 'cc-time-chip')
    if (financialEntry) chip.dataset.tradingDays = value; else chip.dataset.hours = value
    chip.setAttribute('aria-pressed', String((financialEntry ? horizonTradingDays : horizonHours) === value)); chips.append(chip); chipButtons.push(chip)
  }
  const horizonHint = financialEntry ? '代码和市场优先；英伟达、苹果等已识别美股名称采用美股日历线索，其余未注明默认港股，身份仍须核验。按对应市场休市日计算，从创建日期后的下一交易日起计数，第 N 个交易日收盘截止。' : '宽泛地问也可以。系统补全研究口径、选择研究员并找资料；默认 48 小时，可选上方窗口。问“今天”时跟踪到当地今天结束，明确日期优先。结果会说明“按这个意思研究”，你可以纠正。'
  form.append(h('div', 'cc-duration', h('span', '', '关注多久'), chips), h('p', 'cc-form-hint', horizonHint))
  let forecastWatch = courseWatchEnabled(prior)
  const watchEnabled = input('', 'checkbox'); watchEnabled.name = 'watch'; watchEnabled.id = 'field-watch'; watchEnabled.checked = forecastWatch
  const watchHint = h('small', '', '默认只研究一次；勾选后，服务器会定时检查新信息并可能继续调用模型。'); watchHint.id = 'course-watch-hint'
  watchEnabled.setAttribute('aria-describedby', watchHint.id)
  const watchChoice = h('div', 'cc-watch-choice wb-checks', h('label', '', watchEnabled, h('span', '', '持续关注')), watchHint)
  watchEnabled.addEventListener('change', () => { forecastWatch = watchEnabled.checked === true })
  form.append(watchChoice)
  const priorTarget = prior.strict?.targetAt ? new Date(prior.strict.targetAt) : new Date(Date.now() + horizonHours * 3600000)
  strictTarget = field(strict, 'targetAt', '目标时间（本机时区）', input(!Number.isNaN(priorTarget.valueOf()) ? localTime(priorTarget) : '', 'datetime-local'))
  if (prior.strict?.targetAt) strictTarget.dataset.userEdited = 'true'
  strictTarget.addEventListener('input', () => { strictTarget.dataset.userEdited = 'true' })
  field(strict, 'timezone', '展示时区', input(prior.strict?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone))
  field(strict, 'resolutionRule', '什么算发生', textarea(prior.strict?.resolutionRule ?? '', 2))
  field(strict, 'resolutionSourceUrl', '指定判定来源', input(prior.strict?.resolutionSourceUrl ?? '', 'url'))
  strict.append(h('p', 'wb-muted', '严格模式固定你填写的时间、规则和来源，仍由系统自动找资料；不需要选择研究员或粘贴材料。'))
  const start = h('button', 'wb-button wb-primary cc-start', financialEntry ? '开始预测' : '开始跟踪'); start.type = 'submit'
  let submitting = false; let checking = false
  const capabilityNotice = h('div', 'cc-capability-notice'); capabilityNotice.setAttribute('aria-live', 'polite')
  const recheck = button('重新检查当前服务', () => { void checkCurrentService() }, 'wb-button')
  function formCapability(capability = ctx.cache.courseCapability) {
    if (!financialEntry || purpose.value === 'research' || capability?.available !== true) return capability
    const config = capability.config
    const trading = config?.tradingDayHorizons ?? config?.capabilities?.tradingDayHorizons
    const supported = Array.isArray(trading?.options) && [1, 3, 5, 20].every(days => trading.options.includes(days)) && trading.default === 5 && trading.defaultMarket === 'HK'
    return supported ? capability : { ...unavailableCourseCapability('restart-required'), tradingDayHorizonsRequired: true, message: '当前服务尚未加载交易日窗口功能，请重启当前服务后点击“重新检查当前服务”。输入内容会保留。' }
  }
  function renderCapability() {
    const capability = formCapability()
    start.disabled = submitting || checking || capability?.available !== true
    start.textContent = checking ? '正在检查当前服务…' : submitting ? (financialEntry && purpose.value !== 'research' ? '正在创建预测…' : '正在创建跟踪…') : capability?.available ? (purpose.value === 'research' ? '开始财报核验' : financialEntry ? '开始预测' : '开始跟踪') : capability?.kind === 'restart-required' ? '需要重启当前服务' : '自动跟踪暂不可用'
    recheck.disabled = submitting || checking
    capabilityNotice.dataset.courseCapability = checking ? 'checking' : capability?.kind ?? 'unchecked'
    capabilityNotice.hidden = capability?.available === true && !checking && !ctx.cache.courseHistoryError
    capabilityNotice.replaceChildren(h('p', '', checking ? '正在检查当前地址的服务能力，输入内容会保留。' : capability?.available ? ctx.cache.courseHistoryError : capability?.message ?? '正在检查当前服务的自动跟踪能力。'), h('div', 'wb-actions', recheck, link('使用高级材料研读', '#/advanced', 'wb-text-button')))
  }
  async function checkCurrentService() {
    checking = true; renderCapability()
    try { return formCapability(await ctx.checkCourseCapability()) }
    finally { checking = false; renderCapability() }
  }
  if (!financialEntry) form.append(strict)
  form.append(capabilityNotice, start)
  const syncPurpose = () => { const research = purpose.value === 'research'; modes.hidden = research; strict.hidden = research || mode !== 'strict'; form.querySelector('.cc-duration').hidden = research; form.querySelector('.cc-form-hint').hidden = research; watchChoice.hidden = research; watchEnabled.disabled = research; watchEnabled.checked = !research && forecastWatch; renderCapability() }
  purpose.addEventListener('change', syncPurpose); syncPurpose()
  if (!ctx.cache.courseCapability) void checkCurrentService()
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (submitting || checking) return
    submitting = true; renderCapability()
    try {
      if (!question.value.trim()) throw Object.assign(new Error(financialEntry ? '请先输入你关注的股票、证券或基金。' : '请先写下希望跟踪的问题。'), { fields: ['question'] })
      const data = Object.fromEntries(new FormData(form)); const payload = { purpose: purpose.value, question: question.value.trim(), mode: purpose.value === 'research' || strictModeHidden() ? 'preset' : mode, watch: purpose.value !== 'research' && watchEnabled.checked === true }
      if (financialEntry) {
        if (purpose.value !== 'research') {
          payload.horizonTradingDays = horizonTradingDays
          const market = prior.tradingHorizon?.market ?? prior.market
          if (['CN', 'HK', 'US'].includes(market) && question.value.trim() === String(prior.question ?? '').trim()) payload.market = market
        }
      } else payload.horizonHours = horizonHours
      if (purpose.value !== 'research' && payload.mode === 'strict') payload.strict = Object.fromEntries(['timezone', 'resolutionRule', 'resolutionSourceUrl', 'targetAt'].filter((k) => data[k]?.trim()).map((k) => [k, k === 'targetAt' ? new Date(data[k]).toISOString() : data[k]]))
      const created = await guardCourseSubmission(checkCurrentService, () => {
        if (!form.isConnected) throw new Error('页面已切换，本次没有创建跟踪。')
        return api('/course/requests', write('POST', payload))
      }); saveRequest(ctx, created)
      const id = requestId(created); if (!id) throw new Error('服务端没有返回跟踪编号，请重新读取公告栏确认。')
      toast('跟踪已创建，系统开始整理问题和调查。')
      if (form.isConnected) { ctx.courseFreshRequests.add(id); goto('/course/' + id) }
    } catch (error) {
      if (error.capability || isMissingCourseApi(error)) {
        if (!error.capability?.tradingDayHorizonsRequired) ctx.setCourseCapability(error.capability ?? unavailableCourseCapability('restart-required'))
        renderCapability(); capabilityNotice.scrollIntoView({ block: 'nearest' })
      } else formError(form, error)
    } finally { submitting = false; renderCapability() }
  })
  const roomShell = document.body.dataset.roomShell === 'true'
  const panel = h('section', (financialEntry ? 'cc-entry cc-financial-entry' : 'cc-entry') + (roomShell ? ' cc-entry-popup' : ''), h('div', 'cc-entry-paper', form))
  if (!roomShell) {
    const image = h('img'); image.src = '/assets/lab-play.png'; image.alt = '等待新委托的像素研究室'
    panel.append(h('div', 'cc-entry-art', image))
  }
  if (roomShell) return standalone ? [panel] : panel
  return standalone ? [header('开始一次事件跟踪', '只需一句问题，系统整理题意、找来源并分工调查。'), panel, link('高级：手工材料研读', '#/advanced', 'wb-side-link')] : panel
}

export function courseBoard(ctx) {
  const cards = h('div', 'wb-board-grid')
  const requests = [...(ctx.cache.courseRequests ?? [])].reverse()
  for (const record of requests) {
    const normalized = record.normalized ?? record.prediction ?? {}
    const p = record.forecast?.probabilityYes
    const questionLink = dataLink(record.question?.trim() || normalized.question || '准备中的题目', '#/course/' + requestId(record))
    questionLink.title = normalized.question ?? questionLink.textContent
    if (record.purpose === 'research') {
      cards.append(h('article', 'wb-paper wb-board-card', h('span', 'wb-badge', requestStateLabel(record)), h('h3', '', questionLink), h('p', '', record.researchReport ? '财报核验研报已保存' : '财报资料调查中'), h('p', 'wb-muted', '核验已披露事实与管理层表述'), link('打开研报研究室', '#/course/' + requestId(record), 'wb-button')))
      continue
    }
    cards.append(h('article', 'wb-paper wb-board-card', h('div', 'wb-card-top', h('span', 'wb-badge', requestStateLabel(record)), h('span', '', modelText(record, ctx) + ' / ' + sourceText(record))), h('h3', '', questionLink), h('div', 'wb-card-probability', formatCourseProbability(p), h('small', '', Number.isFinite(p) ? 'Yes 发生概率' : '暂未发布判断')), h('p', '', '固定到期：' + fmt(normalized.targetAt ?? record.targetAt)), link('打开研究室', '#/course/' + requestId(record), 'wb-button')))
  }
  const financialEntry = document.body.dataset.financialEntry === 'true'
  const heading = header(financialEntry ? '写下一个你关注的股票证券基金' : '我的事件研究', '主 Agent 按题选择研究员，查来源、讨论并生成预测结果')
  const headingId = financialEntry ? 'cc-financial-question-title' : undefined
  if (headingId) heading.querySelector('h1').id = headingId
  return [heading, courseStartForm(ctx, { headingId }), requests.length ? h('section', '', h('h2', 'wb-section-title', '正在关注与历史任务'), cards) : empty('第一张委托纸签还在等你', '直接说你关心的事，不需要先建主题、选角色或准备材料。'), link('高级：材料研读与旧案例管理', '#/advanced', 'wb-side-link')]
}

function publicContract(data) {
  const p = data.prediction ?? data.normalized ?? {}
  return { ...p, predictionId: data.predictionId ?? p.predictionId, version: p.version ?? data.predictionVersion, question: p.question ?? data.question, targetAt: p.targetAt ?? data.targetAt }
}
function renderInterpretation(data) {
  const p = publicContract(data)
  if (!p.interpretation && !p.defaultAssumptions?.length && !p.currentReference) return null
  const block = h('div', 'cc-interpretation', h('h3', '', '按这个意思研究'), p.interpretation ? dataContent('p', '', p.interpretation) : null)
  const detail = h('details', 'cc-interpretation-details', h('summary', '', '查看默认假设与近期参照'))
  if (p.defaultAssumptions?.length) {
    const assumptions = h('ul')
    for (const assumption of p.defaultAssumptions) assumptions.append(dataContent('li', '', assumption))
    detail.append(assumptions)
  }
  const reference = data.forecast?.currentReference ?? p.currentReference
  if (reference) {
    const value = Number.isFinite(reference.value) ? String(reference.value) + (reference.unit ? ' ' + reference.unit : '') : reference.kind === 'directional' ? '方向参照，未提供可核验数值' : '尚无可核验数值'
    detail.append(h('p', 'cc-reference', h('strong', '', reference.verified === true ? '已核对的近期参照：' : '未核实的研究参照：'), dataContent('span', '', value), reference.observedAt ? ' · 观测于 ' + fmt(reference.observedAt, p.timezone) : '', reference.url ? sourceLink(reference) : null))
  }
  const time = p.timeContext
  if (time?.nowLocalLabel || time?.targetAtLocalLabel) detail.append(h('small', '', [time.nowLocalLabel ? '研究起点 ' + time.nowLocalLabel : '', time.targetAtLocalLabel ? '固定到期 ' + time.targetAtLocalLabel : ''].filter(Boolean).join('；')))
  if (p.defaultAssumptions?.length || reference || time) block.append(detail)
  block.append(h('small', '', '口径与你的意思不符？用下方“修改理解后重新跟踪”创建纠正后的题目。'))
  return block
}
function renderAdequacy(data) {
  const forecast = data.forecast; const p = publicContract(data)
  const basis = forecast?.researchBasis ?? p.researchBasis
  const limitations = forecast?.sourceLimitations ?? p.sourceLimitations ?? []
  const adequacy = forecast?.evidenceAdequacy
  if (!basis && !adequacy && !limitations.length) return null
  const conditional = basis?.mode === 'conditional'
  const level = adequacy === 'adequate' ? '可用资料较充分' : adequacy === 'limited' ? '可用资料有限' : '尚未标注充分度'
  const kind = conditional ? '条件估计' : basis?.mode === 'alternative-public' ? '公开替代来源估计' : basis?.mode === 'verified-source' ? '可核验来源估计' : forecast ? '本轮概率估计' : '研究准备中'
  const block = h('div', 'cc-adequacy', h('div', 'cc-adequacy-heading', h('strong', '', kind), h('span', '', '资料充分度：' + level)), basis?.summary ? dataContent('p', '', basis.summary) : null)
  block.dataset.basis = basis?.mode ?? 'unspecified'
  if (conditional) block.append(h('p', '', '概率依赖本题说明中的假设与参照，不能当作已核验事实。'))
  if (limitations.length) { const list = h('ul'); for (const text of limitations) list.append(dataContent('li', '', text)); block.append(list) }
  return block
}
function attachFold(panel) {
  const fold = h('button', 'cc-answer-fold', panel.classList.contains('is-expanded') ? '收起' : '展开全部')
  fold.type = 'button'
  fold.setAttribute('aria-expanded', String(panel.classList.contains('is-expanded')))
  fold.addEventListener('click', () => {
    const expanded = panel.classList.toggle('is-expanded')
    panel.classList.remove('is-short')
    fold.hidden = false
    fold.setAttribute('aria-expanded', String(expanded))
    fold.textContent = expanded ? '收起' : '展开全部'
  })
  panel.append(fold)
  return fold
}
function syncFold(panel) {
  const fold = panel.querySelector('.cc-answer-fold')
  if (!fold) return
  if (panel.classList.contains('is-expanded')) { fold.hidden = false; return }
  if (!panel.style.getPropertyValue('--cc-panel-limit')) { fold.hidden = true; panel.classList.remove('is-short'); return }
  panel.classList.toggle('is-short', panel.scrollHeight <= panel.clientHeight + 8)
  fold.hidden = panel.classList.contains('is-short')
}
function renderAnswer(node, data, ctx) {
  if (data.purpose === 'research') {
    const report = data.researchReport
    node.replaceChildren(h('span', 'wb-tag', '财报与表述核验研报'), dataContent('h2', '', data.question), report?.summary ? dataContent('p', '', report.summary) : h('p', '', '研究员正在查阅原文与核对口径；研报完成后显示发现与限制。'))
    if (report) {
      if (report.assemblyMode === 'harness') node.append(h('strong', 'cc-collab-gap', '研究员资料整理版：程序整理已有报告；主Agent最终裁决未完成。'))
      node.append(h('p', 'wb-muted', '封存于 ' + fmt(report.publishedAt, data.timezone) + ' · ' + (report.modelMode === 'live' && report.sourceMode === 'live' ? '真实模型与公开来源' : '模拟／回放资料')))
      for (const finding of report.findings) node.append(dataContent('p', '', finding.claim), h('div', 'cc-collab-refs', ...finding.evidenceIds.map((id) => {
        const source = (data.evidence || []).find((item) => item.evidenceId === id)
        return source ? h('span', '', dataContent('span', '', source.title), ' ', sourceLink(source)) : null
      })))
      if (report.limitations.length) node.append(h('h3', '', '限制与待核验'), h('ul', '', ...report.limitations.map((text) => dataContent('li', '', text))))
    }
    return
  }
  const p = publicContract(data); const forecast = data.forecast
  const recoveredNotice = forecast?.publicationMode === 'revalidated-recorded-model-candidate' ? h('p', 'cc-collab-gap', '此条原模型候选经维护重验后封存；没有更改概率或回填时间。原失败记录保留，不计为完整自动流程成功。') : null
  const progress = courseRequestProgress(data)
  const emptyReason = courseRequestFailure(data) ? '本轮未能发布判断，原问题已保存。可在错误提示处重试。' : progress.message || (progress.active ? progress.label + '；尚未发布新的概率。' : '系统会在取得并核对足够依据后提交判断。')
  const probability = forecast?.probabilityYes
  const valid = Number.isFinite(probability) && probability >= 0 && probability <= 1
  const tendency = !valid ? '暂未判断' : probability === .5 ? '两种结果接近' : probability > .5 ? '当前倾向：会发生' : '当前倾向：不会发生'
  const rule = p.resolutionRule ?? p.rule
  const questionHeading = dataContent('h2', '', data.question?.trim() || p.question || '正在把问题整理成可验证的命题…')
  questionHeading.title = p.question ?? questionHeading.textContent
  const factRows = [h('dt', '', '固定到期'), h('dd', '', fmt(p.targetAt, p.timezone)), h('dt', '', '判定规则'), rule ? dataContent('dd', '', rule) : h('dd', '', '正在核对可验证的判定规则'), h('dt', '', '最新发布'), h('dd', '', forecast?.publishedAt ? fmt(forecast.publishedAt, p.timezone) : '尚无发布记录'), h('dt', '', '运行状态'), h('dd', '', statusLabel(data.status)), h('dt', '', '模型模式'), h('dd', '', modelText(data, ctx)), h('dt', '', '来源模式'), h('dd', '', sourceText(data))]
  for (const fact of forecast?.statusFacts ?? []) { if (fact.key === 'target') continue; factRows.push(h('dt', '', fact.label), dataContent('dd', '', fact.text)) }
  const conflict = forecast?.summaryConflict?.detected === true
  const summaryNode = forecast?.summary ? dataContent('p', conflict ? 'cc-answer-summary cc-summary-conflict' : 'cc-answer-summary', forecast.summary) : h('p', 'wb-forecast-explain', emptyReason)
  const probabilityLabels = courseProbabilityPair(probability)
  node.replaceChildren(h('span', 'wb-tag', '系统理解与当前判断'), questionHeading, h('p', 'cc-tendency', tendency), h('div', 'wb-yes-no', h('div', '', h('small', '', '是 Yes'), h('strong', '', probabilityLabels.yes)), h('div', '', h('small', '', '否 No'), h('strong', '', probabilityLabels.no))), h('p', 'wb-probability-empty', valid ? '对这道题的估计概率，不是模型正确率' : '资料不足或尚未发布时，概率保持缺值'), h('dl', 'wb-facts', ...factRows), summaryNode, ...(conflict ? [h('div', 'cc-conflict-warning', h('strong', '', '摘要与结构化事实不一致'), h('p', '', '下方模型摘要包含与上方事实段不一致的表述，请以上方结构化事实为准。'), h('ul', '', ...(forecast.summaryConflict.reasons ?? []).map((reason) => dataContent('li', '', reason))))] : []))
  if (recoveredNotice) node.append(recoveredNotice)
  if (forecast?.reviewRequired) node.append(h('p', 'cc-collab-gap', '需要复核：', dataContent('span', '', (forecast.reviewReasons || []).join('；'))))
  node.querySelectorAll('dd')[3].textContent = requestStateLabel(data)
  const reasoning = courseReasoningLabel(ctx.cache.courseCapability?.config)
  if (reasoning) node.querySelector('.wb-facts').append(h('dt', '', '当前执行配置'), h('dd', '', reasoning))
  node.querySelector('.wb-tag').textContent = '当前概率判断'
  const adequacy = renderAdequacy(data)
  if (adequacy) node.insertBefore(adequacy, node.querySelector('.wb-facts'))
  const interpretation = renderInterpretation(data)
  if (interpretation) node.insertBefore(interpretation, node.querySelector('.wb-facts'))
  if (forecast?.label) node.append(h('p', 'cc-result-label', forecast.label))
  if (data.result) {
    const value = data.result.outcome
    const outcome = value === true || value === 1 ? '发生（Yes）' : value === false || value === 0 ? '未发生（No）' : '待核验'
    node.append(h('div', 'cc-resolution', h('strong', '', '实际结果：' + outcome), dataContent('p', '', data.result.summary ?? '结果记录已保存。'), h('small', '', '实际结果单列保存，不追加为 0% 或 100% 的预测点。')))
  }
  attachFold(node)
  requestAnimationFrame(() => syncFold(node))
}
function renderMemory(node, run, data) {
  const memory = run?.memory
  node.hidden = !memory
  if (!memory) { node.replaceChildren(); return }
  const triage = run.triage ?? {}
  const previous = memory.previousForecast
  const current = run.forecast
  const validPrevious = Number.isFinite(previous?.probabilityYes)
  const validCurrent = Number.isFinite(current?.probabilityYes)
  const change = validPrevious && validCurrent ? Math.round((current.probabilityYes - previous.probabilityYes) * 1000) / 10 : null
  const previousText = validPrevious ? 'Yes ' + formatCourseProbability(previous.probabilityYes) + ' · ' + fmt(previous.issuedAt ?? previous.publishedAt) : '此前尚无已发布判断'
  const newSources = (triage.newEvidenceIds ?? []).map((id) => (data.evidence ?? run.evidence ?? []).find((source) => source.evidenceId === id)).filter(Boolean)
  const newInfo = h('div', 'cc-memory-item', h('h3', '', '这轮新信息'))
  if (newSources.length) for (const source of newSources) newInfo.append(h('p', '', dataContent('span', '', source.title ?? source.evidenceId), ' ', sourceLink(source)))
  else newInfo.append(h('p', '', triage.kind === 'initial' ? '首轮调查，尚无上一轮可比较。' : triage.newEvidenceIds?.length ? '新增资料已记录，当前未提供题名。' : '未记录新增的独立证据。'))
  const why = current?.summary ?? triage.reason
  const adjustment = change === null ? validCurrent ? '这是首次发布' : '本轮尚未发布新概率' : change === 0 ? '当前概率保持不变' : '较上一判断' + (change > 0 ? '上调 ' : '下调 ') + Math.abs(change) + ' 个百分点'
  node.replaceChildren(h('h2', '', '这轮怎样接着上次查'), h('p', 'wb-muted', '对应房间所选轮次。历史摘要用于比较，不算新的外部证据。'), h('div', 'cc-memory-grid', h('div', 'cc-memory-item', h('h3', '', '上一判断'), h('p', '', previousText), previous?.statusLabel ? h('span', 'cc-status-badge', previous.statusLabel) : null, memory.summary ? dataContent('small', '', memory.summary) : null), newInfo, h('div', 'cc-memory-item', h('h3', '', '为什么调整'), h('strong', '', adjustment), why ? dataContent('p', '', why) : h('p', '', '尚无已保存的调整说明。'), triage.reason && why !== triage.reason ? h('small', '', '本轮触发：', dataContent('span', '', triage.reason)) : null)), h('small', 'wb-muted', '实际读取历史：' + (memory.sourceRunIds?.length ?? 0) + ' 轮，' + (memory.reportCount ?? 0) + ' 份报告，' + (memory.relationCount ?? 0) + ' 条资料关系。'))
  const policy = courseMemoryPolicyLines(memory)
  if (policy.length) node.insertBefore(h('div', 'cc-memory-policy', h('strong', '', '本轮记忆范围'), policy.map(line => h('p', '', line))), node.querySelector('.cc-memory-grid'))
}
function renderWatch(node, data) {
  const w = data.watch
  if (!w) { node.replaceChildren(h('p', '', '监听计划将在实际保存后出现。')); return }
  const nextCheck = w.nextCheckAt ?? w.nextDueAt; const lastCheck = w.lastCheckAt ?? w.lastCheckedAt
  const triage = w.lastTriage
  const queries = Array.isArray(w.query) ? w.query : w.query ? [w.query] : []
  node.replaceChildren(h('h3', '', '现在在看什么'), h('p', '', '跟踪状态：' + statusLabel(w.status ?? data.status) + (nextCheck ? ' · 下次检查 ' + fmt(nextCheck) : '') + (lastCheck ? ' · 上次检查 ' + fmt(lastCheck) : '')))
  if (queries.length) node.append(h('p', '', '正在留意：', dataContent('span', '', queries.join('；'))))
  if (w.status === 'paused_provider') node.append(h('small', '', '监听已暂停，不会自动重试。服务恢复后，可使用上方“重试本次调查”手动继续。'))
  if (typeof w.policySummary === 'string' && w.policySummary.trim()) node.append(h('p', 'cc-watch-policy', h('strong', '', '何时召集研究员：'), dataContent('span', '', w.policySummary)))
  if (triage) {
    const kinds = { initial: '首次调查', no_change: '没有新变化，不召集研究员', local: '局部补查', team: '召集团队复核' }
    node.append(...[h('p', '', h('strong', '', '最近分流：' + (kinds[triage.kind] ?? triage.kind)), triage.reason ? dataContent('span', '', '。' + triage.reason) : ''), triage.selectedRoleIds?.length ? h('p', '', '本次请到：' + triage.selectedRoleIds.map((id) => courseRoleName(id)).join('、')) : null, Number.isFinite(triage.duplicateCount) && triage.duplicateCount > 0 ? h('small', '', '已排除 ' + triage.duplicateCount + ' 条重复线索。') : null].filter(Boolean))
  }
  node.append(h('small', '', '只有实际取得新信息并发布判断，曲线才增加一个点。检查安排与本次分流均来自已保存记录。'))
}
function renderSources(node, data) {
  const evidence = data.evidence ?? []; const relations = data.relations ?? []
  node.replaceChildren(h('h2', '', '来源与关系'), h('p', 'wb-muted', '支持与反证保留具体出处；新闻、判断与实际结果分别处理。'))
  if (!evidence.length) node.append(empty('尚未取得可显示的来源', '只有实际读取并保存的材料会出现在这里。'))
  for (const source of evidence) {
    const detail = h('details', 'cc-source', dataContent('summary', '', source.title ?? source.evidenceId ?? '资料来源'), dataContent('p', 'wb-prewrap', source.summary ?? source.text ?? source.snippet ?? '正文快照已保存，摘要未提供。'), h('div', 'wb-evidence-meta', sourceLink(source), source.publishedAt ? h('span', '', '原发布 ' + fmt(source.publishedAt)) : null, h('span', '', '取得 ' + fmt(source.firstSeenAt ?? source.retrievedAt ?? source.obtainedAt))))
    node.append(detail)
    if (source.language) detail.append(h('small', 'wb-muted', source.language === 'zh' ? '正文语言提示：中文' : source.language === 'en' ? '正文语言提示：外文' : '正文语言待核验'))
    if (source.readObservations?.length > 1) detail.append(h('p', 'wb-muted', '同一正文的实际读取时刻：' + [...new Set(source.readObservations.map(item => fmt(item.obtainedAt)))].join('；') + '。正文内容不变时仍保留各次读取记录。'))
  }
  const edges = h('div', 'cc-relations')
  for (const relation of relations) {
    const kind = relation.kind ?? relation.type ?? relation.relation
    const id = relation.evidenceId ?? relation.fromEvidenceId ?? relation.sourceId
    const source = evidence.find((e) => e.evidenceId === id)
    edges.append(h('div', 'cc-relation', dataContent('span', '', source?.title ?? id ?? '已记录的材料关系'), h('strong', kind === 'contradicts' ? 'cc-against' : '', kind === 'supports' ? '支持' : kind === 'contradicts' ? '反对' : kind === 'updates' ? '更新' : '关联'), dataContent('span', '', relation.claim ?? relation.statement ?? relation.summary ?? relation.to ?? '当前预测题')))
  }
  if (relations.length) node.append(h('h3', 'wb-section-title', '本题关键关系'), edges)
  attachFold(node)
  requestAnimationFrame(() => syncFold(node))
}

function runRecords(run) {
  const events = run?.events ?? []
  const names = { 'team.selected': '按题选择研究员', 'memory.loaded': '读取历史摘要', 'watch.triaged': '判断本轮调查范围', 'assignment.started': '真实派工', 'assignment.completed': '提交报告', 'tool.started': '执行工具', 'tool.completed': '工具返回', 'tool.failed': '工具失败', 'meeting.started': '核对分歧', 'meeting.message': '公开通信', 'communication.sent': '公开通信', 'forecast.published': '发布判断', 'run.finished': '本轮结束' }
  const rows = events.filter((event) => names[event.type])
  const details = h('details', 'cc-records-details', h('summary', '', '公开协作记录（' + rows.length + ' 条）'))
  details.open = run?.runId ? recordsOpenByRun.get(run.runId) === true : false
  details.addEventListener('toggle', () => { if (run?.runId) recordsOpenByRun.set(run.runId, details.open) })
  const body = h('div', 'cc-records-body')
  if (run?.summary) body.append(h('p', 'wb-muted wb-prewrap', '所选轮次 · ' + statusLabel(run.status) + '：' + run.summary))
  const team = courseTeam(run)
  for (const event of rows) {
    const p = event.payload ?? {}; const summary = p.summary ?? p.message ?? p.report?.summary ?? p.reason ?? p.memory?.summary ?? p.triage?.reason
    const roleId = normalizeCourseRole(p.roleId ?? p.agentSpecId)
    const role = team.find((member) => member.roleId === roleId)
    const members = event.type === 'team.selected' ? (p.team ?? []).map((member) => dataContent('p', '', courseRoleName(member.roleId, member.name) + '：' + (member.reason ?? member.objective ?? '已入选本轮调查'))) : []
    body.append(h('details', 'wb-execution-row', h('summary', '', names[event.type], ...(roleId ? [' · ', dataContent('span', '', courseRoleName(roleId, role?.name))] : []), ...(p.toolId ? [' · ', dataContent('span', '', p.toolId)] : [])), summary ? dataContent('p', 'wb-prewrap', summary) : h('p', 'wb-muted', '该动作已记录。'), members, p.evidenceIds?.length ? h('small', '', '引用：' + p.evidenceIds.join('、')) : null))
  }
  if (!events.length) body.append(h('p', 'wb-muted', '尚无执行事件。只展示公开计划、工具、来源与判断摘要。'))
  details.append(body)
  return h('section', 'wb-paper cc-records', details)
}

function renderWorkflow(node, run, purpose) {
  const view = courseWorkflowView(run)
  const stage = h('p', 'cc-workflow-stage', view.status); stage.setAttribute('role', 'status')
  const head = h('div', 'cc-workflow-heading', h('h2', '', '这一轮怎样协作'), h('span', '', view.versionLabel))
  const loop = view.version === 3 ? h('p', 'cc-workflow-loop', [
    view.cycle ? `第 ${view.cycle} 个调查周期${view.maxCycles ? ` / 最多 ${view.maxCycles} 个` : ''}` : '',
    view.maxFollowUps !== null && view.maxFollowUps !== false ? `争议补查 ${view.followUpsUsed ?? '—'} / ${view.maxFollowUps} 次` : '',
  ].filter(Boolean).join(' · ')) : null
  const total = h('p', 'cc-workflow-budget', h('strong', '', '整轮已用：'),
    '模型 ' + courseUsageText(view.usage.modelRequests, view.budget.maxModelRequests, ' 次') + ' · 工具 ' + courseUsageText(view.usage.toolCalls, view.budget.maxToolCalls, ' 次') + ' · token ' + courseUsageText(view.usage.totalTokens, view.budget.maxTotalTokens, '', { unlimited: view.budget.unlimitedTotalTokens }),
    view.usage.unknownUsage ? h('small', '', '部分用量未返回，数字不是完整账单。') : null)
  const draft = purpose !== 'research' && !run.predictionId && run.draft?.status === 'draft' ? h('div', 'cc-workflow-draft', h('strong', '', '待核定草稿'),
    dataContent('p', '', run.draft.interpretation || run.draft.question || ''), run.draft.targetAt ? h('small', '', '观察至 ' + fmt(run.draft.targetAt, run.draft.timezone) + '；来源与正式规则由子 Agent 取证后再核定。') : null) : null
  const workers = h('div', 'cc-workflow-workers')
  for (const row of view.rows) {
    const item = h('div', 'cc-workflow-worker', dataContent('strong', '', row.name), h('span', '', row.activityText), h('small', '',
      (row.cycle ? `周期 ${row.cycle} · ` : '') + '模型 ' + courseUsageText(row.usage.modelRequests, row.budget.maxModelRequests, ' 次') + ' · 工具 ' + courseUsageText(row.usage.toolCalls, row.budget.maxToolCalls, ' 次')))
    item.dataset.state = row.waiting ? 'waiting' : row.status ?? 'pending'; workers.append(item)
  }
  if (!view.rows.length) workers.append(h('p', 'wb-muted', '尚无真实研究员派工记录；名单会在主 Agent 完成分配后出现。'))
  const method = view.version === 3 && view.investigationSteps && view.reportStep ? Number.isSafeInteger(view.reportRepairRequests) ? `每位研究员最多 ${view.investigationSteps} 次调查决策；资料足够可提前提交报告，最迟第 ${view.reportStep} 次进入报告阶段，另留 ${view.reportRepairRequests} 次报告修正。调查与报告分开计数，仍受本席总调用与 token 上限约束。` : `每位研究员最多 ${view.investigationSteps} 次调查决策，第 ${view.reportStep} 次只提交报告；资料足够可提前提交。模型次数与调查周期分开计数。` : '仅展示本轮保存的执行记录；历史流程和预算不会套用当前配置。'
  node.replaceChildren(...[head, stage, h('p', 'cc-workflow-flow', purpose === 'research' ? '整理问题 → 独立取证 → 必要补查 → 引用研报；核验已披露事实与表述。' : view.flow), loop, draft, total, workers, h('small', 'cc-workflow-method', method)].filter(child => child !== null && child !== undefined))
  node.dataset.protocol = String(view.version ?? 'unknown')
}

export async function mountCourseRequest(ctx, id, token) {
  let disposed = false; let timer; let selectedRunId = null; let currentData; let courseState = createCourseProjection({ requestId: id })
  let selectionPinned = false
  let fresh = ctx.courseFreshRequests.has(id); ctx.courseFreshRequests.delete(id)
  let selectNext = false; let previousLatest = null
  let answerSig; let sourceSig; let curveSig; let recordSig; let watchSig; let memorySig; let failureSig; let workflowSig; let refreshSequence = 0; let actionBusy = false; let stopBusy = false
  const roomHost = ctx.roomHost || null
  const roomNode = h('div', 'wb-room cc-room')
  let inspector = null
  const answer = h('aside', 'wb-forecast-note cc-answer')
  const plan = h('div', 'cc-request-state', '正在读取题目与调查进度…'); plan.setAttribute('role', 'status')
  const errorBox = h('div', 'wb-error'); errorBox.hidden = true; errorBox.setAttribute('role', 'alert')
  const title = header('事件跟踪研究室', '系统负责寻找来源与分工；人物只响应已保存的真实执行事件。')
  const curve = h('div', 'cc-curve-slot'); const sources = h('section', 'wb-paper cc-sources'); const records = h('div')
  function syncPanelLimits() {
    if (disposed) return
    requestAnimationFrame(() => {
      if (disposed) return
      const roomHeight = roomNode.getBoundingClientRect().height
      if (roomHeight > 0) answer.style.setProperty('--cc-panel-limit', Math.round(roomHeight) + 'px')
      const curveHeight = curve.getBoundingClientRect().height
      if (curveHeight > 0) sources.style.setProperty('--cc-panel-limit', Math.round(curveHeight) + 'px')
      requestAnimationFrame(() => { if (!disposed) { syncFold(answer); syncFold(sources) } })
    })
  }
  const panelObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(syncPanelLimits) : null
  panelObserver?.observe(roomNode)
  panelObserver?.observe(curve)
  window.addEventListener('resize', syncPanelLimits)
  const runSelector = document.createElement('select'); runSelector.setAttribute('aria-label', '选择房间显示的研判轮次')
  const notice = h('div', 'cc-round-notice'); notice.hidden = true
  const originText = h('p'); const roomContext = h('small')
  const answerProcess = button('查看预测协作过程', () => chooseRun(courseAnswerProvenance(currentData).forecastRunId), 'wb-button')
  const latestCheck = button('查看最近监听检查', () => chooseRun(courseAnswerProvenance(currentData).latestCheckRunId), 'wb-text-button')
  const origin = h('section', 'cc-answer-origin', originText, roomContext, h('div', 'wb-actions', answerProcess, latestCheck))
  const workflow = h('section', 'cc-workflow'); workflow.hidden = true
  const watch = h('div', 'cc-watch', '检查安排将在准备完成后显示。')
  const memory = h('section', 'wb-paper cc-memory'); memory.hidden = true
  const collaboration = h('section', 'wb-paper cc-collaboration'); collaboration.hidden = true
  const resolution = h('section', 'wb-paper cc-resolution'); resolution.hidden = true
  let resolving = false
  function renderResolution(data) {
    resolution.hidden = !data.resolutionPolicy
    if (resolution.hidden) return
    const result = data.result, target = Date.parse(data.normalized?.targetAt || data.resolutionPolicy.targetAt), at = Date.now()
    resolution.replaceChildren(h('h2', '', '到期结果核验'), dataContent('p', '', data.strict?.resolutionRule || ''), h('p', '', '目标时点：' + fmt(data.normalized?.targetAt || data.resolutionPolicy.targetAt)))
    if (result) {
      resolution.append(dataContent('strong', '', result.summary), h('p', '', '实际取得：' + fmt(result.observedAt)), ...result.evidence.map(source => h('details', '', dataContent('summary', '', source.title), dataContent('pre', 'wb-prewrap', source.text), sourceLink(source))))
      for (const score of result.scores || []) resolution.append(h('p', '', `Yes预测 ${formatCourseProbability(score.probabilityYes)} · Brier ${score.brier.toFixed(4)} · ${score.label}`))
      return
    }
    const resolve = button(resolving ? '正在读取官方快照…' : '读取官方结果并核验', async () => {
      if (resolving) return
      resolving = true; resolve.disabled = true
      try { await api('/course/requests/' + id + '/resolve', write('POST', {})); toast('结果及单题评分已保存，原预测没有改写。'); await refresh() }
      catch (error) { if (!disposed) resolution.append(h('p', 'wb-error', error.message)) }
      finally { resolving = false; if (!disposed) resolve.disabled = false }
    }, 'wb-button')
    resolve.disabled = resolving || !data.forecast || at < target || at > target + 300000 || data.status === 'stopped'
    resolution.append(h('p', '', at < target ? '尚未到期；当前警告不能代替未来结果。' : at > target + 300000 ? '未在5分钟观察窗口取得快照，保持不可核验。' : '此操作读取固定官方JSON，不调用模型或消耗模型tokens。'), resolve)
  }
  const check = button('检查一次新资料', async () => {
    if (actionBusy) return
    const action = courseRequestAction(currentData ?? {})
    if (!action.enabled) return
    actionBusy = true; syncRunAction()
    try {
      const record = await api(['resume-summary', 'assemble-report'].includes(action.kind) ? '/course/runs/' + (currentData.latestRun?.runId || currentData.run?.runId) + '/' + action.kind : '/course/requests/' + id + '/check', write('POST', {}))
      if (!disposed) {
        selectionPinned = true
        if (record.runId) { selectedRunId = record.runId; fresh = true; recordSig = null; history.replaceState(null, '', '#/course/' + id + '?runId=' + encodeURIComponent(selectedRunId)) }
        else { saveRequest(ctx, record); previousLatest = requestRunId(currentData ?? {}); selectNext = true }
        toast(action.kind === 'assemble-report' ? '研究员资料整理版已保存，主Agent裁决未完成。' : action.kind === 'resume-summary' ? '已请求汇总已有报告，研究员取证不重跑。' : action.kind === 'retry' ? '已在原问题下重新开始调查，原期限和历史记录保留。' : '已请求真实检查；没有新信息时不会新增概率点。'); await refresh()
      }
    } catch (error) { if (!disposed) showError(error) } finally { actionBusy = false; syncRunAction() }
  })
  const retry = button('重试本次调查', () => check.click(), 'wb-button wb-primary')
  check.disabled = true; retry.disabled = true
  function syncRunAction() {
    const action = courseRequestAction(currentData ?? {})
    check.textContent = actionBusy ? '正在开始调查…' : action.label
    check.disabled = actionBusy || !action.enabled; retry.disabled = check.disabled
    check.hidden = action.kind === 'retry' && Boolean(courseRequestFailure(currentData ?? {}))
    retry.hidden = action.kind !== 'retry'
    check.title = action.reason; retry.title = action.reason
    stop.disabled = !courseRequestCanStop(currentData ?? {}, { busy: actionBusy || stopBusy })
  }
  const stop = button('停止跟踪', async () => {
    if (!courseRequestCanStop(currentData ?? {}, { busy: actionBusy || stopBusy })) return
    stopBusy = true; syncRunAction()
    try { const record = await api('/course/requests/' + id + '/stop', write('POST', {})); saveRequest(ctx, record); if (!disposed) { currentData = record; toast('停止请求已保存。'); await refresh() } } catch (error) { if (!disposed) showError(error) } finally { stopBusy = false; syncRunAction() }
  }, 'wb-text-button')
  stop.disabled = true
  const edit = button('修改理解后重新跟踪', () => { ctx.courseRetryInput = { purpose: currentData?.purpose || 'forecast', question: currentData?.question ?? publicContract(currentData ?? {}).question, horizonHours: currentData?.horizonHours ?? 48, horizonTradingDays: currentData?.horizonTradingDays, market: currentData?.tradingHorizon?.market ?? currentData?.market, mode: currentData?.mode ?? 'preset', strict: currentData?.strict, watch: courseWatchEnabled(currentData ?? {}) }; goto('/course/new') }, 'wb-text-button')
  const actions = h('div', 'cc-course-actions', h('label', '', '房间显示轮次 ', runSelector), check, stop, edit)
  if (roomHost) {
    roomHost.append(roomNode)
    inspector = h('details', 'cc-room-inspector', h('summary', '', '预测结果与进度'), h('div', 'cc-room-inspector-body', title, plan, errorBox, origin, workflow, answer, actions, notice, collaboration, resolution, watch, memory, h('div', 'cc-results-grid', curve, sources), records))
    inspector.addEventListener('toggle', syncPanelLimits)
    ctx.content.replaceChildren(inspector)
  } else {
    ctx.content.replaceChildren(title, plan, errorBox, origin, workflow, h('div', 'wb-research-layout cc-course-layout', roomNode, answer), actions, notice, collaboration, resolution, watch, memory, h('div', 'cc-results-grid', curve, sources), records)
  }
  syncPanelLimits()
  const room = createCourseRoom(roomNode); ctx.room = room
  const selectedFromUrl = new URLSearchParams(location.hash.split('?')[1] ?? '').get('runId')
  if (selectedFromUrl) { selectedRunId = selectedFromUrl; selectionPinned = true; fresh = false }
  function chooseRun(runId) {
    if (!runId) return
    selectedRunId = runId; selectionPinned = true; selectNext = false; fresh = false; recordSig = null; memory.hidden = true
    history.replaceState(null, '', '#/course/' + id + '?runId=' + encodeURIComponent(selectedRunId)); void refresh()
  }
  ctx.selectCourseRun = chooseRun
  runSelector.addEventListener('change', () => chooseRun(runSelector.value))
  function showError(error) { failureSig = null; errorBox.hidden = false; errorBox.replaceChildren(h('span', '', error.message), button('重试读取', refresh, 'wb-text-button')) }
  async function refresh() {
    if (disposed || !ctx.isCurrent(token)) return
    const sequence = ++refreshSequence
    try {
      const data = await api('/course/requests/' + encodeURIComponent(id))
      if (disposed || !ctx.isCurrent(token) || sequence !== refreshSequence) return
      ctx.onDataConnected?.()
      currentData = data; saveRequest(ctx, data)
      renderResolution(data)
      title.querySelector('h1').textContent = data.purpose === 'research' ? '财报核验研究室' : '事件跟踪研究室'
      const p = publicContract(data); const latestId = requestRunId(data)
      const progress = courseRequestProgress(data)
      const failure = courseRequestFailure(data)
      plan.dataset.state = failure ? 'error' : progress.active ? 'active' : 'idle'
      plan.textContent = progress.label + (!failure && progress.message ? ' · ' + progress.message : '')
      errorBox.hidden = !failure
      if (failure && failureSig !== JSON.stringify(failure)) {
        errorBox.classList.add('cc-run-error')
        errorBox.replaceChildren(h('strong', '', failure.title), h('p', '', failure.detail), h('p', '', failure.nextStep), failure.waitHint ? h('small', '', failure.waitHint) : h('small', '', '本次未安排自动重试；原问题、固定期限和已有判断保留。'), retry)
      }
      failureSig = failure ? JSON.stringify(failure) : null
      const aSig = JSON.stringify([p, data.forecast, data.researchReport, progress, data.result, ctx.cache.courseCapability?.config?.reasoningSettings])
      if (answerSig !== aSig) { renderAnswer(answer, data, ctx); answerSig = aSig }
      const cSig = JSON.stringify([data.forecasts, p.predictionId, p.version, p.targetAt])
      if (curveSig !== cSig) { curve.hidden = data.purpose === 'research'; if (!curve.hidden) curve.replaceChildren(courseChart(data.forecasts ?? [], p)); curveSig = cSig }
      const sSig = JSON.stringify([data.evidence, data.relations])
      if (sourceSig !== sSig) { renderSources(sources, data); sourceSig = sSig }
      const wSig = JSON.stringify([data.watch, data.status])
      if (watchSig !== wSig) { renderWatch(watch, data); watchSig = wSig }
      watch.hidden = data.purpose === 'research'
      syncRunAction()
      const uniqueRuns = courseRuns(data)
      const defaultRunId = selectCourseRoomRun(data, { selectedRunId, pinned: selectionPinned })
      if (defaultRunId !== selectedRunId) { if (selectedRunId) fresh = false; selectedRunId = defaultRunId; recordSig = null; memory.hidden = true }
      if (selectNext && latestId && latestId !== previousLatest) { selectedRunId = latestId; fresh = true; selectNext = false }
      const optionsSig = uniqueRuns.map((r, index) => r.runId + ':' + courseRunLabel(r, index)).join('|')
      if (runSelector.dataset.signature !== optionsSig) {
        runSelector.replaceChildren(...uniqueRuns.map((r, i) => { const option = h('option', '', courseRunLabel(r, i)); option.value = r.runId; return option })); runSelector.dataset.signature = optionsSig
      }
      if (selectedRunId && ![...runSelector.options].some((o) => o.value === selectedRunId)) { const option = h('option', '', '已选历史轮次'); option.value = selectedRunId; runSelector.append(option) }
      runSelector.value = selectedRunId ?? ''
      const provenance = courseAnswerProvenance(data)
      originText.textContent = data.purpose === 'research' ? '财报研报与引用来自已保存的研究员报告；下方显示所选轮次的协作记录。' : provenance.summary
      const selectedIndex = uniqueRuns.findIndex((run) => run.runId === selectedRunId)
      roomContext.textContent = selectedIndex >= 0 ? '房间当前显示：' + courseRunLabel(uniqueRuns[selectedIndex], selectedIndex) + (provenance.forecastRunId && selectedRunId !== provenance.forecastRunId ? '，与当前答案的来源轮次不同。' : provenance.forecastRunId ? '，对应当前答案的协作过程。' : '。') : '正在读取所选轮次。'
      answerProcess.hidden = !provenance.forecastRunId; answerProcess.disabled = selectedRunId === provenance.forecastRunId
      latestCheck.hidden = !provenance.latestCheckRunId; latestCheck.disabled = selectedRunId === provenance.latestCheckRunId
      notice.hidden = !latestId || latestId === selectedRunId || latestId === provenance.latestCheckRunId
      if (!notice.hidden) notice.replaceChildren(h('span', '', '另有新一轮进展，房间保持当前选择。'), button('查看最新轮次', () => chooseRun(latestId), 'wb-text-button'))
      if (selectedRunId) {
        const included = uniqueRuns.find((r) => r.runId === selectedRunId)
        const run = included && Array.isArray(included.events) && included.assignments ? included : await api('/course/runs/' + encodeURIComponent(selectedRunId))
        if (disposed || !ctx.isCurrent(token) || sequence !== refreshSequence || run.runId !== selectedRunId) return
        if (!courseRunBelongsToRequest({ requestId: id, predictionId: data.predictionId }, run)) throw new Error('这轮调查不属于当前问题，房间不会显示其他任务的发言。请在轮次列表中选择本题运行。')
        const fSig = JSON.stringify([run.runId, run.harnessVersion, run.orchestration, run.phase, run.status, run.usage, run.budget, run.assignments, run.events?.at(-1)?.eventId])
        if (workflowSig !== fSig) { renderWorkflow(workflow, run, data.purpose); renderCollaboration(collaboration, run.collaboration); workflow.hidden = false; workflowSig = fSig }
        const projected = projectCourseSnapshot(courseState, run, { fresh }); courseState = projected.state; fresh = false
        for (const effect of projected.effects) room.apply(effect)
        const mSig = JSON.stringify([run.runId, run.memory, run.triage, run.forecast, data.evidence?.map((source) => [source.evidenceId, source.title])])
        if (memorySig !== mSig) { renderMemory(memory, run, data); memorySig = mSig }
        const rSig = JSON.stringify([run.runId, run.status, run.events?.length, run.events?.at(-1)?.eventId])
        if (recordSig !== rSig) { records.replaceChildren(runRecords(run)); recordSig = rSig }
      }
      syncPanelLimits()
    } catch (error) { if (!disposed && ctx.isCurrent(token)) { const connection = document.getElementById('wb-connection'); connection.textContent = '读取中断，重试中'; connection.dataset.state = 'reconnecting'; showError(error) } }
  }
  let busy = false
  async function poll() { if (busy || disposed) return; busy = true; await refresh(); busy = false; if (!disposed && ctx.isCurrent(token)) timer = setTimeout(poll, 1500) }
  ctx.courseCleanup = () => {
    disposed = true; clearTimeout(timer); panelObserver?.disconnect(); window.removeEventListener('resize', syncPanelLimits)
    inspector?.removeEventListener('toggle', syncPanelLimits)
    room.destroy()
    if (roomHost && roomNode.parentElement === roomHost) roomNode.remove()
    if (ctx.selectCourseRun === chooseRun) ctx.selectCourseRun = null
  }
  await poll()
}
