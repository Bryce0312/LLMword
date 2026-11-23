import { isWorkspaceBuiltinText } from './locale-zh-en-workspace.mjs'
import { h, uiContent, dateContent, dataContent, dataLink, link, button, header, empty, select, badge, evidenceCard, api, write, toast, goto, route, labels } from './workbench-core.js'
import { materialForm, agentForm } from './workbench-forms.js'
import { researchSettingsPanel } from './research-settings.js'
import { createAgentDeletionAction, agentDeletionError } from './agent-deletion.mjs'
import { confirmationDialog } from './confirmation-dialog.js'
import { formatCourseProbability } from './course-probability.mjs'
import { directionLabel, directionText, isPriceDirection } from './course-price-direction.mjs'
import { courseAnswerOutlook } from './course-runs.mjs'
import { historyRecordDeleteVisible, historyRecordCanDelete, createHistoryDeletionAction, applyHistoryDeletion, historyDeletionError } from './history-deletion.mjs'

function courseSlipState(record) {
  if (record.researchReport && record.status === 'completed') return '研报已保存'
  const retained = record.forecast ? '·保留判断' : ''
  if (record.status === 'stopped') return '已停止' + retained
  const status = record.latestRun?.status ?? record.run?.status ?? record.status
  if (status === 'failed') return '调查失败' + retained
  if (status === 'insufficient') return '资料不足' + retained
  if (status === 'cancelled') return '已取消' + retained
  if (status === 'queued') return '排队中'
  if (['running', 'researching'].includes(status)) return '调查中' + retained
  if (record.forecast) return '已有判断'
  return ({ preparing: '准备中', normalizing: '整理问题', completed: '本轮结束', waiting: '等待资料', closed: '已到期', needs_clarification: '需要修改' })[status] ?? '等待状态'
}

