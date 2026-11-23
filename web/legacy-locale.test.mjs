import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { initLocaleUI, translateUiText } from './locale.mjs'
import { isLegacyBuiltinText, legacyDynamicRules } from './locale-zh-en-legacy.mjs'

class Node {
  constructor(doc, type, tag = '') { this.ownerDocument = doc; this.nodeType = type; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = new Map(); this.hidden = false; this.style = { setProperty() {} }; this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, s => '-' + s.toLowerCase())), set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, s => '-' + s.toLowerCase()), value); return true } }); this.classList = { contains: cls => this.className.split(/\s+/).includes(cls), add: (...classes) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...classes])].join(' ') }, remove: (...classes) => { this.className = this.className.split(/\s+/).filter(cls => !classes.includes(cls)).join(' ') }, toggle: (cls, force) => { const enable = force ?? !this.classList.contains(cls); this.classList[enable ? 'add' : 'remove'](cls); return enable } } }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes.at(-1) ?? null }
  get lastElementChild() { return this.children.at(-1) ?? null }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null }
  get isConnected() { return this.nodeType === 9 || this.parentNode?.isConnected === true }
  get children() { return this.childNodes.filter(node => node.nodeType === 1) }
  get className() { return this.getAttribute('class') ?? '' } set className(value) { this.setAttribute('class', value) }
  get title() { return this.getAttribute('title') ?? '' } set title(value) { this.setAttribute('title', value) }
  get alt() { return this.getAttribute('alt') ?? '' } set alt(value) { this.setAttribute('alt', value) }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join('') }
  set textContent(value) { this.replaceChildren(String(value)) }
  append(...items) { for (let node of items) { if (typeof node !== 'object') node = this.ownerDocument.createTextNode(String(node)); node.remove?.(); node.parentNode = this; this.childNodes.push(node) } }
  replaceChildren(...items) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...items) }
  insertBefore(node, before) { node.remove?.(); const index = this.childNodes.indexOf(before); node.parentNode = this; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node) }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null } }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }
  addEventListener(type, fn) { (this.listeners ??= new Map()); const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list) }
  removeEventListener(type, fn) { this.listeners?.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)) }
  click() { for (const fn of this.listeners?.get('click') ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {} }) }
  getContext() { return null }
  showModal() { this.open = true }
  close() { this.open = false }
  closest(selector) { for (let owner = this; owner; owner = owner.parentElement) if (owner.matches(selector)) return owner; return null }
  focus() { this.ownerDocument.activeElement = this }
  matches(selector) {
    if (selector === '*') return true
    if (selector.includes(' ')) { const parts = selector.split(/\s+/); if (!this.matches(parts.pop())) return false; for (let parent = this.parentElement; parent; parent = parent.parentElement) if (parent.matches(parts.join(' '))) return true; return false }
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const attr = selector.match(/^(?:([a-zA-Z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/)
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase()) && (attr[3] === undefined ? this.hasAttribute(attr[2]) : this.getAttribute(attr[2]) === attr[3])
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
class Document extends Node {
  constructor() { super(null, 9); this.ownerDocument = this; this.documentElement = this.createElement('html'); this.body = this.createElement('body'); this.append(this.documentElement); this.documentElement.append(this.body); this.defaultView = {} }
  createElement(tag) { return new Node(this, 1, tag) }
  createTextNode(text) { const node = new Node(this, 3); node.data = text; return node }
  getElementById(id) { return this.querySelectorAll('*').find(node => node.id === id) ?? null }
}


function loadMarkup(doc) {
  const html = readFileSync(new URL('./legacy.html', import.meta.url), 'utf8')
  const stack = [doc]
  for (const token of html.match(/<[^>]*>|[^<]+/g)) {
    if (token.startsWith('<!')) continue
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { stack.at(-1).append(token); continue }
    const name = token.match(/^<([a-zA-Z0-9-]+)/)?.[1]
    if (!name) continue
    let node
    if (name === 'html') node = doc.documentElement
    else if (name === 'body') node = doc.body
    else { node = doc.createElement(name); stack.at(-1).append(node) }
    for (const [, attr, value] of token.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
      node.setAttribute(attr, value)
      if (['id', 'value'].includes(attr)) node[attr] = value
    }
    if (!['meta', 'link', 'img', 'input', 'br', 'hr'].includes(name)) stack.push(node)
  }
}

test('legacy app initializes in the saved language and switches existing UI without rewriting history, sources or triggering writes', async () => {
  const keys = ['document', 'window', 'location', 'fetch', 'ResizeObserver', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'EventSource']
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]))
  const doc = new Document(); loadMarkup(doc)
  doc.defaultView.localStorage = { getItem: key => key === 'world-lab.locale' ? 'en' : null, setItem() {} }
  globalThis.document = doc; globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.location = { origin: 'http://localhost' }
  globalThis.ResizeObserver = class { observe() {} }; globalThis.matchMedia = () => ({ matches: true })
  globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {}; globalThis.EventSource = undefined
  const calls = [], now = '2026-11-23T03:00:00.000Z'
  const saved = { mode: 'mock', case: { title: '模型连接' }, cutoff: now, step: 0, totalSteps: 1, stages: [{ title: '保存预算', date: now, description: '模型连接' }],
    agents: [], companies: [], factors: [{ id: 'policy', label: '模型连接', value: '保存预算', status: 'confirmed', sourceIds: [] }],
    evidence: [{ id: 'source', title: '模型连接', summary: '保存预算', source: '保存预算', url: 'https://example.com/source', publishedAt: now }],
    question: '模型连接', trace: [{ agentId: 'policy', kind: 'message', message: '保存预算' }], tools: [{ id: 'custom', name: '模型连接', description: '保存预算' }],
    forecast: { target: '模型连接', summary: '保存预算', probability: .6, prior: .5, branch: 'base', sourceIds: [] },
    learning: { history: [], resolved: 0, description: '模型连接' }, branches: [{ id: 'base', label: '历史主线' }] }
  globalThis.fetch = async (url, options = {}) => { calls.push({ url, method: options.method ?? 'GET' }); return { ok: true, json: async () => url === '/api/world' ? saved : { mode: 'off', sources: [], latestItems: [], decisions: [] } } }
  try {
    await import('./app.js?legacy-locale-test')
    await new Promise(resolve => setImmediate(resolve))
    const locale = initLocaleUI({ document: doc }); locale.refresh()
    assert.equal(locale.getLocale(), 'en')
    assert.equal(doc.getElementById('case-title').textContent, '模型连接')
    assert.equal(doc.getElementById('run').textContent.trim(), 'Start agent meeting')
    assert(doc.getElementById('world-clock').textContent.includes('Nov 22, 2026'), 'The exchange-local timestamp uses the active locale')
    assert.equal(doc.getElementById('panel-world').querySelector('h4').textContent, '模型连接')
    assert(doc.getElementById('panel-world').textContent.includes('保存预算'))
    assert.equal(doc.getElementById('panel-meeting').querySelector('.trace-message').textContent, '保存预算')
    assert.equal(doc.getElementById('panel-tools').querySelector('h4').textContent, '模型连接')
    const trace = doc.getElementById('panel-meeting').querySelector('.trace-message')
    const text = trace.firstChild, original = text.data
    Object.defineProperty(text, 'data', { configurable: true, get() { throw new Error('locale must not read original model text') } })
    const run = doc.getElementById('run'), room = doc.getElementById('room-floor'), count = calls.length
    locale.setLocale('zh-CN', { persist: false }); locale.setLocale('en', { persist: false })
    assert.equal(doc.getElementById('run'), run); assert.equal(doc.getElementById('room-floor'), room)
    assert.equal(calls.length, count); assert(calls.every(call => call.method === 'GET'))
    assert.equal(doc.querySelectorAll('[data-locale="zh-CN"]')[0].textContent, '简体中文')
    Object.defineProperty(text, 'data', { configurable: true, writable: true, value: original })
    assert.equal(trace.textContent, '保存预算')
  } finally {
    initLocaleUI({ document: doc }).dispose()
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value
  }
})

test('legacy fixed labels and numerical templates translate, but renamed metadata never becomes system UI', () => {
  for (const label of ['世界事务所', '半导体推演室', '假设：限制范围较窄', '召集 Agent 会议', '研究技能', '监测收件箱', '第 12 条事件 · 待揭示', '价差 2.4 个百分点', '已封存预测 60%，揭示结果后按此结算。']) assert(!/\p{Script=Han}/u.test(translateUiText(label)), label)
  assert.equal(isLegacyBuiltinText('agent', { id: 'policy', name: '小策' }), true)
  assert.equal(isLegacyBuiltinText('agent', { id: 'policy', name: '模型连接' }), false)
  assert.equal(isLegacyBuiltinText('tool', { id: 'read_memory', name: '读取验证记忆' }), true)
  assert.equal(isLegacyBuiltinText('tool', { id: 'custom', name: '读取验证记忆' }), false)
  assert(legacyDynamicRules.every(rule => rule.pattern.source.startsWith('^') && rule.pattern.source.endsWith('$')))
})
