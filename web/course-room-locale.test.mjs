import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCourseRoom } from './workbench-course-room.js'
import { renderMemory, runRecords } from './workbench-course.js'
import { buildMemorySnapshot } from '../server/course/memory-policy.mjs'
import { createWorkbenchRoom } from './workbench-room.js'
import { createRoomScene } from './actors.js'
import { initLocaleUI, translateUiText } from './locale.mjs'
import { roomTranslations, roomDynamicRules } from './locale-zh-en-room.mjs'

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
  addEventListener() {}
  getContext() { return null }
  focus() {}
  matches(selector) { if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1)); return this.tagName === selector.toUpperCase() }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
class Document extends Node {
  constructor() { super(null, 9); this.ownerDocument = this; this.documentElement = this.createElement('html'); this.body = this.createElement('body'); this.append(this.documentElement); this.documentElement.append(this.body); this.defaultView = {} }
  createElement(tag) { return new Node(this, 1, tag) }
  createTextNode(text) { const node = new Node(this, 3); node.data = text; return node }
  getElementById() { return null }
}
function withRoom(exercise) {
  const previous = globalThis.document
  const doc = new Document(); globalThis.document = doc
  const root = doc.createElement('section'); doc.body.append(root)
  const locale = initLocaleUI({ document: doc, storage: null })
  let room
  try { exercise({ root, locale, setRoom: value => { room = value } }) }
  finally { room?.destroy(); locale.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
}
const role = (root, id) => root.querySelectorAll('.cc-work-card').find(node => node.dataset.role === id)
const update = (locale) => { locale.setLocale('en', { persist: false }); locale.refresh() }

test('course room translates generated labels, canonical names and tools while preserving custom names and reports', () => withRoom(({ root, locale, setRoom }) => {
  const room = createCourseRoom(root, { onShowResults() {} }); setRoom(room)
  const emit = effect => room.apply({ runId: 'run', generation: 1, ...effect })
  emit({ type: 'reset' })
  emit({ type: 'team', team: [
    { roleId: 'supervisor', name: '主 Agent' },
    { roleId: 'official', name: '官方资料研究员', objective: '保存预算', reason: '模型连接' },
    { roleId: 'custom', name: '模型连接' },
  ] })
  room.setPredictionProgress(42, '研究员独立调查')
  update(locale)
  assert.equal(role(root, 'official').querySelector('strong').textContent, roomTranslations['官方资料研究员'])
  assert.equal(root.querySelector('.cc-board-meter').getAttribute('aria-valuetext'), '42%, Independent research')
  assert.equal(role(root, 'official').querySelector('p').textContent, '保存预算')
  assert.equal(role(root, 'custom').querySelector('strong').textContent, '模型连接')
  assert.equal(role(root, 'supervisor').querySelector('p').textContent, roomTranslations['整理问题、选择研究员与汇总公开报告'])
  assert.equal(role(root, 'official').querySelector('.cc-work-reason').querySelector('span').textContent, '模型连接')
  emit({ type: 'tool', roleId: 'official', toolId: 'search_web', status: 'ok', summary: '保存预算' })
  update(locale)
  const tools = root.querySelector('.wb-room-tools')
  assert(tools.textContent.includes(roomTranslations['搜索公开资料']))
  assert(tools.textContent.includes('保存预算'))
  assert(!tools.textContent.includes('已取得返回'))
  emit({ type: 'phase', summary: '本轮判断已提交', ui: true }); update(locale)
  assert.equal(root.querySelector('.wb-room-phase').textContent, roomTranslations['本轮判断已提交'])
  emit({ type: 'phase', summary: '模型连接' }); update(locale)
  assert.equal(root.querySelector('.wb-room-phase').textContent, '模型连接')
  emit({ type: 'speech', roleId: 'official', status: 'complete', summary: '保存预算', evidenceIds: ['e'] }); update(locale)
  assert.equal(root.querySelector('.wb-room-bubble').querySelector('p').textContent, '保存预算')
  assert(root.querySelector('.wb-room-bubble').querySelector('small').textContent.startsWith('1 sources'))
  locale.setLocale('zh-CN', { persist: false })
  assert.equal(role(root, 'official').querySelector('strong').textContent, '官方资料研究员')
  assert.equal(root.querySelector('.wb-room-bubble').querySelector('p').textContent, '保存预算')
}))

test('advanced room separates statuses from the original name, evidence report and tool response', () => withRoom(({ root, locale, setRoom }) => {
  const room = createWorkbenchRoom(root); setRoom(room)
  room.setRole({ agentSpecId: 'custom', name: '模型连接' }, { runId: 'run' })
  room.apply({ type: 'room.reset', generation: 1 })
  room.apply({ type: 'bubble', runId: 'run', generation: 1, tone: 'success', message: '保存预算', evidenceIds: [], minVisibleMs: 0 })
  room.apply({ type: 'tool', runId: 'run', generation: 1, tool: { toolId: '模型连接', status: 'complete', success: true, summary: '保存预算' } })
  update(locale)
  assert.equal(root.querySelector('.wb-worker-name').textContent, '模型连接')
  assert.equal(root.querySelector('.wb-room-bubble').querySelector('p').textContent, '保存预算')
  assert.equal(root.querySelector('.wb-room-bubble').querySelector('strong').textContent, '模型连接 · ' + roomTranslations['研读完成'])
  assert.equal(root.querySelector('.wb-room-tools').textContent, '模型连接 · ' + roomTranslations['已取得结果'] + '：保存预算')
  assert.equal(root.querySelector('.wb-worker').getAttribute('aria-label'), 'View the definition of 模型连接')
}))

test('room UI templates keep counts and have no catch-all rule for free-form content', () => {
  const translate = value => {
    if (Object.hasOwn(roomTranslations, value)) return roomTranslations[value]
    const rule = roomDynamicRules.find(rule => rule.pattern.test(value))
    return rule ? value.replace(rule.pattern, rule.replace) : value
  }
  assert.equal(translate('调查周期 2 · 模型 3 / 10 次 · 工具 4 / 20 次'), 'Research cycle 2 · Model calls 3 / 10 · Tool calls 4 / 20')
  assert.equal(translate('模型 未记录 次 · 工具 0 次'), 'Model calls Not recorded · Tool calls 0')
  assert.equal(translate('第 2 个调查周期 · 3 位子 Agent 正在独立调查；主 Agent 等待报告（2 位等待模型返回）'), 'Research cycle 2 · 3 researchers investigating independently; lead agent awaiting reports (2 waiting for model responses)')
  assert.equal(translate('第 2 个调查周期 · 用户自己的调查结论'), '第 2 个调查周期 · 用户自己的调查结论')
  assert.equal(translate('模型连接是用户自己的名字'), '模型连接是用户自己的名字')
  assert.equal(translateUiText('第 3 次模型判断 · 已返回', 'en'), 'Model assessment 3 · Response received')
  for (const rule of roomDynamicRules) { assert(rule.pattern.source.startsWith('^')); assert(rule.pattern.source.endsWith('$')) }
})


test('advanced room translates a canonical role plus display version while preserving custom names', () => withRoom(({ root, locale, setRoom }) => {
  const room = createWorkbenchRoom(root); setRoom(room)
  room.setRole({ agentSpecId: 'official', name: '官方资料研究员 v1' }, { runId: 'run' })
  update(locale)
  const actor = root.querySelector('.wb-worker')
  assert.equal(root.querySelector('.wb-worker-name').textContent, 'Official sources researcher v1')
  assert.equal(actor.getAttribute('aria-label'), 'View the definition of Official sources researcher v1')
  locale.setLocale('zh-CN', { persist: false })
  assert.equal(root.querySelector('.wb-worker-name').textContent, '官方资料研究员 v1')
  assert.equal(actor.getAttribute('aria-label'), '查看研究员定义：官方资料研究员 v1')
  room.setRole({ agentSpecId: 'custom', name: '官方资料研究员 v1' }, { runId: 'other' })
  update(locale)
  assert.equal(root.querySelector('.wb-worker-name').textContent, '官方资料研究员 v1')
  assert.equal(actor.getAttribute('aria-label'), 'View the definition of 官方资料研究员 v1')
  assert.equal(actor.getAttribute('data-i18n-data-attributes'), 'aria-label')
}))

test('legacy actor attributes translate UI prefixes and known roles and built-in nicknames', () => withRoom(({ root, locale, setRoom }) => {
  const previous = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { observe() {} }
  try {
    const doc = root.ownerDocument
    const layer = doc.createElement('div'), speaker = doc.createElement('section'), speakerName = doc.createElement('strong'), speakerText = doc.createElement('p'), speakerKind = doc.createElement('small'), status = doc.createElement('span')
    speaker.append(speakerName, speakerText, speakerKind); root.append(layer, speaker, status)
    const scene = createRoomScene({ layer, speaker, speakerName, speakerText, speakerKind, status, onAgent() {}, onActivity() {}, onAnnouncement() {} })
    setRoom({ destroy: () => scene.resetStream() })
    const agents = [
      { id: 'policy', name: '小策', englishName: 'Xiao Ce', role: '政策研究', english: 'Policy research' },
      { id: 'supply', name: '小链', englishName: 'Xiao Lian', role: '供应链研究', english: 'Supply-chain research' },
      { id: 'company', name: '小财', englishName: 'Xiao Cai', role: '公司基本面', english: 'Company fundamentals' },
      { id: 'market', name: '小盘', englishName: 'Xiao Pan', role: '市场研究', english: 'Market research' },
      { id: 'chair', name: '主持人', englishName: 'Chair', role: '会议主持', english: 'Meeting chair' },
    ]
    scene.setAgents(agents); update(locale)
    for (const agent of agents) {
      const actor = layer.querySelectorAll('.world-actor').find(node => node.dataset.agent === agent.id)
      assert.equal(actor.title, agent.englishName + ' · ' + agent.english, 'the role is really English, not merely ignored by an audit marker')
      assert.equal(actor.getAttribute('aria-label'), 'View the researcher profile for ' + agent.englishName)
      assert.equal(actor.getAttribute('data-i18n-data-attributes'), 'title aria-label')
    }
    locale.setLocale('zh-CN', { persist: false })
    assert.equal(layer.querySelectorAll('.world-actor')[0].title, '小策 · 政策研究')
    scene.setAgents([{ id: 'policy', name: '自定义昵称', role: '模型连接' }]); update(locale)
    const custom = layer.querySelectorAll('.world-actor')[0]
    assert.equal(custom.title, '自定义昵称 · 模型连接', 'custom role text is original data')
    assert.equal(custom.getAttribute('aria-label'), 'View the researcher profile for 自定义昵称')
  } finally { if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous }
}))


test('course memory renders translated program scope while preserving model summaries and arbitrary historical prose', () => withRoom(({ root, locale }) => {
  const memory = buildMemorySnapshot({ requestId: 'q', asOf: '2026-11-23T00:00:00Z' })
  const run = { memory, triage: { kind: 'initial', reason: '首次按题选择差异职责。' } }
  const before = structuredClone(run)
  renderMemory(root, run, { evidence: [] }); update(locale)
  assert.match(root.textContent, /Historical memory: 0 substantive judgments/u)
  assert.match(root.textContent, /The initial team is selected for distinct responsibilities/u)
  assert.doesNotMatch(root.textContent, /历史记忆：|首次按题选择/u)
  locale.setLocale('zh-CN', { persist: false })
  assert(root.textContent.includes(memory.summary))
  assert.deepEqual(run, before)
  const original = { memory: { ...memory, summary: '保存预算' }, triage: { kind: 'local', reason: '模型连接' }, forecast: { summary: '删除记录' } }
  renderMemory(root, original, { evidence: [] }); update(locale)
  for (const text of ['保存预算', '模型连接', '删除记录']) assert(root.textContent.includes(text), text)
  assert.equal(root.querySelectorAll('[data-i18n-skip]').filter(node => ['保存预算', '模型连接', '删除记录'].includes(node.textContent)).length, 3)
}))

test('budget closeout speech is English and reversible while later model speech retains its data boundary', () => withRoom(({ root, locale, setRoom }) => {
  const room = createCourseRoom(root); setRoom(room)
  const emit = effect => room.apply({ runId: 'r', generation: 1, ...effect })
  emit({ type: 'reset' }); emit({ type: 'team', team: [{ roleId: 'official', name: '官方资料研究员' }] })
  const receipt = '执行器预算收尾回执：本研究员已取得2项资料，但未在本次额度内完成有效判断。以下资料供主Agent整理，不代表完整研究报告或已验证概率。'
  emit({ type: 'speech', roleId: 'official', status: 'insufficient', summary: receipt })
  update(locale)
  const body = root.querySelector('.wb-room-bubble').querySelector('p')
  assert.match(body.textContent, /^Executor budget close-out receipt: this researcher obtained 2 materials/u)
  assert.doesNotMatch(body.textContent, /\p{Script=Han}/u)
  locale.setLocale('zh-CN', { persist: false }); assert.equal(body.textContent, receipt)
  emit({ type: 'speech', roleId: 'official', status: 'complete', summary: '保存预算' }); update(locale)
  assert.equal(body.textContent, '保存预算')
  assert.equal(body.querySelector('span').getAttribute('data-i18n-skip'), 'true')
}))


test('execution records translate canonical memory and budget receipts while preserving free-form event prose', () => withRoom(({ root, locale }) => {
  const memory = buildMemorySnapshot({ requestId: 'q', asOf: '2026-11-23T00:00:00Z' })
  const receipt = '执行器预算收尾回执：本研究员已取得4项资料，但未在本次额度内完成有效判断。以下资料供主Agent整理，不代表完整研究报告或已验证概率。'
  const run = { runId: 'r', status: 'completed', events: [
    { type: 'memory.loaded', payload: { memory } },
    { type: 'watch.triaged', payload: { triage: { reason: '首次按题选择差异职责。' } } },
    { type: 'assignment.completed', payload: { summary: receipt, agentSpecId: 'official' } },
    { type: 'meeting.message', payload: { summary: '保存预算' } },
    { type: 'assignment.completed', payload: { summary: '模型连接' } },
  ] }
  const before = structuredClone(run)
  root.append(runRecords(run)); update(locale)
  assert.match(root.textContent, /Historical memory: 0 substantive judgments/u)
  assert.match(root.textContent, /Executor budget close-out receipt: this researcher obtained 4 materials/u)
  assert.match(root.textContent, /The initial team is selected for distinct responsibilities/u)
  assert(root.textContent.includes('保存预算')); assert(root.textContent.includes('模型连接'))
  assert.deepEqual(run, before)
  locale.setLocale('zh-CN', { persist: false }); assert(root.textContent.includes(receipt)); assert(root.textContent.includes(memory.summary))
}))