export function sidebar(ctx) {
  const { cache, projection, filterTopic } = ctx
  const roomShell = document.body.dataset.roomShell === 'true'
  const currentRoute = route()
  const current = roomShell && ctx.activePredictionId ? ctx.activePredictionId : currentRoute.parts[0] === 'predictions' ? currentRoute.parts[1] : null
  const currentRequest = roomShell && ctx.activeCourseRequestId ? ctx.activeCourseRequestId : currentRoute.parts[0] === 'course' ? currentRoute.parts[1] : null
  let chooser
  if (!roomShell) {
    chooser = select([['', '历史记录'], ...cache.topics.map((t) => [t.topicId, t.title])], filterTopic)
    chooser.setAttribute('aria-label', '按主题筛选任务'); chooser.value = filterTopic
    chooser.addEventListener('change', () => ctx.onFilter(chooser.value))
  }
  const list = h('div', 'wb-task-list')
  const courseRecords = (cache.courseRequests ?? []).filter(record => !record.deleted && !record.deletedAt && !cache.deletedCourseRequestIds?.has(record.requestId ?? record.id) && typeof (record.requestId ?? record.id) === 'string' && (record.requestId ?? record.id))
  const pendingDeletions = cache.historyDeletionPending ??= new Set()
  const coursePredictionIds = new Set(courseRecords.map((r) => r.predictionId).filter(Boolean))
  for (const record of [...courseRecords].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))) {
    const id = record.requestId ?? record.id; const normalized = record.normalized ?? record.prediction ?? {}
    if (typeof id !== 'string' || !id) continue
    const target = '#/course/' + encodeURIComponent(id) + (roomShell ? '?results=1' : '')
    const card = roomShell ? h('article', 'wb-task-slip' + (currentRequest === id ? ' is-selected' : '')) : link('', target, 'wb-task-slip' + (currentRequest === id ? ' is-selected' : ''))
    const recordLink = roomShell ? link('', target, 'wb-history-record-link') : card
    card.dataset.requestId = id
    if (currentRequest === id) { card.setAttribute('aria-current', 'page'); recordLink.setAttribute('aria-current', 'page') }
    const question = dataContent('strong', '', record.question?.trim() || normalized.question || '正在整理题目')
    question.title = normalized.question ?? question.textContent
    const outlook = courseAnswerOutlook(record)?.directionOutlook
    const forecast = record.forecast
    const result = outlook ? '暂定走势：' + directionLabel(outlook.direction) : isPriceDirection(forecast) ? directionText(forecast) : Number.isFinite(forecast?.probabilityYes) ? 'Yes ' + formatCourseProbability(forecast.probabilityYes) : '暂未发布概率'
    const statusActions = h('span', 'wb-history-status-actions', h('span', 'wb-badge', courseSlipState(record)))
    card.append(h('span', 'wb-slip-top', h('span', '', record.purpose === 'research' ? '财报核验' : '自动跟踪'), statusActions))
    recordLink.append(question, h('small', '', record.purpose === 'research' ? record.researchReport ? '研报已封存' : '正在调查资料' : result))
    if (roomShell) recordLink.append(h('small', 'wb-history-created', ...(record.createdAt ? ['创建于 ', dateContent(record.createdAt, record.timezone)] : ['创建时间未提供'])))
    if (roomShell) card.append(recordLink)
    if (roomShell && historyRecordDeleteVisible(record)) {
      const errorNote = h('p', 'wb-history-delete-error'); errorNote.hidden = true; errorNote.setAttribute('role', 'alert')
      const getRecord = () => cache.courseRequests.find(value => (value.requestId ?? value.id) === id)
      const deleteRecord = createHistoryDeletionAction(record, { confirm: message => confirmationDialog(message, { trigger: remove, title: '删除预测记录', subject: { kind: 'prediction', name: getRecord()?.question?.trim() || getRecord()?.normalized?.question || '这条预测记录' } }), request: api, getRecord, isActive: () => card.isConnected && !cache.deletedCourseRequestIds?.has(id) })
      const remove = button('删除记录', async event => {
        event.preventDefault(); event.stopPropagation?.()
        if (pendingDeletions.has(id) || !card.isConnected) return
        pendingDeletions.add(id); remove.disabled = true; errorNote.hidden = true
        try {
          const receipt = await deleteRecord()
          if (!receipt.deleted) return
          const selected = ctx.activeCourseRequestId === id || (route().parts[0] === 'course' && route().parts[1] === id)
          applyHistoryDeletion(cache, receipt, record)
          ctx.refreshSidebar()
          if (selected) { const menu = document.getElementById('wb-history-menu'); if (menu) menu.open = false; goto('/room') }
          toast('预测记录已删除，原始运行与证据保留。')
        } catch (error) { if (card.isConnected) { errorNote.textContent = historyDeletionError(error); errorNote.hidden = false } }
        finally {
          pendingDeletions.delete(id)
          if (card.isConnected) { remove.disabled = !historyRecordCanDelete(getRecord()); if (!remove.disabled) remove.focus?.() }
          else ctx.refreshSidebar()
        }
      }, 'wb-badge wb-history-delete')
      remove.setAttribute('aria-label', '删除这条预测记录')
      remove.disabled = pendingDeletions.has(id) || !historyRecordCanDelete(record)
      if (!historyRecordCanDelete(record)) remove.title = record.watch === true || record.watch?.status === 'active' ? '请先停止持续预测，再删除这条记录。' : '请等待当前调查结束，或刷新历史记录后再删除。'
      statusActions.append(remove); card.append(errorNote)
    }
    list.append(card)
  }
  for (const p of cache.predictions.filter((p) => !coursePredictionIds.has(p.predictionId) && !cache.deletedCoursePredictionIds?.has(p.predictionId) && (roomShell || !filterTopic || p.topicId === filterTopic))) {
    if (typeof p.predictionId !== 'string' || !p.predictionId) continue
    const unread = Object.values(projection.runs).filter((r) => r.predictionId === p.predictionId).reduce((n, r) => n + r.unread, 0)
    const card = link('', '#/predictions/' + encodeURIComponent(p.predictionId), 'wb-task-slip' + (current === p.predictionId ? ' is-selected' : ''))
    if (current === p.predictionId) card.setAttribute('aria-current', 'page')
    card.append(h('span', 'wb-slip-top', '是否发生', badge(p.status)), dataContent('strong', '', p.question || '未命名预测草稿'), dataContent('small', '', cache.topics.find((t) => t.topicId === p.topicId)?.title ?? '未命名主题'))
    if (roomShell) card.append(h('small', 'wb-history-created', ...(p.createdAt ? ['创建于 ', dateContent(p.createdAt, p.timezone)] : ['创建时间未提供'])))
    if (unread) card.append(h('span', 'wb-unread', unread + ' 条新进展'))
    list.append(card)
  }
  if (roomShell) {
    const warning = cache.courseHistoryError || (cache.courseCapability?.available === false ? cache.courseCapability.message || '当前服务暂不能读取自动跟踪历史；这里不会显示示例任务。' : null)
    const notice = warning ? h('p', 'wb-sidebar-empty wb-history-error', warning) : null
    notice?.setAttribute('role', 'status')
    if (!list.children.length && !warning) list.append(h('p', 'wb-sidebar-empty', !cache.courseCapability ? '正在读取历史记录…' : '还没有已保存的预测或研报任务。可从“开始预测”创建第一项任务。'))
    return [...(notice ? [notice] : []), list]
  }
  if (!list.children.length) list.append(h('p', 'wb-sidebar-empty', '这里还没有任务纸签。写下一句希望验证的问题即可开始。'))
  return [chooser, list, link('高级：材料研读', '#/advanced', 'wb-side-link'), link('工具台', '#/tools', 'wb-side-link'), link('旧历史案例回放', '/legacy.html', 'wb-side-link')]
}

