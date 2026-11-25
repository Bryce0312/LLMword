import { isWorkspaceBuiltinText } from './locale-zh-en-workspace.js'
import { h, dateContent, dataContent, link, button, header, empty, select, badge, api, write, toast, goto, sourceLink, terminal, labels, fieldLabel } from './workbench-core.js'
import { selectRun, hydrateRun } from './run-projection.js'
import { createWorkbenchRoom } from './workbench-room.js'

export function reportView(ctx, p, run) {
  const section = document.getElementById('wb-run-record'); if (!section || section.dataset.mode !== 'report') return
  if (!run) { section.replaceChildren(empty('还没有研读记录', '保存题目规则、添加关联材料，再选择一位研究员开始研读。')); return }
  const projected = ctx.projection.runs[run.runId]
  const report = run.report ?? Object.values(projected?.assignments ?? {}).find((a) => a.resultId)
  const live = projected?.records ?? []
  const historic = ctx.cache.events.get(run.runId) ?? []
  const seen = new Set(); const rows = [...historic, ...live].filter((r) => { if (seen.has(r.eventId)) return false; seen.add(r.eventId); return true }).sort((a, b) => a.seq - b.seq)
  const trace = h('div', 'wb-execution-list')
  const names = { 'tool.started': '执行工具', 'tool.completed': '工具返回', 'tool.failed': '工具失败', 'assignment.started': '开始研读', 'assignment.completed': '提交报告', 'assignment.failed': '研读失败', 'run.failed': '运行失败', 'run.cancelled': '运行取消' }
  for (const evt of rows) {
    if (!names[evt.type]) continue
    const data = evt.payload ?? evt
    trace.append(h('details', 'wb-execution-row', h('summary', '', h('span', '', names[evt.type]), ' ', dataContent('span', '', data.toolId ?? '')), h('p', 'wb-prewrap', data.summary ?? data.message ?? '已记录执行状态。'), data.evidenceIds?.length ? h('small', '', '引用材料：', dataContent('span', '', data.evidenceIds.join(', '))) : null))
  }
  const body = report ? h('div', 'wb-report-body', badge(report.status), h('p', 'wb-prewrap', report.summary), report.evidenceIds?.length ? h('small', '', '引用 ', report.evidenceIds.length, ' 条材料：', dataContent('span', '', report.evidenceIds.join(', '))) : null) : empty(terminal(run) ? '本轮未生成研读报告' : '研究员正在阅读材料', (run.error?.message ? dataContent('span', '', run.error.message) : null) ?? (terminal(run) ? '检查执行记录，补充材料后可重新研读。' : '工具与报告将在真实执行后更新。'))
  section.replaceChildren(h('div', 'wb-card-top', h('h2', '', '本轮研读记录'), badge(projected?.status ?? run.status)), h('p', 'wb-muted', '运行 ', dataContent('span', '', run.runId), ' · 题目契约 v', run.predictionVersion ?? p.version, ' · ', dateContent(run.createdAt)), body, h('h3', 'wb-section-title', '公开执行记录'), trace.children.length ? trace : h('p', 'wb-muted', '尚无工具执行记录。此处不显示模型隐藏思维链。'))
  const status = document.getElementById('wb-latest-status'); if (status) status.textContent = labels[projected?.status ?? run.status] ?? run.status
  const cancel = document.getElementById('wb-cancel-run'); if (cancel) cancel.hidden = terminal({ status: projected?.status ?? run.status })
}

