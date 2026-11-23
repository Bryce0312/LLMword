import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initLocaleUI, translateUiText } from './locale.mjs'
import { evidenceCard, dataLink } from './workbench-core.js'

class FakeNode {
  constructor(document, type) { this.ownerDocument = document; this.nodeType = type; this.parentNode = null; this.parentElement = null; this.childNodes = [] }
  get isConnected() { return this.nodeType === 9 || this.parentNode?.isConnected === true }
  append(...items) {
    const addedNodes = items.map(item => typeof item === 'string' ? this.ownerDocument.createTextNode(item) : item)
    for (const item of addedNodes) { item.parentNode = this; item.parentElement = this.nodeType === 1 ? this : null; this.childNodes.push(item) }
    this.ownerDocument.record({ type: 'childList', target: this, addedNodes })
  }
  remove() {
    const parent = this.parentNode
    if (!parent) return
    parent.childNodes = parent.childNodes.filter(node => node !== this); this.parentNode = null; this.parentElement = null
    this.ownerDocument.record({ type: 'childList', target: parent, addedNodes: [] })
  }
  get textContent() { return this.nodeType === 3 ? this.raw : this.childNodes.map(node => node.textContent).join('') }
  set textContent(value) { for (const child of this.childNodes) { child.parentNode = null; child.parentElement = null } this.childNodes = []; this.append(String(value)) }
}
class FakeText extends FakeNode {
  constructor(document, value, forbidden = false) { super(document, 3); this.raw = value; this.forbidden = forbidden; this.reads = 0; this.writes = 0 }
  get data() { this.reads++; if (this.forbidden) throw new Error('Protected content must never be read'); return this.raw }
  set data(value) { if (this.forbidden) throw new Error('Protected content must never be written'); if (value !== this.raw) { this.raw = value; this.writes++; this.ownerDocument.record({ type: 'characterData', target: this }) } }
}
class FakeElement extends FakeNode {
  constructor(document, tag) { super(document, 1); this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.listeners = new Map(); this.actualValue = ''; this.dataset = new Proxy({}, { get: (_target, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())), set: (_target, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value); return true } }) }
  get value() { throw new Error('Input values must never be read by localization') }
  set value(_value) { throw new Error('Input values must never be written by localization') }
  get id() { return this.getAttribute('id') ?? '' } set id(value) { this.setAttribute('id', value) }
  get href() { return this.getAttribute('href') ?? '' } set href(value) { this.setAttribute('href', value) }
  get title() { return this.getAttribute('title') ?? '' } set title(value) { this.setAttribute('title', value) }
  get className() { return this.getAttribute('class') ?? '' } set className(value) { this.setAttribute('class', value) }
  get lang() { return this.getAttribute('lang') ?? '' } set lang(value) { this.setAttribute('lang', value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  setAttribute(name, value) { value = String(value); this.attributes.set(name, value); this.ownerDocument.record({ type: 'attributes', target: this, attributeName: name }) }
  removeAttribute(name) { if (this.attributes.delete(name)) this.ownerDocument.record({ type: 'attributes', target: this, attributeName: name }) }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler) }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler) }
  click() { for (const handler of this.listeners.get('click') ?? []) handler({ target: this }) }
  focus() { this.ownerDocument.activeElement = this }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return !event.defaultPrevented }
  matches(selector) {
    if (selector.includes(' > ')) { const [parent, child] = selector.split(' > '); return this.matches(child) && this.parentElement?.matches(parent) === true }
    if (selector.includes(' ')) { const index = selector.lastIndexOf(' '), ancestor = selector.slice(0, index), target = selector.slice(index + 1); if (!this.matches(target)) return false; for (let owner = this.parentElement; owner; owner = owner.parentElement) if (owner.matches(ancestor)) return true; return false }
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const attribute = selector.match(/^(?:([a-zA-Z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/)
    if (attribute) return (!attribute[1] || this.tagName === attribute[1].toUpperCase()) && (attribute[3] === undefined ? this.hasAttribute(attribute[2]) : this.getAttribute(attribute[2]) === attribute[3])
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) { return this.childNodes.flatMap(node => node.nodeType === 1 ? [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)] : []) }
}
class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9); this.ownerDocument = this; this.observers = []; this.callbackRounds = 0; this.activeElement = null
    const doc = this
    this.defaultView = { MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; this.active = false; doc.observers.push(this) }
      observe(root, options) { this.root = root; this.options = options; this.active = true }
      disconnect() { this.active = false; this.records = [] }
    } }
    this.documentElement = this.createElement('html'); this.head = this.createElement('head'); this.body = this.createElement('body')
    this.append(this.documentElement); this.documentElement.append(this.head, this.body)
  }
  createElement(tag) { return new FakeElement(this, tag) }
  createTextNode(value) { return new FakeText(this, value) }
  getElementById(id) { return this.documentElement.id === id ? this.documentElement : this.documentElement.querySelectorAll('#' + id)[0] ?? null }
  record(mutation) {
    if (mutation.target?.isConnected === false) return
    for (const observer of this.observers) {
      if (!observer.active || mutation.type === 'attributes' && !observer.options.attributeFilter.includes(mutation.attributeName)) continue
      observer.records.push(mutation)
    }
  }
  flush() {
    let rounds = 0
    while (this.observers.some(observer => observer.active && observer.records.length)) {
      if (++rounds > 10) throw new Error('Mutation observer self-triggered indefinitely')
      this.callbackRounds++
      for (const observer of this.observers) if (observer.active && observer.records.length) { const records = observer.records.splice(0); observer.callback(records) }
    }
    return rounds
  }
}
function element(doc, tag, text, attributes = {}) { const el = doc.createElement(tag); for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value); if (text !== undefined) el.append(text); return el }
function fixture(storage = null) {
  const doc = new FakeDocument()
  const group = element(doc, 'div', undefined, { id: 'wb-language-switch', 'data-i18n-skip': 'true', role: 'group' })
  const zh = element(doc, 'button', '简体中文', { 'data-locale': 'zh-CN' }), en = element(doc, 'button', 'English', { 'data-locale': 'en' }); group.append(zh, en)
  const room = element(doc, 'section', undefined, { id: 'room' }), form = element(doc, 'form'), input = element(doc, 'input', undefined, { placeholder: '开始预测', 'aria-label': '开始预测' })
  input.actualValue = 'USER_UNSAVED_VALUE'; form.append(input); room.append(form)
  const ui = element(doc, 'button', '开始预测'), title = element(doc, 'title', '模型连接')
  doc.head.append(title); doc.body.append(group, room, ui)
  const controller = initLocaleUI({ document: doc, storage })
  return { doc, controller, group, zh, en, room, form, input, ui, title }
}

