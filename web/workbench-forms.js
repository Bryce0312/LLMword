import { h, link, header, empty, field, input, textarea, select, formError, api, write, toast, goto, route } from './workbench-core.js'

export function topicForm(container, cache) {
  const form = h('form', 'wb-paper wb-form')
  field(form, 'title', '关注主题', input(''), '例如：某公司管理层变化、某项政策是否落地。')
  field(form, 'background', '背景与关注理由', textarea(''))
  field(form, 'sourceMode', '资料模式', select([['provided', '用户提供材料'], ['live', '实时主题（自动监听待后续开放）']]))
  const submit = h('button', 'wb-button wb-primary', '保存关注主题'); submit.type = 'submit'; form.append(submit)
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true
    try {
      const values = Object.fromEntries(new FormData(form))
      if (!values.title.trim()) throw Object.assign(new Error('请填写关注主题。'), { fields: ['title'] })
      const saved = await api('/topics', write('POST', values)); cache.topics.push(saved); toast('主题已保存'); dispatchEvent(new Event('workbench:datachanged')); if (form.isConnected) goto('/topics/' + saved.topicId)
    } catch (error) { formError(form, error) } finally { submit.disabled = false }
  })
  container.replaceChildren(header('新建关注主题', '主题可以长期存在，并关联多道独立预测题。'), form)
}
function localInput(raw) {
  if (!raw) return ''
  const date = new Date(raw); if (Number.isNaN(date.valueOf())) return ''
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
export function predictionForm(container, cache, existing) {
  if (!cache.topics.length) { container.replaceChildren(header('先创建一个关注主题'), empty('预测题需要所属主题', '先用主题汇总背景和来源，再设定具体问题的期限与规则。', link('创建关注主题', '#/topics/new', 'wb-button wb-primary'))); return }
  const p = existing ?? {}; const form = h('form', 'wb-paper wb-form'); form.noValidate = true
  const body = h('div', 'wb-form-grid'); form.append(body)
  const topicInput = field(body, 'topicId', '所属主题', select(cache.topics.map((t) => [t.topicId, t.title]), p.topicId ?? route().query.get('topicId')))
  if (existing) topicInput.disabled = true
  form.append(h('p', 'wb-purpose', '预测类型：是否发生（Yes / No）。当前版本仅提供是／否预测题，其他输出类型暂缓。'))
  field(body, 'question', '要验证的问题', textarea(p.question, 2), '用一个清楚、可验证的问题描述；草稿可以暂缺字段。')
  field(body, 'object', '预测对象', input(p.object))
  field(body, 'targetAt', '目标日期与时间（本机时区）', input(localInput(p.targetAt), 'datetime-local'))
  field(body, 'forecastClosesAt', '停止发布时间（本机时区）', input(localInput(p.forecastClosesAt), 'datetime-local'), '晚于此时间不能登记为有效预测。')
  field(body, 'timezone', '结果展示时区', input(p.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone), '时间输入按设备时区转换为 UTC；此项决定结果的展示时区。')
  field(body, 'resolutionRule', '怎样判定结果', textarea(p.resolutionRule, 3), '明确发生、未发生、来源更正与无法判定的处理。')
  field(body, 'resolutionSource.url', '指定结算来源链接', input(p.resolutionSource?.url, 'url'))
  const buttons = h('div', 'wb-actions')
  for (const [value, title] of [['draft', '保存草稿'], ['ready', '保存并设为可研读']]) { const b = h('button', 'wb-button' + (value === 'ready' ? ' wb-primary' : ''), title); b.type = 'submit'; b.value = value; buttons.append(b) }
  form.append(h('p', 'wb-muted', '保存为可研读不会自动生成或封存预测概率。修改会建立新契约版本。'), buttons)
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const status = event.submitter?.value ?? 'draft'; const values = Object.fromEntries(new FormData(form)); const submits = [...buttons.querySelectorAll('button')]; submits.forEach((b) => { b.disabled = true })
    try {
      const payload = { ...values, type: 'binary', topicId: p.topicId ?? values.topicId, status, targetAt: values.targetAt ? new Date(values.targetAt).toISOString() : null, forecastClosesAt: values.forecastClosesAt ? new Date(values.forecastClosesAt).toISOString() : null, resolutionSource: { kind: 'official', url: values['resolutionSource.url'] || '' }, options: [], unresolvablePolicy: 'pending_then_manual_review' }
      delete payload['resolutionSource.url']; if (existing) payload.expectedVersion = p.version
      const path = existing ? '/predictions/' + p.predictionId : '/topics/' + payload.topicId + '/predictions'
      const saved = await api(path, write(existing ? 'PATCH' : 'POST', payload))
      cache.predictions = cache.predictions.filter((v) => v.predictionId !== saved.predictionId).concat(saved)
      toast(status === 'draft' ? '预测草稿已保存' : '预测题已保存，可开始材料研读'); dispatchEvent(new Event('workbench:datachanged')); if (form.isConnected) goto('/predictions/' + saved.predictionId)
    } catch (error) { formError(form, error) } finally { submits.forEach((b) => { b.disabled = false }) }
  })
  container.replaceChildren(header(existing ? '编辑预测题' : '新建预测题', existing ? '当前契约 v' + p.version + '，旧运行保留原契约。' : '先把题目写清楚，再把材料交给研究员。'), form)
}

