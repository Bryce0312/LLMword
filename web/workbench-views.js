import { h, link, button, header, empty, select, badge, evidenceCard, api, write, toast, goto, fmt, route, labels } from './workbench-core.js'
import { materialForm, agentForm } from './workbench-forms.js'

function courseSlipState(record) {
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
  const current = route().parts[0] === 'predictions' ? route().parts[1] : null
  const chooser = select([['', '所有关注主题'], ...cache.topics.map((t) => [t.topicId, t.title])], filterTopic)
  chooser.setAttribute('aria-label', '按主题筛选任务'); chooser.value = filterTopic
  chooser.addEventListener('change', () => ctx.onFilter(chooser.value))
  const list = h('div', 'wb-task-list')
  const coursePredictionIds = new Set((cache.courseRequests ?? []).map((r) => r.predictionId).filter(Boolean))
  for (const record of [...(cache.courseRequests ?? [])].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))) {
    const id = record.requestId ?? record.id; const normalized = record.normalized ?? record.prediction ?? {}
    const card = link('', '#/course/' + id, 'wb-task-slip' + (route().parts[0] === 'course' && route().parts[1] === id ? ' is-selected' : ''))
    const question = h('strong', '', record.question?.trim() || normalized.question || '正在整理题目')
    question.title = normalized.question ?? question.textContent
    card.append(h('span', 'wb-slip-top', '自动跟踪', h('span', 'wb-badge', courseSlipState(record))), question, h('small', '', Number.isFinite(record.forecast?.probabilityYes) ? 'Yes ' + Math.round(record.forecast.probabilityYes * 100) + '%' : '暂未发布概率'))
    list.append(card)
  }
  for (const p of cache.predictions.filter((p) => !coursePredictionIds.has(p.predictionId) && (!filterTopic || p.topicId === filterTopic))) {
    const unread = Object.values(projection.runs).filter((r) => r.predictionId === p.predictionId).reduce((n, r) => n + r.unread, 0)
    const card = link('', '#/predictions/' + p.predictionId, 'wb-task-slip' + (current === p.predictionId ? ' is-selected' : ''))
    if (current === p.predictionId) card.setAttribute('aria-current', 'page')
    card.append(h('span', 'wb-slip-top', '是否发生', badge(p.status)), h('strong', '', p.question || '未命名预测草稿'), h('small', '', cache.topics.find((t) => t.topicId === p.topicId)?.title ?? '未命名主题'))
    if (unread) card.append(h('span', 'wb-unread', unread + ' 条新进展'))
    list.append(card)
  }
  if (!list.children.length) list.append(h('p', 'wb-sidebar-empty', '这里还没有任务纸签。写下一句希望验证的问题即可开始。'))
  return [h('div', 'wb-sidebar-title', h('h2', '', '任务公告栏'), h('span', '', String(list.querySelectorAll('a').length))), chooser, link('＋ 开始事件跟踪', '#/course/new', 'wb-button wb-primary'), link('模型连接 · API Key', '#/model-connection', 'wb-side-link'), list, link('高级：材料研读', '#/advanced', 'wb-side-link'), link('工具台', '#/tools', 'wb-side-link'), link('旧历史案例回放', '/legacy.html', 'wb-side-link')]
}

export function board(ctx) {
  const { cache, filterTopic } = ctx
  const image = h('img'); image.src = '/assets/lab-play.png'; image.alt = '等待新任务的夜间像素研究室'
  const hero = h('section', 'wb-board-hero', image, h('div', 'wb-hero-paper', h('span', 'wb-tag', '高级材料研读'), h('h2', '', '手动整理研究契约与材料。'), h('p', '', '此入口保留单研究员材料研读；自动跟踪使用默认的一句话入口。'), h('div', 'wb-actions', link('手动新建预测题', '#/advanced/new', 'wb-button wb-primary'), link('新建关注主题', '#/topics/new', 'wb-button'))))
  const courseIds = new Set((cache.courseRequests ?? []).map((r) => r.predictionId).filter(Boolean))
  const rows = cache.predictions.filter((p) => !courseIds.has(p.predictionId) && (!filterTopic || p.topicId === filterTopic))
  const grid = h('div', 'wb-board-grid')
  for (const p of rows) grid.append(h('article', 'wb-paper wb-board-card', h('div', 'wb-card-top', badge(p.status), h('span', '', '是／否预测')), h('h3', '', link(p.question || '未命名草稿', '#/predictions/' + p.predictionId)), h('p', 'wb-muted', cache.topics.find((t) => t.topicId === p.topicId)?.title), h('div', 'wb-card-probability', '—', h('small', '', '尚未发布概率')), h('p', '', '目标日期：' + fmt(p.targetAt, p.timezone)), link('打开研究室', '#/predictions/' + p.predictionId, 'wb-button')))
  rows.forEach((p, index) => grid.children[index].insertBefore(h('p', 'wb-muted', '最新研读：' + (p.latestRun ? (labels[p.latestRun.status] ?? p.latestRun.status) + ' · ' + fmt(p.latestRun.updatedAt) : '尚无报告')), grid.children[index].lastChild))
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
  return [header('证据收报台', t.title + (p ? ' · 只看当前题关联材料' : ' · 主题全部材料'), p ? link('返回当前研究室', '#/predictions/' + p.predictionId, 'wb-button') : link('新建关联预测', '#/advanced/new?topicId=' + topicId, 'wb-button')), h('p', 'wb-purpose', '这里保存研究输入：原文、来源及取得时间。是否足以支持判断，要在研读报告中核对；材料不会自动进入学习评分。'), h('div', 'wb-inbox-layout', h('section', 'wb-paper', h('h2', 'wb-section-title', '已保存材料 (' + data.evidence.length + ')'), data.evidence.length ? data.evidence.map(evidenceCard) : empty('还没有关联材料', '粘贴原文并保存，再返回任务开始研读。')), materialForm(ctx.cache, topicId, p?.predictionId, ctx.render))]
}