test('English-only presentation translates saved content without changing input or original text', async () => {
  const doc = new FakeDocument()
  const source = element(doc, 'blockquote', '保存预算', { 'data-i18n-skip': 'true' })
  const newReport = element(doc, 'p', 'Price increased. 股票市场', { 'data-model-content': 'true', title: '研究备注' })
  const field = element(doc, 'textarea', undefined, { placeholder: '开始预测' })
  const draft = new FakeText(doc, '我的草稿', true)
  field.append(draft)
  const zh = element(doc, 'button', '简体中文', { 'data-locale': 'zh-CN' })
  const group = element(doc, 'div', undefined, { id: 'wb-language-switch', 'data-i18n-skip': 'true' })
  group.append(zh); doc.body.append(group, source, newReport, field)
  const translated = { '保存预算': 'Set aside the budget', 'Price increased. 股票市场': 'Price increased. Stock market', '研究备注': 'Research notes' }
  const requests = []
  doc.defaultView.Translator = {
    availability: async () => 'available',
    create: async () => ({ translate: async text => { requests.push(text); return translated[text] } }),
  }
  const ui = initLocaleUI({ document: doc, englishOnly: true })
  try {
    ui.setLocale('en'); doc.flush()
    assert.equal(source.textContent, 'Translating…')
    assert.equal(zh.textContent, 'Simplified Chinese')
    await new Promise(resolve => setImmediate(resolve)); doc.flush()
    assert.equal(source.textContent, translated['保存预算'])
    assert.equal(newReport.textContent, translated['Price increased. 股票市场'])
    assert.equal(newReport.getAttribute('title'), 'Research notes')
    assert.equal(field.getAttribute('placeholder'), 'Start prediction')
    assert.equal(draft.reads, 0)
    assert.deepEqual(requests.sort(), Object.keys(translated).sort())

    ui.setLocale('zh-CN'); doc.flush()
    assert.equal(source.textContent, '保存预算')
    assert.equal(newReport.textContent, 'Price increased. 股票市场')
    assert.equal(newReport.getAttribute('title'), '研究备注')
    assert.equal(zh.textContent, '简体中文')
  } finally { ui.dispose() }
})