export function board(ctx) {
  const { cache, filterTopic } = ctx
  const image = h('img'); image.src = '/assets/lab-play.png'; image.alt = '等待新任务的夜间像素研究室'
  const hero = h('section', 'wb-board-hero', image, h('div', 'wb-hero-paper', h('span', 'wb-tag', '高级材料研读'), h('h2', '', '手动整理研究契约与材料。'), h('p', '', '此入口保留单研究员材料研读；自动跟踪使用默认的一句话入口。'), h('div', 'wb-actions', link('手动新建预测题', '#/advanced/new', 'wb-button wb-primary'), link('新建关注主题', '#/topics/new', 'wb-button'))))
  const courseIds = new Set((cache.courseRequests ?? []).map((r) => r.predictionId).filter(Boolean))
  const rows = cache.predictions.filter((p) => !courseIds.has(p.predictionId) && (!filterTopic || p.topicId === filterTopic))
  const grid = h('div', 'wb-board-grid')
  for (const p of rows) grid.append(h('article', 'wb-paper wb-board-card', h('div', 'wb-card-top', badge(p.status), h('span', '', '是／否预测')), h('h3', '', dataLink(p.question || '未命名草稿', '#/predictions/' + p.predictionId)), dataContent('p', 'wb-muted', cache.topics.find((t) => t.topicId === p.topicId)?.title), h('div', 'wb-card-probability', '—', h('small', '', '尚未发布概率')), h('p', '', '目标日期：', dateContent(p.targetAt, p.timezone)), link('打开研究室', '#/predictions/' + p.predictionId, 'wb-button')))
  rows.forEach((p, index) => grid.children[index].insertBefore(h('p', 'wb-muted', '最新研读：', ...(p.latestRun ? [h('span', '', labels[p.latestRun.status] ?? p.latestRun.status), ' · ', dateContent(p.latestRun.updatedAt)] : ['尚无报告'])), grid.children[index].lastChild))
  const importButton = button('导入旧历史案例', async () => {
    importButton.disabled = true
    try {
      const result = await api('/imports/legacy', write('POST', {})); toast(result.duplicate ? '这个历史案例已导入过' : '旧案例已导入，原始回放仍保留')
      if (result.topic) cache.topics = cache.topics.filter((t) => t.topicId !== result.topic.topicId).concat(result.topic)
      for (const p of result.predictions ?? []) cache.predictions = cache.predictions.filter((v) => v.predictionId !== p.predictionId).concat(p)
      dispatchEvent(new Event('workbench:datachanged')); if (importButton.isConnected) await ctx.reload()
    } catch (error) { ctx.error(error) } finally { importButton.disabled = false }
  }, 'wb-text-button')
  return [header('我的事件研究', '每张纸签对应一个独立问题，材料、研读与版本各自保留。'), hero, rows.length ? h('section', '', h('h2', 'wb-section-title', '已保存的预测题 (' + rows.length + ')'), grid) : empty('第一道预测题还在等你', '这是真实数据库中的空公告栏。创建后，任务会保存在这里。', link('创建关注主题', '#/topics/new', 'wb-button')), h('div', 'wb-import-note', h('p', '', '想从已有案例开始？可显式导入旧历史快照；它不等于当时已封存的前瞻预测。'), importButton)]
}

export async function inbox(ctx, topicId, predictionId) {
  const t = ctx.cache.topics.find((v) => v.topicId === topicId)
  if (!t) throw new Error('找不到这个关注主题。')
  const p = ctx.cache.predictions.find((v) => v.predictionId === predictionId && v.topicId === topicId)
  const data = await api('/topics/' + topicId + '/evidence' + (p ? '?predictionId=' + encodeURIComponent(p.predictionId) : ''))
  return [header('证据收报台', [dataContent('span', '', t.title), p ? ' · 只看当前题关联材料' : ' · 主题全部材料'], p ? link('返回当前研究室', '#/predictions/' + p.predictionId, 'wb-button') : link('新建关联预测', '#/advanced/new?topicId=' + topicId, 'wb-button')), h('p', 'wb-purpose', '这里保存研究输入：原文、来源及取得时间。是否足以支持判断，要在研读报告中核对；材料不会自动进入学习评分。'), h('div', 'wb-inbox-layout', h('section', 'wb-paper', h('h2', 'wb-section-title', '已保存材料 (' + data.evidence.length + ')'), data.evidence.length ? data.evidence.map(evidenceCard) : empty('还没有关联材料', '粘贴原文并保存，再返回任务开始研读。')), materialForm(ctx.cache, topicId, p?.predictionId, ctx.render))]
}