export function materialForm(cache, topicId, predictionId, onSaved) {
  const form = h('form', 'wb-paper wb-form')
  form.append(h('h2', '', '放入一份新材料'))
  field(form, 'title', '材料标题', input(''))
  const text = field(form, 'text', '材料正文', textarea('', 6), '单份最多 4000 字。请提供正文；链接只作引用，不会自动抓取。'); text.maxLength = 4000
  field(form, 'url', '来源链接（可选）', input('', 'url'))
  const associations = h('fieldset', 'wb-checks'); associations.append(h('legend', '', '关联预测题（不选则作为主题共同材料）'))
  for (const p of cache.predictions.filter((v) => v.topicId === topicId)) {
    const box = input('', 'checkbox'); box.value = p.predictionId; box.checked = p.predictionId === predictionId; box.name = 'predictionIds'
    associations.append(h('label', '', box, p.question || '未命名草稿'))
  }
  form.append(associations)
  const save = h('button', 'wb-button wb-primary', '保存材料'); save.type = 'submit'; form.append(save)
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true
    try {
      const data = new FormData(form); const values = Object.fromEntries(data)
      if (!values.title.trim() || !values.text.trim()) throw new Error('请填写材料标题与正文。')
      await api('/topics/' + topicId + '/evidence', write('POST', { title: values.title, text: values.text, url: values.url || undefined, predictionIds: data.getAll('predictionIds') }))
      toast('材料已保存，下一次研读会读取所关联材料。'); if (form.isConnected) await onSaved()
    } catch (error) { formError(form, error) } finally { save.disabled = false }
  })
  return form
}

export function agentForm(cache, a, onSaved) {
  const creating = !a.agentSpecId
  const form = h('form', 'wb-paper wb-form')
  form.append(h('div', 'wb-card-top', h('h2', '', creating ? '定义一位新研究员' : a.name), h('span', 'wb-badge', creating ? '尚未保存' : '定义 v' + a.specVersion)))
  field(form, 'name', '研究员名称', input(a.name))
  field(form, 'instructions', '职责与技能指令', textarea(a.instructions, 6), '说明调查方法、引用要求和资料不足时怎样报告。')
  const refs = field(form, 'skillRefs', '已登记的技能版本', input((a.skillRefs ?? []).map((ref) => typeof ref === 'string' ? ref : ref.skillId + '@' + ref.version).join(', ')), '保留已注册方法版本。上方可编辑本角色的调查指令；技能引用不能替代实际工具。'); refs.readOnly = true
  if (a.description) form.append(h('p', 'wb-purpose', a.description))
  if (a.plannedTools?.length) form.append(h('p', 'wb-muted', '专用能力尚未接入：' + a.plannedTools.join('、') + '。当前仅使用下方实际注册的工具。'))
  const tools = h('fieldset', 'wb-checks'); tools.append(h('legend', '', '允许使用的已注册工具'))
  for (const tool of cache.tools) {
    const box = input('', 'checkbox'); box.value = tool.toolId ?? tool.id; box.name = 'allowedTools'; box.checked = a.allowedTools.includes(box.value)
    tools.append(h('label', '', box, h('span', '', tool.name ?? tool.description ?? box.value, h('small', '', box.value))))
  }
  form.append(tools)
  const slots = h('div', 'wb-form-grid'); form.append(slots)
  for (let i = 0; i < 2; i++) field(slots, 'extension' + i, '扩展槽 ' + (i + 1), select([['', '空槽位'], ...cache.tools.map((t) => [t.toolId ?? t.id, t.name ?? t.toolId ?? t.id])], a.extensionSlots?.[i] ?? ''))
  const save = h('button', 'wb-button wb-primary', creating ? '创建研究员' : '保存研究员新版本'); save.type = 'submit'; form.append(save)
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true
    try {
      const data = new FormData(form)
      const saved = await api('/agents', write('POST', { agentSpecId: a.agentSpecId, expectedVersion: a.specVersion, name: data.get('name'), instructions: data.get('instructions'), skillRefs: a.skillRefs ?? [], allowedTools: data.getAll('allowedTools'), extensionSlots: [data.get('extension0') || null, data.get('extension1') || null], modelRef: a.modelRef, limits: a.limits }))
      cache.agents = creating ? cache.agents.concat(saved) : cache.agents.map((v) => v.agentSpecId === saved.agentSpecId ? saved : v)
      toast(creating ? '新研究员已创建，定义 v' + saved.specVersion : '研究员定义已保存为 v' + saved.specVersion); dispatchEvent(new Event('workbench:datachanged')); if (form.isConnected) onSaved(saved)
    } catch (error) { formError(form, error) } finally { save.disabled = false }
  })
  return form
}