test('English-only display uses an English notice when local translation is unavailable', () => {
  const doc = new FakeDocument()
  const source = element(doc, 'p', '这是原报告', { 'data-i18n-skip': 'true' })
  doc.body.append(source)
  const ui = initLocaleUI({ document: doc, englishOnly: true })
  try {
    ui.setLocale('en'); doc.flush()
    assert.equal(source.textContent, 'English translation unavailable for this text.')
    ui.setLocale('zh-CN'); doc.flush()
    assert.equal(source.textContent, '这是原报告')
  } finally { ui.dispose() }
})

test('exact UI translation preserves whitespace and leaves arbitrary source text untouched', () => {
  assert.equal(translateUiText('  开始预测\n', 'en'), '  Start prediction\n')
  assert.equal(translateUiText('模型连接', 'en'), 'Model connection')
  assert.equal(translateUiText('持续预测', 'en'), 'Continuous forecasting')
  assert.equal(translateUiText('默认只研究一次；勾选后，服务器会定时检查新信息并可能继续调用模型。', 'en'), 'Research once by default. If selected, the server checks for new information periodically and may call the model again.')
  assert.equal(translateUiText('用户关于保存预算的观点与模型报告', 'en'), '用户关于保存预算的观点与模型报告')
  assert.equal(translateUiText('开始预测', 'zh-CN'), '开始预测')
})

test('switching language edits existing text and static attributes without rebuilding room, form, inputs or handlers', () => {
  const { doc, controller, en, zh, room, form, input, ui, title, group } = fixture()
  let clicks = 0; ui.addEventListener('click', () => { clicks++ }); input.focus()
  const text = ui.childNodes[0]
  en.click(); doc.flush()
  assert.equal(ui.childNodes[0], text); assert.equal(ui.textContent, 'Start prediction'); assert.equal(title.textContent, 'Model connection')
  assert.equal(doc.getElementById('room'), room); assert.equal(room.childNodes[0], form); assert.equal(form.childNodes[0], input)
  assert.equal(input.actualValue, 'USER_UNSAVED_VALUE'); assert.equal(doc.activeElement, input)
  assert.equal(input.getAttribute('placeholder'), 'Start prediction'); assert.equal(group.getAttribute('aria-label'), 'Interface language')
  assert.equal(en.getAttribute('aria-pressed'), 'true'); assert.equal(en.textContent, 'English'); assert.equal(zh.textContent, '简体中文')
  ui.click(); assert.equal(clicks, 1)
  zh.click(); doc.flush(); assert.equal(ui.textContent, '开始预测'); assert.equal(input.getAttribute('placeholder'), '开始预测'); assert.equal(doc.documentElement.lang, 'zh-CN')
  controller.dispose()
})

