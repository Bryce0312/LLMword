import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initLocaleUI, translateUiText } from './locale.mjs'
import { agentForm } from './workbench-forms.js'
import { courseExamples } from './course-examples.js'
import { sidebar } from './workbench-views.js'
import { confirmationDialog } from './confirmation-dialog.js'
import { courseProviderPresentation, courseProviderError } from './course-provider.mjs'
import { agentDeletionError } from './agent-deletion.mjs'
import { researchPricingPresentation } from './research-settings-model.mjs'
import { getAgentCatalog, getToolCatalog } from '../server/domain/agent-catalog.mjs'
import { FINANCE_METHODS } from '../server/course/research-profiles.mjs'
import { INVESTIGATION_METHODS } from '../server/course/investigation-profiles.mjs'
import { workspaceTranslations, workspaceDynamicRules, isWorkspaceBuiltinText } from './locale-zh-en-workspace.mjs'

class Node {
  constructor(doc, type, tag = '') { this.ownerDocument = doc; this.nodeType = type; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = new Map(); this.hidden = false; this.style = { setProperty() {} }; this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, s => '-' + s.toLowerCase())), set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, s => '-' + s.toLowerCase()), value); return true } }); this.classList = { contains: cls => this.className.split(/\s+/).includes(cls), add: (...classes) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...classes])].join(' ') }, remove: (...classes) => { this.className = this.className.split(/\s+/).filter(cls => !classes.includes(cls)).join(' ') }, toggle: (cls, force) => { const enable = force ?? !this.classList.contains(cls); this.classList[enable ? 'add' : 'remove'](cls); return enable } } }
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
  focus() { this.ownerDocument.activeElement = this }
  matches(selector) { if (selector === '*') return true; if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1)); return this.tagName === selector.toUpperCase() }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
class Document extends Node {
  constructor() { super(null, 9); this.ownerDocument = this; this.documentElement = this.createElement('html'); this.body = this.createElement('body'); this.append(this.documentElement); this.documentElement.append(this.body); this.defaultView = {} }
  createElement(tag) { return new Node(this, 1, tag) }
  createTextNode(text) { const node = new Node(this, 3); node.data = text; return node }
  getElementById(id) { return this.querySelectorAll('*').find(node => node.id === id) ?? null }
}

