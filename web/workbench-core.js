import { getLocale } from './locale.mjs'
import { formatUiDate } from './locale-format.mjs'
import { apiErrorPresentation } from './course-errors.mjs'

export const $ = (id) => document.getElementById(id)
export const labels = { draft: '草稿', ready: '可研读', active: '进行中', queued: '排队中', running: '研读中', completed: '报告已保存', failed: '研读失败', cancelled: '已取消', waiting: '等待资料', cancelling: '取消中', closed: '已关闭', resolved: '已结算', void: '无法结算', complete: '已完成', insufficient: '资料不足', blocked: '暂被阻塞' }
export const fieldLabel = (name) => ({ question: '预测问题', type: '题型', timezone: '时区', targetAt: '目标日期', forecastClosesAt: '停止发布时间', resolutionRule: '结算规则', 'resolutionSource.url': '结算来源链接', 'resolutionSource.kind': '结算来源类型', unresolvablePolicy: '无法判定处理' })[name] ?? name
export function h(tag, cls, ...children) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  el.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined))
  return el
}
export function uiContent(tag, cls, ...children) { const node = h(tag, cls, ...children); node.setAttribute('data-i18n-ui', 'true'); return node }
export function dateContent(raw, timezone, tag = 'span', cls = '') {
  const node = h(tag, cls, fmt(raw, timezone))
  node.setAttribute('data-i18n-date', raw || '')
  if (timezone) node.setAttribute('data-i18n-timezone', timezone)
  return node
}
export function dataContent(tag, cls, ...children) { const node = h(tag, cls, ...children); node.setAttribute('data-i18n-skip', 'true'); return node }
export function dataLink(text, url, cls = '') { const node = link(text, url, cls); node.setAttribute('data-i18n-skip', 'true'); return node }
export function link(text, url, cls = '') { const a = h('a', cls, text); a.href = url; return a }
export function button(text, action, cls = 'wb-button') { const b = h('button', cls, text); b.type = 'button'; b.addEventListener('click', action); return b }
export const badge = (status) => h('span', 'wb-badge wb-' + status, labels[status] ?? status)
export const empty = (title, detail, action) => h('div', 'wb-empty', h('span', 'wb-empty-icon', '✦'), h('h3', '', title), h('p', '', detail), action)
export const header = (title, subtitle, ...actions) => h('div', 'wb-page-heading', h('div', '', h('h1', '', title), subtitle ? h('p', '', subtitle) : null), h('div', 'wb-actions', actions))
export const goto = (path) => { location.hash = path }
export const terminal = (run) => !run || ['completed', 'failed', 'cancelled'].includes(run.status)
export function route() { const u = new URL(location.hash.slice(1) || '/predictions', location.origin); return { parts: u.pathname.split('/').filter(Boolean).map(decodeURIComponent), query: u.searchParams } }
export function fmt(raw, timezone) { return formatUiDate(raw, { locale: getLocale(), timezone }) }

export async function api(path, options = {}) {
  const headers = { Accept: 'application/json' }
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = crypto.randomUUID() }
  const response = await fetch('/api/v1' + path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const record = data.error ?? data
    const error = new Error(record.message || '请求失败 (' + response.status + ')')
    error.code = record.code; error.fields = record.fields ?? data.fields ?? []; error.status = response.status
    throw error
  }
  return data
}
export const write = (method, body) => ({ method, body })
let timer
export function toast(message) {
  clearTimeout(timer); $('wb-toast').textContent = message; $('wb-toast').hidden = false
  timer = setTimeout(() => { $('wb-toast').hidden = true }, 5000)
}
export function input(value = '', type = 'text') { const el = document.createElement('input'); el.type = type; el.value = value ?? ''; return el }
export function textarea(value = '', rows = 4) { const el = document.createElement('textarea'); el.value = value ?? ''; el.rows = rows; return el }
export function select(options, value) {
  const el = document.createElement('select')
  for (const [id, text] of options) { const option = dataContent('option', '', text); option.value = id; el.append(option) }
  if (value !== undefined && value !== null && value !== '') el.value = value
  return el
}
export function field(form, name, label, control, note = '') {
  control.name = name; control.id = 'field-' + name.replaceAll('.', '-')
  const lab = h('label', 'wb-field-label', label); lab.htmlFor = control.id
  const error = h('small', 'wb-field-error'); error.dataset.fieldError = name
  form.append(h('div', 'wb-field', lab, control, note ? h('small', 'wb-field-note', note) : null, error))
  return control
}
export function formError(form, error) {
  let box = form.querySelector('.wb-form-error')
  if (!box) { box = h('div', 'wb-form-error'); box.setAttribute('role', 'alert'); form.prepend(box) }
  const presentation = apiErrorPresentation(error)
  box.replaceChildren(uiContent('span', '', presentation.message), ...(presentation.refreshVersion ? [uiContent('span', '', ' 请刷新读取最新版本；当前输入仍保留。')] : []))
  for (const note of form.querySelectorAll('[data-field-error]')) note.textContent = ''
  const missing = Array.isArray(error.fields) ? error.fields : Object.keys(error.fields ?? {})
  for (const name of missing) { const note = form.querySelector('[data-field-error="' + CSS.escape(name) + '"]'); if (note) note.textContent = '请补充或修正此项。' }
  box.scrollIntoView({ block: 'nearest' })
}
export function sourceLink(item) {
  if (!item.url || !/^https?:\/\//i.test(item.url)) return null
  const a = link('查看来源原文', item.url, 'wb-source-link'); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a
}
export function evidenceCard(e) {
  return h('article', 'wb-evidence-item', h('div', 'wb-card-top', dataContent('h3', '', e.title), h('span', 'wb-badge', e.sourceMode === 'replay' ? '历史资料' : '提供的材料')), dataContent('p', 'wb-prewrap', e.text), h('div', 'wb-evidence-meta', h('span', '', h('span', '', '取得：'), dateContent(e.firstSeenAt)), e.publishedAt ? h('span', '', h('span', '', '原发布：'), dateContent(e.publishedAt)) : null, sourceLink(e)), dataContent('small', 'wb-muted', e.evidenceId))
}