test('asynchronous UI additions and external renderer updates become the latest reversible source', () => {
  const { doc, controller, en, ui } = fixture()
  en.click(); doc.flush()
  ui.textContent = '保存预算'; ui.setAttribute('title', '模型连接')
  const late = element(doc, 'p', '正在读取工作区…'); doc.body.append(late)
  doc.flush()
  assert.equal(ui.textContent, 'Save budget'); assert.equal(ui.getAttribute('title'), 'Model connection'); assert.equal(late.textContent, 'Loading workspace…')
  controller.setLocale('zh-CN'); doc.flush()
  assert.equal(ui.textContent, '保存预算'); assert.equal(ui.getAttribute('title'), '模型连接'); assert.equal(late.textContent, '正在读取工作区…')
  controller.setLocale('en'); doc.flush(); assert.equal(ui.textContent, 'Save budget')
  controller.dispose()
})

test('user history, reports, evidence, code and input values are not even read when their text matches UI words', () => {
  const { doc, controller } = fixture()
  const protectedTexts = []
  for (const [tag, attrs] of [['article', { 'data-i18n-skip': 'true', title: '保存预算' }], ['p', { class: 'wb-prewrap' }], ['pre', {}], ['code', {}], ['blockquote', {}], ['option', {}]]) {
    const node = element(doc, tag, undefined, attrs), text = new FakeText(doc, '保存预算', true); protectedTexts.push(text); node.append(text); doc.body.append(node)
  }
  const history = element(doc, 'a', undefined, { class: 'wb-task-slip' }), question = element(doc, 'strong'); const protectedQuestion = new FakeText(doc, '开始预测', true); question.append(protectedQuestion); history.append(question); doc.body.append(history); protectedTexts.push(protectedQuestion)
  const password = element(doc, 'input', undefined, { type: 'password', placeholder: '模型连接' }); password.actualValue = 'FAKE_SECRET_VALUE'; doc.body.append(password)
  const textarea = element(doc, 'textarea'); textarea.actualValue = 'FAKE_UNSAVED_REPORT'; const defaultText = new FakeText(doc, '保存预算', true); textarea.append(defaultText); doc.body.append(textarea); protectedTexts.push(defaultText)
  controller.setLocale('en'); doc.flush()
  for (const text of protectedTexts) { assert.equal(text.raw, text === protectedQuestion ? '开始预测' : '保存预算'); assert.equal(text.reads, 0) }
  assert.equal(password.actualValue, 'FAKE_SECRET_VALUE'); assert.equal(textarea.actualValue, 'FAKE_UNSAVED_REPORT')
  assert.equal(password.getAttribute('placeholder'), 'Model connection', 'only a static placeholder is eligible')
  controller.dispose()
})

test('static option opt-in cannot override an ancestor content boundary and mixed buttons protect only named attributes', () => {
  const { doc, controller } = fixture()
  const select = element(doc, 'select'), option = element(doc, 'option', '开始预测', { 'data-i18n-ui': 'true' }); select.append(option); doc.body.append(select)
  const protectedParent = element(doc, 'select', undefined, { 'data-i18n-skip': 'true' }), protectedOption = element(doc, 'option', undefined, { 'data-i18n-ui': 'true' }); const secret = new FakeText(doc, '开始预测', true); protectedOption.append(secret); protectedParent.append(protectedOption); doc.body.append(protectedParent)
  const button = element(doc, 'button', '开始预测', { title: '保存预算', 'aria-label': '模型连接', 'data-i18n-skip-attributes': 'title aria-label' }); doc.body.append(button)
  controller.setLocale('en'); doc.flush()
  assert.equal(option.textContent, 'Start prediction'); assert.equal(secret.reads, 0)
  assert.equal(button.textContent, 'Start prediction'); assert.equal(button.getAttribute('title'), '保存预算'); assert.equal(button.getAttribute('aria-label'), '模型连接')
  controller.dispose()
})