export async function detail(ctx, p, requestedRun, mode, token) {
  const currentVersion = p.version
  const [runList, materials] = await Promise.all([api('/predictions/' + p.predictionId + '/runs'), api('/topics/' + p.topicId + '/evidence?predictionId=' + encodeURIComponent(p.predictionId))])
  if (!ctx.isCurrent(token)) return
  const runs = [...runList.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); for (const r of runs) ctx.cache.runs.set(r.runId, r)
  const remembered = ctx.selectedRuns.get(p.predictionId)
  const currentRuns = runs.filter((r) => r.predictionVersion === currentVersion)
  const runId = requestedRun ?? currentRuns.find((r) => r.runId === remembered)?.runId ?? currentRuns[0]?.runId ?? null
  let run = runId ? ctx.cache.runs.get(runId) : null
  if (runId && (!run || run.predictionId !== p.predictionId)) {
    run = await api('/runs/' + encodeURIComponent(runId)); if (!ctx.isCurrent(token)) return
    if (run.predictionId !== p.predictionId) throw new Error('该运行不属于当前预测题。')
    ctx.cache.runs.set(run.runId, run)
  }
  const historical = Boolean(run && run.predictionVersion !== currentVersion)
  if (historical) {
    if (!Number.isInteger(run.predictionVersion)) throw new Error('此运行缺少题目版本，不能当作当前题目研读。')
    p = await api('/predictions/' + p.predictionId + '?version=' + run.predictionVersion)
    if (!ctx.isCurrent(token)) return
  }
  if (run) { ctx.selectedRuns.set(p.predictionId, runId); ctx.accept(hydrateRun(ctx.projection, run)) }
  const roomNode = h('div', 'wb-room')
  const latest = h('dd', '', run ? labels[run.status] ?? run.status : '尚无研读报告'); latest.id = 'wb-latest-status'
  const note = h('aside', 'wb-forecast-note', h('span', 'wb-tag', '当前预测目标'), dataContent('h2', '', p.question || '尚未填写问题'), h('div', 'wb-yes-no', h('div', '', h('small', '', '是 Yes'), h('strong', '', '—')), h('div', '', h('small', '', '否 No'), h('strong', '', '—'))), h('p', 'wb-probability-empty', '尚未发布预测概率'), h('dl', 'wb-facts', h('dt', '', '目标日期'), h('dd', '', dateContent(p.targetAt, p.timezone)), h('dt', '', '停止发布'), h('dd', '', dateContent(p.forecastClosesAt, p.timezone)), h('dt', '', '材料截点'), h('dd', '', run?.cutoff ? dateContent(run.cutoff, p.timezone) : '创建研读时固定材料快照'), h('dt', '', '结算来源'), h('dd', '', sourceLink(p.resolutionSource ?? {}) ?? '尚未设置'), h('dt', '', '最新报告'), latest), h('p', 'wb-forecast-explain', '本阶段只研读材料，不生成或封存正式概率。'))
  const cut = note.querySelectorAll('dd')[2]
  cut.replaceChildren(run?.inputSnapshotAt ? dateContent(run.inputSnapshotAt, p.timezone) : '创建研读时固定材料快照')
  note.querySelector('dl').append(h('dt', '', '最近更新'), h('dd', '', dateContent(run?.updatedAt ?? p.updatedAt, p.timezone)))
  note.querySelectorAll('dt')[4].textContent = '本轮报告'
  const latestForVersion = runs.find((r) => r.predictionVersion === p.version)
  note.querySelector('dl').append(h('dt', '', '本契约最新研读'), h('dd', '', ...(latestForVersion ? [h('span', '', labels[latestForVersion.status] ?? latestForVersion.status), ' · ', dateContent(latestForVersion.updatedAt, p.timezone)] : ['尚无研读记录'])))
  note.querySelector('dd:last-child').id = 'wb-contract-latest'
  note.dataset.predictionVersion = String(p.version)
  note.querySelector('dd:last-child').dataset.createdAt = latestForVersion?.createdAt ?? ''
  const missing = p.validation?.missingFields ?? []
  const validation = h('div', 'wb-validation' + (missing.length ? ' is-incomplete' : ''), badge(p.status), h('span', '', missing.length ? [h('span', '', '仍需补充：'), ...missing.map((name, index) => [index ? ', ' : '', h('span', '', fieldLabel(name))])] : '题目已具备研读条件；正式预测发布尚未开放。'), link('编辑题目', '#/predictions/' + p.predictionId + '/edit', 'wb-text-button'))
  const roles = select(ctx.cache.agents.map((a) => [a.agentSpecId, a.name + ' · v' + a.specVersion]), run?.assignment?.agentSpecId ?? 'official')
  for (const [index, option] of [...roles.children].entries()) if (isWorkspaceBuiltinText('role', ctx.cache.agents[index])) { option.removeAttribute('data-i18n-skip'); option.setAttribute('data-i18n-ui', 'true') }
  roles.setAttribute('aria-label', '本轮研读研究员')
  const materialChoices = h('details', 'wb-material-choices', h('summary', '', '选择本轮研读材料（最多 12 份）'))
  const choices = h('div', 'wb-checks')
  for (const [index, evidence] of materials.evidence.entries()) {
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = index < 12; box.value = evidence.evidenceId
    choices.append(h('label', '', box, dataContent('span', '', evidence.title)))
  }
  materialChoices.append(choices)
  const start = button('派研究员读材料', async () => {
    start.disabled = true
    try {
      const a = ctx.cache.agents.find((v) => v.agentSpecId === roles.value)
      const evidenceIds = [...choices.querySelectorAll('input:checked')].map((el) => el.value)
      if (!evidenceIds.length || evidenceIds.length > 12) throw new Error('请选择 1 至 12 份本轮材料。')
      const created = await api('/predictions/' + p.predictionId + '/runs', write('POST', { agentSpecId: a.agentSpecId, specVersion: a.specVersion, predictionVersion: p.version, evidenceIds }))
      ctx.cache.runs.set(created.runId, created); ctx.selectedRuns.set(p.predictionId, created.runId); toast('研读已创建，实际执行状态由服务器推送。')
      if (start.isConnected) { ctx.scrollOnRun = created.runId; goto('/predictions/' + p.predictionId + '/runs/' + created.runId) }
    } catch (error) { ctx.error(error) } finally { start.disabled = false }
  }, 'wb-button wb-primary')
  start.id = 'wb-start-run'
  const replayOnly = p.legacy || ctx.cache.topics.find((t) => t.topicId === p.topicId)?.sourceMode === 'replay'
  const canStart = !historical && !replayOnly && p.status === 'ready' && p.validation?.ready && materials.evidence.length > 0 && (!p.forecastClosesAt || new Date(p.forecastClosesAt) > new Date())
  start.disabled = !canStart || runs.some((r) => !terminal(r)); start.dataset.canStart = String(Boolean(canStart))
  const cancel = button('取消本轮', async () => {
    cancel.disabled = true
    try { const saved = await api('/runs/' + run.runId + '/cancel', write('POST', {})); ctx.cache.runs.set(saved.runId, saved); toast('已提交取消，等待服务器状态。'); if (cancel.isConnected && ctx.projection.selectedRunId === saved.runId) reportView(ctx, p, saved) } catch (error) { ctx.error(error) } finally { cancel.disabled = false }
  }); cancel.id = 'wb-cancel-run'; cancel.hidden = terminal(run)
  const actions = h('div', 'wb-research-console', h('div', '', h('label', 'wb-field-label', '本轮选择一位研究员'), roles), start, cancel, link('＋ 添加关联材料', '#/topics/' + p.topicId + '/inbox?predictionId=' + p.predictionId, 'wb-button'))
  const record = h('section', 'wb-paper'); record.id = 'wb-run-record'; record.dataset.mode = mode === 'world' || mode === 'timeline' ? mode : 'report'
  const runLinks = h('div', 'wb-run-tabs')
  for (const r of runs) {
    const item = link([h('span', '', '契约 v' + (r.predictionVersion ?? '?')), ' · ', dateContent(r.createdAt), ' · ', h('span', '', labels[r.status] ?? r.status)], '#/predictions/' + p.predictionId + '/runs/' + r.runId, r.runId === runId ? 'is-selected' : '')
    item.dataset.runId = r.runId; runLinks.append(item)
  }
  const objects = h('nav', 'wb-object-links', link('☷ 证据收报台', '#/topics/' + p.topicId + '/inbox?predictionId=' + p.predictionId), link('⌘ 关系黑板', '#/predictions/' + p.predictionId + '/world'), link('◷ 任务时间轴', '#/predictions/' + p.predictionId + '/timeline'), link('▤ 学习档案柜', '#/learning'))
  ctx.content.replaceChildren(header(dataContent('span', '', ctx.cache.topics.find((t) => t.topicId === p.topicId)?.title ?? '当前研究室'), [h('span', '', '题目契约 v' + p.version), ' · 当前材料研读只用一位研究员'], link('编辑预测题', '#/predictions/' + p.predictionId + '/edit', 'wb-button')), validation, h('div', 'wb-research-layout', roomNode, note), objects, actions, h('p', 'wb-muted', replayOnly ? '历史导入题只读，请从旧历史案例入口回放。' : materials.evidence.length ? '本题可读 ' + materials.evidence.length + ' 份材料，每轮最多 12 份。' : '还不能开始：请先添加本题可用的材料。'), materialChoices, runLinks, record)
  if (historical) {
    actions.hidden = true; materialChoices.hidden = true
    validation.replaceChildren(h('span', 'wb-badge', '只读历史契约 v' + p.version), h('span', '', '要开始新的研读，请返回当前题目。'))
    ctx.content.querySelector('.wb-page-heading .wb-actions a').textContent = '编辑当前题 v' + currentVersion
    ctx.content.insertBefore(h('div', 'wb-history-warning', h('strong', '', '历史研读 · 契约 v' + p.version), h('p', '', '当前题目已是 v' + currentVersion + '。下方问题、期限与报告属于旧契约，不能代表当前判断。'), link('返回当前题目 v' + currentVersion, '#/predictions/' + p.predictionId, 'wb-button')), validation)
  }
  ctx.room = createWorkbenchRoom(roomNode, { onAgent: (id) => goto('/agents/' + id + (run?.agent?.specVersion ? '?specVersion=' + run.agent.specVersion : '')), onDestination: (id) => goto(id === 'learning' ? '/learning' : id === 'inbox' ? '/topics/' + p.topicId + '/inbox?predictionId=' + p.predictionId : '/predictions/' + p.predictionId + '/world') })
  const a = ctx.cache.agents.find((v) => v.agentSpecId === (run?.assignment?.agentSpecId ?? roles.value))
  ctx.room.setRole(a ? { ...a, name: (run?.agent?.name ?? a.name) + ' v' + (run?.agent?.specVersion ?? a.specVersion), index: ctx.cache.agents.indexOf(a) } : null, run)
  const choice = selectRun(ctx.projection, runId); ctx.accept(choice)
  ctx.refreshSidebar()
  if (!choice.effects.length) { ctx.room.apply({ type: 'room.reset', runId, generation: ctx.projection.roomGeneration }); if (runId && ctx.projection.runs[runId]) ctx.room.apply({ type: 'room.restore', runId, generation: ctx.projection.roomGeneration, run: ctx.projection.runs[runId] }) }
  if (runId && ctx.scrollOnRun === runId) {
    ctx.scrollOnRun = null
    roomNode.tabIndex = -1; roomNode.setAttribute('role', 'region'); roomNode.setAttribute('aria-label', '本轮像素研究室')
    roomNode.focus({ preventScroll: true })
    requestAnimationFrame(() => {
      if (!ctx.isCurrent(token) || !roomNode.isConnected) return
      // This is a new route after an explicit start action: position once, before live work.
      window.scrollTo({ top: Math.max(0, window.scrollY + roomNode.getBoundingClientRect().top - 16), behavior: 'instant' })
    })
  }
  roles.addEventListener('change', () => { if (!run) { const a = ctx.cache.agents.find((v) => v.agentSpecId === roles.value); ctx.room?.setRole(a ? { ...a, index: ctx.cache.agents.indexOf(a) } : null, null) } })
  reportView(ctx, p, run)
  if (record.dataset.mode === 'world') record.append(h('h2', '', '关系黑板'), empty('时序关系图尚未开放', 'M3 将在这里显示带时间、支持材料及反例的关系。本阶段只保存和研读关联原文。', link('查看本题证据', '#/topics/' + p.topicId + '/inbox?predictionId=' + p.predictionId, 'wb-button')))
  if (record.dataset.mode === 'timeline') record.append(h('h2', '', '任务时间轴'), h('ol', 'wb-timeline', h('li', '', '创建：', dateContent(p.createdAt)), h('li', '', '停止发布：', dateContent(p.forecastClosesAt, p.timezone)), h('li', '', '目标日期：', dateContent(p.targetAt, p.timezone)), h('li', '', '结算：尚未结算')))
  if (runId) {
    try { const data = await api('/runs/' + runId + '/events'); ctx.cache.events.set(runId, data.events); if (ctx.isCurrent(token)) reportView(ctx, p, ctx.cache.runs.get(runId)) } catch (error) { if (ctx.isCurrent(token)) toast('执行记录暂不可读：' + error.message) }
  }
}