export async function learning() {
  const data = await api('/learning'); const list = h('div', 'wb-paper')
  if (!data.entries.length) list.append(empty('还没有已结算的学习档案', '研读完成不等于预测结算。只有封存预测与真实结果对应后，误差和经验修订才会进入这里。', link('返回任务公告栏', '#/predictions', 'wb-button')))
  for (const e of data.entries) list.append(h('article', 'wb-evidence-item', dataContent('h3', '', e.target ?? e.question ?? '历史结算记录'), dataContent('p', '', e.summary ?? '历史记录，实际口径以保存的原始结果为准。'), h('small', '', 'Brier: ', e.brier ?? '未记录', ' · ', dateContent(e.resolvedAt))))
  for (const [index, e] of data.entries.entries()) {
    const card = list.children[index]
    card.append(h('p', '', '历史预测 Yes：', formatCourseProbability(e.probability, '未记录'), ' · 实际结果：', h('span', '', e.outcome === 1 || e.outcome === true ? '发生' : e.outcome === 0 || e.outcome === false ? '未发生' : '待核对')), h('span', 'wb-badge', e.scoringEligible === false ? '历史归档 · 不计入新评估' : '已结算记录'))
  }
  return [header('学习档案柜', '只看已结算预测、真实结果、误差与经验版本。'), h('p', 'wb-purpose', '收报台保存“研究前知道什么”，学习档案保存“结果出来后学到什么”。本阶段不将材料或研读报告冒充结算记录。'), list]
}