test('only locale preference is persisted; storage exceptions default safely and no networking occurs', () => {
  const writes = [], reads = [], storage = { getItem: key => { reads.push(key); return 'en' }, setItem: (key, value) => writes.push([key, value]) }
  const oldFetch = globalThis.fetch; let network = 0; globalThis.fetch = () => { network++; throw new Error('No networking allowed') }
  try {
    const { doc, controller, ui } = fixture(storage)
    assert.equal(ui.textContent, 'Start prediction'); assert.equal(doc.documentElement.lang, 'en'); assert.deepEqual(reads, ['world-lab.locale']); assert.deepEqual(writes, [])
    controller.setLocale('zh-CN'); doc.flush(); controller.setLocale('en'); doc.flush()
    assert.deepEqual(writes, [['world-lab.locale', 'zh-CN'], ['world-lab.locale', 'en']]); assert.equal(network, 0)
    controller.dispose()
    const failed = fixture({ getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } })
    assert.equal(failed.controller.getLocale(), 'zh-CN'); assert.doesNotThrow(() => failed.controller.setLocale('en')); failed.controller.dispose()
  } finally { globalThis.fetch = oldFetch }
})

test('observer converges without repeated writes and disposal releases observation and switch listeners', () => {
  const { doc, controller, en, ui } = fixture()
  en.click(); assert(doc.flush() <= 2)
  const writes = ui.childNodes[0].writes
  controller.refresh(); controller.refresh(); assert.equal(doc.flush(), 0); assert.equal(ui.childNodes[0].writes, writes)
  assert.equal(initLocaleUI({ document: doc, storage: null }), controller, 'initialization is idempotent per document')
  controller.dispose(); ui.textContent = '保存预算'; doc.flush(); en.click()
  assert.equal(ui.textContent, '保存预算'); assert.equal(doc.observers.some(observer => observer.active), false)
})

test('provider placeholders, deletion buttons and source links translate without reading their protected data', () => {
  const { doc, controller } = fixture()
  const password = element(doc, 'input', undefined, { type: 'password', placeholder: '输入自己的 DeepSeek API Key', 'aria-label': 'DeepSeek API Key' }); password.actualValue = 'FAKE_KEY_NOT_READ'
  const remove = element(doc, 'button', '删除', { class: 'wb-agent-delete', title: '删除研究员“用户姓名”', 'aria-label': '删除研究员“用户姓名”', 'data-i18n-skip-attributes': 'title aria-label' })
  const source = element(doc, 'article', undefined, { class: 'wb-evidence-item' }), link = element(doc, 'a', '查看来源原文', { href: 'https://example.invalid/original' }), sourceTitle = element(doc, 'h3')
  const protectedTitle = new FakeText(doc, '保存预算', true); sourceTitle.append(protectedTitle); source.append(sourceTitle, link)
  doc.body.append(password, remove, source); controller.setLocale('en'); doc.flush()
  assert.notEqual(password.getAttribute('placeholder'), '输入自己的 DeepSeek API Key'); assert.match(password.getAttribute('placeholder'), /API Key/i)
  assert.notEqual(remove.textContent, '删除'); assert.equal(remove.getAttribute('title'), '删除研究员“用户姓名”')
  assert.notEqual(link.textContent, '查看来源原文'); assert.equal(link.getAttribute('href'), 'https://example.invalid/original')
  assert.equal(password.actualValue, 'FAKE_KEY_NOT_READ'); assert.equal(protectedTitle.reads, 0)
  controller.dispose()
})