export async function learning() {
  const data = await api('/learning'); const list = h('div', 'wb-paper')
  if (!data.entries.length) list.append(empty('还没有已结算的学习档案', '研读完成不等于预测结算。只有封存预测与真实结果对应后，误差和经验修订才会进入这里。', link('返回任务公告栏', '#/predictions', 'wb-button')))
  for (const e of data.entries) list.append(h('article', 'wb-evidence-item', h('h3', '', e.target ?? e.question ?? '历史结算记录'), h('p', '', e.summary ?? '历史记录，实际口径以保存的原始结果为准。'), h('small', '', 'Brier：' + (e.brier ?? '未记录') + ' · ' + fmt(e.resolvedAt))))
  for (const [index, e] of data.entries.entries()) {
    const card = list.children[index]
    card.append(h('p', '', '历史预测 Yes：' + (Number.isFinite(e.probability) ? Math.round(e.probability * 100) + '%' : '未记录') + ' · 实际结果：' + (e.outcome === 1 || e.outcome === true ? '发生' : e.outcome === 0 || e.outcome === false ? '未发生' : '待核对')), h('span', 'wb-badge', e.scoringEligible === false ? '历史归档 · 不计入新评估' : '已结算记录'))
  }
  return [header('学习档案柜', '只看已结算预测、真实结果、误差与经验版本。'), h('p', 'wb-purpose', '收报台保存“研究前知道什么”，学习档案保存“结果出来后学到什么”。本阶段不将材料或研读报告冒充结算记录。'), list]
}

export function agents(ctx, agentId, historical) {
  const grid = h('div', 'wb-agent-picker')
  ctx.cache.agents.forEach((a, index) => {
    const tile = link('', '#/agents/' + a.agentSpecId, 'wb-agent-tile' + (a.agentSpecId === agentId ? ' is-selected' : ''))
    tile.append(h('span', 'wb-agent-symbol', ['⌕', '◷', '⚒', '♟', '▥', '◇', '☷', '↺', '⌘', '✓'][index % 10]), h('strong', '', a.name), h('small', '', '定义 v' + a.specVersion)); grid.append(tile)
  })
  const current = ctx.cache.agents.find((a) => a.agentSpecId === agentId)
  const creating = agentId === 'new'
  const a = creating ? { name: '', instructions: '', allowedTools: ctx.cache.tools.map((t) => t.toolId ?? t.id), skillRefs: [], extensionSlots: [null, null], modelRef: null } : historical ?? current
  const controls = h('div', 'wb-version-bar')
  let form
  if (a) {
    if (current) {
      const versions = select(Array.from({ length: current.specVersion }, (_, index) => [String(index + 1), '定义版本 v' + (index + 1)]), String(a.specVersion))
      versions.setAttribute('aria-label', '查看研究员定义版本'); versions.addEventListener('change', () => goto('/agents/' + agentId + '?specVersion=' + versions.value))
      controls.append(h('span', '', '查看保存版本'), versions)
    }
    form = agentForm(ctx.cache, a, (saved) => { if (creating || route().query.has('specVersion')) goto('/agents/' + saved.agentSpecId); else ctx.render() })
    if (current && a.specVersion < current.specVersion) {
      for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = true
      form.prepend(h('p', 'wb-purpose', '这是只读历史版本。要修改职责或工具许可，请切回最新定义 v' + current.specVersion + '。'))
    }
  }
  return [header('研究员席位', ctx.cache.agents.length + ' 类角色模板；自动跟踪由主 Agent 从现有目录按题选择团队。', link('模型连接 · API Key', '#/model-connection', 'wb-button'), link('＋ 新建研究员', '#/agents/new', 'wb-button wb-primary')), grid, controls, form ?? empty('选择一个研究员席位', '查看职责、技能指令与工具许可。保存新版本不会修改旧运行。')]
}

export function topicView(cache, topicId) {
  const t = cache.topics.find((v) => v.topicId === topicId); if (!t) throw new Error('找不到这个关注主题。')
  return [header(t.title, '关注主题档案', link('新建关联预测题', '#/advanced/new?topicId=' + t.topicId, 'wb-button wb-primary')), h('section', 'wb-paper', h('h2', '', '背景'), h('p', 'wb-prewrap', t.background || '尚未填写背景。'), h('p', 'wb-muted', '资料模式：' + t.sourceMode + ' · 主题 v' + t.version), link('打开主题收报台', '#/topics/' + t.topicId + '/inbox', 'wb-button')), h('section', 'wb-paper', h('h2', '', '关联预测题'), cache.predictions.filter((p) => p.topicId === t.topicId).map((p) => { const course = (cache.courseRequests ?? []).find((r) => r.predictionId === p.predictionId); return h('p', 'wb-topic-question', link(p.question || '未命名草稿', course ? '#/course/' + (course.requestId ?? course.id) : '#/predictions/' + p.predictionId)) }))]
}