export function agents(ctx, agentId, historical) {
  const ownerActive = () => typeof ctx.isActive !== 'function' || ctx.isActive()
  const grid = h('div', 'wb-agent-picker')
  ctx.cache.agents.forEach((a, index) => {
    const tile = link('', '#/agents/' + a.agentSpecId, 'wb-agent-tile' + (a.agentSpecId === agentId ? ' is-selected' : ''))
    const agentName = (isWorkspaceBuiltinText('role', a) ? uiContent : dataContent)('strong', '', a.name); agentName.id = 'wb-agent-name-' + a.agentSpecId
    tile.append(h('span', 'wb-agent-symbol', ['⌕', '◷', '⚒', '♟', '▥', '◇', '☷', '↺', '⌘', '✓'][index % 10]), agentName, h('small', '', '定义 v' + a.specVersion))
    const errorNote = h('p', 'wb-agent-delete-error'); errorNote.hidden = true; errorNote.setAttribute('role', 'alert')
    const seat = h('article', 'wb-agent-seat', tile)
    const deleteSeat = createAgentDeletionAction(a, { confirm: message => ownerActive() ? confirmationDialog(message, { trigger: remove, subject: { kind: 'researcher', name: a.name || a.agentSpecId } }) : false, request: api, availableCount: () => ctx.cache.courseCapability?.config?.roleCatalogue?.length ?? ctx.cache.agents.length })
    let deleting = false
    const remove = button('删除', async () => {
      if (deleting || !ownerActive()) return
      deleting = true; remove.disabled = true; errorNote.hidden = true
      let deleted = false
      try {
        const result = await deleteSeat()
        if (!result.deleted) return
        deleted = true
        ctx.cache.agents = ctx.cache.agents.filter(item => item.agentSpecId !== a.agentSpecId)
        if (ownerActive()) seat.remove()
        const [list, capability] = await Promise.allSettled([api('/agents'), ctx.checkCourseCapability()])
        const listReady = list.status === 'fulfilled' && Array.isArray(list.value?.agents)
        if (listReady) ctx.cache.agents = list.value.agents.filter(item => item.agentSpecId !== a.agentSpecId)
        if (!ownerActive()) return
        const current = route()
        if (current.parts[0] === 'agents') {
          if (current.parts[1] === a.agentSpecId) goto('/agents')
          else await ctx.render()
        }
        if (!ownerActive()) return
        toast('研究员席位已删除，新任务不再选用；历史记录保留。' + (!listReady || capability.status === 'rejected' ? '列表或能力状态未完整刷新，请重新读取。' : ''))
      } catch (error) { if (ownerActive()) { errorNote.textContent = agentDeletionError(error); errorNote.hidden = false } }
      finally { deleting = false; if (ownerActive()) { remove.disabled = false; if (remove.isConnected) remove.focus(); else if (deleted && route().parts[0] === 'agents') ctx.content?.focus() } }
    }, 'wb-agent-delete')
    remove.setAttribute('aria-label', '删除此研究员席位'); remove.setAttribute('aria-describedby', agentName.id); remove.title = '删除此研究员席位'
    seat.append(remove, errorNote); grid.append(seat)
  })
  const current = ctx.cache.agents.find((a) => a.agentSpecId === agentId)
  const finance = ctx.cache.courseCapability?.config?.roleCatalogue?.find((item) => item.roleId === agentId)
  const financeMethod = finance?.financeFocus ? h('section', 'wb-paper', h('h2', '', '财报任务专项方法'), uiContent('p', '', finance.financeFocus), h('p', 'wb-muted', '用于新财报调查。历史任务保留当时的方法与工具许可。')) : null
  const investigationMethod = finance?.investigationFocus ? h('section', 'wb-paper', h('h2', '', '调查方法与来源边界'), uiContent('p', '', finance.investigationFocus), h('p', '', '新任务逐条保存原文片段；搜索语言按问题选择，不依赖本机浏览器或固定Bing地区。')) : null
  const creating = agentId === 'new'
  const a = creating ? { name: '', instructions: '', allowedTools: ctx.cache.tools.map((t) => t.toolId ?? t.id), skillRefs: [], extensionSlots: [null, null], modelRef: null } : historical ?? current
  const controls = h('div', 'wb-version-bar')
  let form
  if (a) {
    if (current) {
      const versions = select(Array.from({ length: current.specVersion }, (_, index) => [String(index + 1), '定义版本 v' + (index + 1)]), String(a.specVersion))
      for (const option of versions.children) { option.removeAttribute('data-i18n-skip'); option.setAttribute('data-i18n-ui', 'true') }
      versions.setAttribute('aria-label', '查看研究员定义版本'); versions.addEventListener('change', () => { if (ownerActive()) goto('/agents/' + agentId + '?specVersion=' + versions.value) })
      controls.append(h('span', '', '查看保存版本'), versions)
    }
    form = agentForm(ctx.cache, a, (saved) => { if (!ownerActive()) return; if (creating || route().query.has('specVersion')) goto('/agents/' + saved.agentSpecId); else ctx.render() }, { isActive: ctx.isActive })
    if ((historical && !current) || (current && a.specVersion < current.specVersion)) {
      for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = true
      form.prepend(h('p', 'wb-purpose', !current ? '这是已删除席位的只读历史版本，保留用于查看过往定义，不再用于新任务。' : '这是只读历史版本。要修改职责或工具许可，请切回最新定义 v' + current.specVersion + '。'))
    }
  }
  return [researchSettingsPanel(), header('研究员席位', ctx.cache.agents.length + ' 类角色模板；自动跟踪由主 Agent 从现有目录按题选择团队。', link('＋ 新建研究员', '#/agents/new', 'wb-button wb-primary')), grid, ...(investigationMethod ? [investigationMethod] : []), ...(financeMethod ? [financeMethod] : []), controls, form ?? empty('选择一个研究员席位', '查看职责、技能指令与工具许可。保存新版本不会修改旧运行。')]
}

export function topicView(cache, topicId) {
  const t = cache.topics.find((v) => v.topicId === topicId); if (!t) throw new Error('找不到这个关注主题。')
  return [header(dataContent('span', '', t.title), '关注主题档案', link('新建关联预测题', '#/advanced/new?topicId=' + t.topicId, 'wb-button wb-primary')), h('section', 'wb-paper', h('h2', '', '背景'), dataContent('p', 'wb-prewrap', t.background || '尚未填写背景。'), h('p', 'wb-muted', '资料模式：', dataContent('span', '', t.sourceMode), ' · 主题 v', t.version), link('打开主题收报台', '#/topics/' + t.topicId + '/inbox', 'wb-button')), h('section', 'wb-paper', h('h2', '', '关联预测题'), cache.predictions.filter((p) => p.topicId === t.topicId).map((p) => { const course = (cache.courseRequests ?? []).find((r) => r.predictionId === p.predictionId); return h('p', 'wb-topic-question', dataLink(p.question || '未命名草稿', course ? '#/course/' + (course.requestId ?? course.id) : '#/predictions/' + p.predictionId)) }))]
}