test('actual evidenceCard and dataLink helpers protect source words that exactly match interface labels', () => {
  const { doc, controller } = fixture()
  const previousDocument = globalThis.document
  globalThis.document = doc
  try {
    const card = evidenceCard({ title: '保存预算', text: '取消', evidenceId: '预测历史', sourceMode: 'provided', firstSeenAt: '2026-11-22T08:00:00Z', url: 'https://example.invalid/source' })
    const question = dataLink('保存预算', '#/course/saved-user-question'); question.title = '保存预算'
    doc.body.append(card, question)
    const protectedNodes = [...card.querySelectorAll('[data-i18n-skip]'), question]
    for (const element of protectedNodes) for (const text of element.childNodes) if (text.nodeType === 3) text.forbidden = true
    controller.setLocale('en'); doc.flush()
    assert.equal(card.querySelectorAll('h3')[0].textContent, '保存预算')
    assert.equal(card.querySelectorAll('p')[0].textContent, '取消')
    assert.equal(question.textContent, '保存预算'); assert.equal(question.title, '保存预算')
    assert.notEqual(card.querySelectorAll('.wb-source-link')[0].textContent, '查看来源原文')
    for (const element of protectedNodes) for (const text of element.childNodes) if (text.nodeType === 3) assert.equal(text.reads, 0)
  } finally { controller.dispose(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument }
})

test('external characterData and attribute updates replace old sources instead of being mistaken for translator writes', () => {
  const { doc, controller, ui, input } = fixture()
  controller.setLocale('en'); doc.flush()
  const sameNode = ui.childNodes[0]
  sameNode.data = '保存预算'; input.setAttribute('placeholder', '模型连接'); doc.flush()
  assert.equal(ui.childNodes[0], sameNode); assert.equal(ui.textContent, 'Save budget'); assert.equal(input.getAttribute('placeholder'), 'Model connection')
  controller.setLocale('zh-CN'); doc.flush()
  assert.equal(ui.textContent, '保存预算'); assert.equal(input.getAttribute('placeholder'), '模型连接')
  controller.dispose()
})


test('disabled history deletion actions translate both ways while question text and title remain data', () => {
  const { doc, controller } = fixture()
  const card = element(doc, 'article', undefined, { class: 'wb-task-slip' })
  const question = element(doc, 'strong', undefined, { title: '删除记录', 'data-i18n-skip': 'true' })
  const protectedQuestion = new FakeText(doc, '删除记录', true); question.append(protectedQuestion)
  const title = '请先停止持续预测，再删除这条记录。'
  const remove = element(doc, 'button', '删除记录', { class: 'wb-badge wb-history-delete', disabled: '', title, 'aria-label': '删除这条预测记录' })
  card.append(question, remove); doc.body.append(card)
  const text = remove.childNodes[0]
  controller.setLocale('en'); doc.flush()
  assert.equal(remove.textContent, 'Delete record')
  assert.equal(remove.getAttribute('title'), 'Stop continuous forecasting before deleting this record.')
  assert.equal(remove.getAttribute('aria-label'), 'Delete this prediction record')
  assert.equal(question.title, '删除记录'); assert.equal(protectedQuestion.reads, 0)
  assert.equal(remove.hasAttribute('disabled'), true); assert.equal(remove.childNodes[0], text)
  controller.setLocale('zh-CN'); doc.flush()
  assert.equal(remove.textContent, '删除记录'); assert.equal(remove.getAttribute('title'), title)
  assert.equal(remove.getAttribute('aria-label'), '删除这条预测记录')
  assert.equal(question.title, '删除记录'); assert.equal(protectedQuestion.reads, 0)
  controller.dispose()
})


test('explicit system UI escapes fallback selectors and pre blocks but never captured-content boundaries', () => {
  const {doc,controller}=fixture()
  const fallback=element(doc,'section',undefined,{class:'cc-answer'})
  const heading=element(doc,'h2',undefined)
  const system=element(doc,'span','模型连接',{'data-i18n-ui':'true'})
  const report=element(doc,'span',undefined,{'data-model-content':'true','data-i18n-ui':'true'})
  const original=new FakeText(doc,'模型连接',true);report.append(original)
  heading.append(system,report);fallback.append(heading)
  const pre=element(doc,'pre',undefined)
  const status=element(doc,'span','资料不足',{'data-i18n-ui':'true'})
  const captured=element(doc,'span',undefined,{'data-i18n-skip':'true'});const source=new FakeText(doc,'资料不足',true);captured.append(source)
  pre.append(status,captured);doc.body.append(fallback,pre)
  controller.setLocale('en');doc.flush()
  assert.equal(system.textContent,'Model connection');assert.equal(status.textContent,'Insufficient evidence')
  assert.equal(original.reads,0);assert.equal(source.reads,0)
  controller.setLocale('zh-CN');doc.flush()
  assert.equal(system.textContent,'模型连接');assert.equal(status.textContent,'资料不足')
  controller.dispose()
})

test('date metadata switches locale both ways, updates from ISO attributes and leaves captured dates alone', () => {
  const {doc,controller}=fixture()
  const raw='2026-11-23T04:00:00.000Z',timezone='America/New_York'
  const date=element(doc,'time','',{'data-i18n-date':raw,'data-i18n-timezone':timezone})
  const captured=element(doc,'div',undefined,{'data-user-content':'true'})
  const original=element(doc,'span',undefined,{'data-i18n-date':raw});const protectedDate=new FakeText(doc,'2026年11月23日',true);original.append(protectedDate);captured.append(original)
  doc.body.append(date,captured)
  const expected=locale=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(date.getAttribute('data-i18n-date')))+' ('+timezone+')'
  controller.setLocale('en');doc.flush();assert.equal(date.textContent,expected('en-US'))
  assert(!/\p{Script=Han}/u.test(date.textContent));assert.equal(protectedDate.reads,0)
  date.setAttribute('data-i18n-date','2026-12-01T04:00:00.000Z');doc.flush();assert.equal(date.textContent,expected('en-US'))
  controller.setLocale('zh-CN');doc.flush();assert.equal(date.textContent,expected('zh-CN'));assert.equal(protectedDate.reads,0)
  const node=date;controller.setLocale('en');doc.flush();assert.equal(date,node);assert.equal(doc.flush(),0)
  controller.dispose()
})