async function withWorkspace(exercise) {
  const previous = { document: globalThis.document, window: globalThis.window, location: globalThis.location }
  const doc = new Document(); globalThis.document = doc
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.location = { hash: '#/course/request-one', origin: 'http://localhost' }
  const locale = initLocaleUI({ document: doc, storage: null })
  try { await exercise({ doc, locale }) }
  finally { locale.dispose(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
}

test('factory researcher and tool UI translates while edited names, form values, IDs and custom options retain their original text', async () => withWorkspace(({ doc, locale }) => {
  const a = getAgentCatalog()[0], tools = getToolCatalog(), customTool = { toolId: 'custom', name: '保存预算' }
  const cache = { tools: [...tools, customTool] }
  const builtin = agentForm(cache, a, () => {})
  const edited = agentForm(cache, { ...a, name: '模型连接', description: '保存预算' }, () => {})
  const custom = agentForm(cache, { ...a, origin: 'custom', agentSpecId: 'custom-role', name: a.name }, () => {})
  doc.body.append(builtin, edited, custom)
  const nameInput = builtin.querySelectorAll('input').find(node => node.name === 'name')
  assert.equal(nameInput.value, a.name)
  Object.defineProperty(nameInput, 'value', { get() { throw new Error('translator must not read editable values') } })
  locale.setLocale('en', { persist: false })
  assert.equal(builtin.querySelector('h2').textContent, 'Official sources researcher')
  assert(builtin.textContent.includes('List provided sources'))
  assert(builtin.textContent.includes('list_provided_sources'))
  assert(builtin.textContent.includes('保存预算'), 'custom tool name matching UI text stays original')
  assert.equal(edited.querySelector('h2').textContent, '模型连接')
  assert(edited.textContent.includes('保存预算'))
  assert.equal(custom.querySelector('h2').textContent, a.name)
  const options = builtin.querySelectorAll('option')
  assert(options.some(node => node.value === tools[0].toolId && node.textContent === 'List provided sources'))
  assert(options.some(node => node.value === 'custom' && node.textContent === '保存预算'))
  const textarea = builtin.querySelector('textarea'); assert.equal(textarea.value, a.instructions)
  locale.setLocale('zh-CN', { persist: false })
  assert.equal(builtin.querySelector('h2').textContent, a.name)
  assert.equal(textarea.value, a.instructions)
}))

test('structured deletion confirmation translates the operation and warnings while preserving the exact subject through language changes', async () => withWorkspace(async ({ doc, locale }) => {
  const trigger = doc.createElement('button'); doc.body.append(trigger)
  const pending = confirmationDialog('确认删除研究员“模型连接”？\n\n确认后，该席位不再用于新任务；已保存的历史定义、运行与报告保留。\n\n删除后将缺少核验席，新预测无法启动。', { trigger, subject: { kind: 'researcher', name: '模型连接' } })
  const dialog = doc.body.querySelector('dialog')
  locale.setLocale('en', { persist: false })
  assert(dialog.textContent.includes('Delete researcher “模型连接”?'))
  assert(dialog.textContent.includes('New predictions will not be able to start.'))
  assert(dialog.textContent.includes('After confirmation, this researcher will no longer be used for new tasks. Saved definitions, runs and reports are retained.'))
  assert.equal(dialog.querySelector('.wb-confirm-dialog-name').textContent, '模型连接')
  assert(dialog.querySelector('.wb-confirm-dialog-name').hasAttribute('data-i18n-skip'))
  locale.setLocale('zh-CN', { persist: false })
  assert.equal(doc.body.querySelector('dialog'), dialog, 'the pending dialog is not rebuilt')
  assert(dialog.textContent.includes('确认删除研究员“模型连接”？'))
  dialog.querySelectorAll('button').find(node => node.className === 'wb-button').click()
  assert.equal(await pending, false)
}))

test('history UI translates timestamps and controls without translating a saved question equal to UI text', async () => withWorkspace(({ doc, locale }) => {
  doc.body.dataset.roomShell = 'true'
  const at = '2026-11-23T03:00:00.000Z'
  const record = { requestId: 'request-one', question: '模型连接', updatedAt: at, createdAt: at, timezone: 'Asia/Hong_Kong', status: 'failed', latestRunId: 'run-one', latestRun: { runId: 'run-one', status: 'failed' }, runs: [], activeRunId: null, watch: { known: {}, checks: 0 } }
  const ctx = { cache: { courseRequests: [record], predictions: [], topics: [] }, projection: { runs: {} } }
  const container = doc.createElement('section'); container.append(...sidebar(ctx)); doc.body.append(container)
  const question = container.querySelector('strong'), title = question.title
  locale.setLocale('en', { persist: false })
  assert.equal(question.textContent, '模型连接'); assert.equal(question.title, title)
  assert(container.textContent.includes('Created'))
  assert(container.textContent.includes('Nov 23, 2026'))
  assert(!container.textContent.includes('创建于'))
  assert(container.textContent.includes('Delete record'))
  locale.setLocale('zh-CN', { persist: false })
  assert(container.textContent.includes('创建于'))
  assert.equal(container.querySelector('strong'), question)
}))

test('provider state and errors, version templates and fixed method metadata have English coverage without changing real model data', () => {
  const values = [{}, { locked: true }, { configured: true, connection: 'connected', keySource: 'session', activeRuns: 0, activeWatchers: 0, canUpdate: true }, { configured: true, connection: 'failed', activeRuns: 3, activeWatchers: 0 }, { configured: true, activeRuns: 0, activeWatchers: 2 }, { configured: false, activeRuns: 0, activeWatchers: 2 }]
  for (const value of values) for (const key of ['label', 'sourceLabel', 'taskState', 'actionHint', 'verificationHint']) assert(!/\p{Script=Han}/u.test(translateUiText(courseProviderPresentation(value)[key])), key + ': ' + courseProviderPresentation(value)[key])
  for (const error of [{}, { code: 'MODE_LOCKED' }, { code: 'PROVIDER_UPDATE_BUSY' }, { status: 409 }, { status: 400 }, { status: 401 }, { status: 404 }]) assert(!/\p{Script=Han}/u.test(translateUiText(courseProviderError(error))))
  for (const error of [{ code: 'AGENT_DELETE_INVALID_VERSION' }, { code: 'AGENT_DELETE_UNCONFIRMED' }, { status: 404 }, {}]) assert(!/\p{Script=Han}/u.test(translateUiText(agentDeletionError(error))))
  for (const method of [...Object.values(FINANCE_METHODS), ...Object.values(INVESTIGATION_METHODS)]) assert(!/\p{Script=Han}/u.test(translateUiText(method)))
  for (const text of ['当前契约 v13，旧运行保留原契约。', '定义版本 v7', '本题可读 5 份材料，每轮最多 12 份。', '2 个案例：可查看实际报告、工具、来源和限制。']) assert(!/\p{Script=Han}/u.test(translateUiText(text)))
  assert.equal(isWorkspaceBuiltinText('role', { ...getAgentCatalog()[0], name: '模型连接' }), false)
  const pricing = researchPricingPresentation({ model: 'DeepSeek-V4-Flash', pricing: { model: 'DeepSeek-V4-Flash', status: 'available', currency: 'USD', unitTokens: 1000000, inputCacheHit: .1, inputCacheMiss: .2, output: .3 } })
  assert.equal(pricing.model, 'DeepSeek-V4-Flash'); assert.equal(pricing.rows[0].values, '0.1 / 0.2 / 0.3')
  assert(!Object.hasOwn(workspaceTranslations, 'DeepSeek-V4-Flash'))
  assert(workspaceDynamicRules.every(rule => rule.pattern.source.startsWith('^') && rule.pattern.source.endsWith('$')))
})


test('example run metrics render fully in English while archived case text and labels remain original', async () => withWorkspace(async ({ doc, locale }) => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ notAccuracyBenchmark: true, description: '保存预算', cases: [{ id: 'example', title: '模型连接', question: '保存预算', purpose: 'forecast', mode: 'mock', checks: [], metrics: { runs: 2, forecasts: 1, modelRequests: 4, toolCalls: 6 }, snapshots: [{ label: '模型连接', collaboration: null }] }] }) })
  try {
    const root = doc.createElement('section'); root.append(...await courseExamples({ finance: true })); doc.body.append(root)
    locale.setLocale('en', { persist: false })
    const metrics = root.querySelector('.wb-muted').textContent
    assert(metrics.includes('2 runs')); assert(metrics.includes('4 model calls')); assert(!/\p{Script=Han}/u.test(metrics))
    assert.equal(root.querySelector('h2').textContent, '模型连接')
    assert(root.textContent.includes('保存预算'))
  } finally { if (previous === undefined) delete globalThis.fetch; else globalThis.fetch = previous }
}))