test('image alt text and accessible dynamic values translate without changing source URLs or user metadata', () => {
  const {doc,controller}=fixture()
  const image=element(doc,'img',undefined,{src:'/assets/lab-play.png',alt:'研究室',title:'研究室'})
  const meter=element(doc,'div',undefined,{'aria-valuetext':'资料不足','aria-description':'预测结果与进度'})
  const original=element(doc,'img',undefined,{'data-i18n-skip':'true',alt:'研究室',src:'USER_SOURCE_URL'})
  doc.body.append(image,meter,original);controller.setLocale('en');doc.flush()
  assert.equal(image.getAttribute('alt'),'Research room');assert.equal(image.getAttribute('src'),'/assets/lab-play.png')
  assert.equal(meter.getAttribute('aria-valuetext'),'Insufficient evidence');assert.equal(meter.getAttribute('aria-description'),'Prediction results and progress')
  assert.equal(original.getAttribute('alt'),'研究室');assert.equal(original.getAttribute('src'),'USER_SOURCE_URL')
  controller.setLocale('zh-CN');doc.flush();assert.equal(image.getAttribute('alt'),'研究室');assert.equal(meter.getAttribute('aria-valuetext'),'资料不足')
  controller.dispose()
})


test('language changes notify only connected local controls without rebuilding their inputs or using the network', () => {
  const {doc,controller,form,input}=fixture()
  form.setAttribute('data-i18n-language-control','true')
  const changes=[];form.addEventListener('world-lab:localechange',event=>changes.push(event.detail.locale))
  controller.setLocale('en');doc.flush();controller.setLocale('zh-CN');doc.flush()
  assert.deepEqual(changes,['en','zh-CN']);assert.equal(form.childNodes[0],input);assert.equal(input.actualValue,'USER_UNSAVED_VALUE')
  form.remove();controller.setLocale('en');doc.flush();assert.deepEqual(changes,['en','zh-CN'])
  controller.dispose()
})
