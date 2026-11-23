import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { guideView } from './guide.js'
import { welcomeView } from './welcome.js'
import { initialRouteHash, isGuideIndex, isPublicRoute } from './room-shell-navigation.mjs'
import { guideProgressKey } from './guide-content.mjs'
import { initLocaleUI } from './locale.mjs'

const cases = JSON.parse(readFileSync(new URL('./demo/cases.json', import.meta.url), 'utf8'))

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = {}
    this.className = ''
    this.hidden = false
    this.id = ''
  }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item === null || item === undefined) continue
      this.children.push(item)
      if (typeof item === 'object') item.parentElement = this
    }
  }
  prepend(...items) { this.children.unshift(...items.flat(Infinity).filter(item => item !== null && item !== undefined)) }
  replaceChildren(...items) { this.children = []; this.append(...items) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) }
  dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); return true }
  focus() {}
  scrollIntoView() {}
  get textContent() { return this.children.map(item => typeof item === 'object' ? item.textContent : String(item)).join('') }
  set textContent(value) { this.children = [String(value)] }
  get isConnected() { return true }
  querySelectorAll(selector) {
    return this.children.flatMap(item => typeof item === 'object'
      ? [...(matches(item, selector) ? [item] : []), ...item.querySelectorAll(selector)]
      : [])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}

function matches(element, selector) {
  return matchParts(element, selector.trim().split(/\s+/))
}

function matchParts(element, parts) {
  if (!parts.length) return true
  if (!matchSimple(element, parts[parts.length - 1])) return false
  if (parts.length === 1) return true
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (matchParts(parent, parts.slice(0, -1))) return true
  }
  return false
}

function matchSimple(element, compound) {
  const tag = compound.match(/^([a-zA-Z][\w-]*)/)?.[0]
  if (tag && element.tagName !== tag.toUpperCase()) return false
  for (const match of compound.matchAll(/\.([\w-]+)/g)) {
    if (!element.className.split(/\s+/).includes(match[1])) return false
  }
  for (const match of compound.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
    const value = element.getAttribute(match[1])
    if (match[2] !== undefined || match[3] !== undefined) {
      if (value !== (match[2] ?? match[3])) return false
    } else if (value === null) return false
  }
  return true
}

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }
}

function installDom() {
  globalThis.document = { createElement: tag => new Element(tag) }
  globalThis.localStorage = memoryStorage()
  globalThis.location = { hash: '#/guide' }
  globalThis.fetch = async url => {
    if (url === '/demo/cases.json') return { ok: true, json: async () => cases }
    throw new Error('unexpected fetch ' + url)
  }
}

function rootOf(nodes) { const root = new Element('body'); root.append(...nodes); return root }

test('the standalone tutorial index is gone and points back to welcome', async () => {
  installDom()
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('removed index must not fetch') }
  const root = rootOf(await guideView({}, ['guide']))
  assert.match(root.textContent, /教程已并入欢迎页/)
  assert.equal(root.querySelectorAll('.guide-path-card').length, 0)
  assert.equal(root.querySelectorAll('button').some(node => node.textContent === '返回欢迎页'), true)
  assert.equal(fetches, 0)
})

test('a chapter reads the archived case, renders its collaboration and records local progress', async () => {
  installDom()
  const root = rootOf(await guideView({}, ['guide', 'update', '1']))
  assert.match(root.textContent, /新证据局部复核/)
  assert.match(root.textContent, /本章导读/)
  assert.match(root.textContent, /模拟／回放案例/)
  assert.match(root.textContent, /← 返回上一页/)
  assert.equal(root.querySelectorAll('.guide-back').length, 1)
  assert.ok(root.querySelectorAll('.guide-member').length > 0, 'researcher overview cards are rendered')
  assert.equal(root.querySelector('.guide-archive')?.tagName, 'DETAILS')
  assert.equal(root.querySelector('.guide-archive')?.open, undefined)
  assert.equal(root.querySelectorAll('.guide-step-link').length, 3)
  const current = root.querySelectorAll('.guide-step-link').find(link => link.getAttribute('aria-current') === 'step')
  assert.match(current.textContent, /2\. 新证据局部复核/)
  assert.ok(root.querySelectorAll('.cc-collab-report').length > 0, 'the recorded collaboration trace is rendered')
  assert.equal(root.querySelectorAll('.guide-actions a').length, 2)
  const saved = JSON.parse(globalThis.localStorage.getItem(guideProgressKey))
  assert.deepEqual(saved.paths.update.steps, [1])
})

test('finishing a path offers a prefilled live prediction without submitting or calling a model', async () => {
  installDom()
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('done page must not fetch') }
  const ctx = { courseRetryInput: null }
  const root = rootOf(await guideView(ctx, ['guide', 'recovery', 'done']))
  assert.match(root.textContent, /教程完成/)
  assert.match(root.textContent, /记住这三点/)
  assert.equal(fetches, 0)
  const start = root.querySelectorAll('button').find(node => node.textContent === '开始一次真实预测')
  assert.ok(start)
  const input = root.querySelector('.guide-prefill-input')
  assert.ok(input, 'the example is an editable input')
  input.value = '预测腾讯股票未来 5 个交易日会涨吗'
  start.listeners.click[0]({})
  assert.equal(globalThis.location.hash, '#/course')
  assert.deepEqual(ctx.courseRetryInput, { question: '预测腾讯股票未来 5 个交易日会涨吗', purpose: 'forecast', mode: 'preset' })
  assert.equal(JSON.parse(globalThis.localStorage.getItem(guideProgressKey)).paths.recovery.done, true)
})


function localeController() {
  const html = new Element('html')
  const doc = {
    documentElement: html,
    getElementById: () => null,
    defaultView: { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } } },
  }
  return { html, controller: initLocaleUI({ document: doc, storage: null }) }
}

test('the untouched tutorial sample follows the interface language and stages English without a request', async () => {
  installDom()
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('language and prefill must not fetch') }
  const { html, controller } = localeController()
  try {
    controller.setLocale('en', { persist: false })
    const ctx = { courseRetryInput: null }
    const root = rootOf(await guideView(ctx, ['guide', 'collaboration', 'done']))
    html.append(root)
    const input = root.querySelector('.guide-prefill-input')
    assert.equal(input.value, 'Predict Tencent stock')
    controller.setLocale('zh-CN', { persist: false })
    assert.equal(input.value, '预测腾讯股票')
    controller.setLocale('en', { persist: false })
    assert.equal(input.value, 'Predict Tencent stock')
    assert.equal(ctx.courseRetryInput, null)
    root.querySelectorAll('button').find(node => node.textContent === '开始一次真实预测').dispatchEvent({ type: 'click' })
    assert.deepEqual(ctx.courseRetryInput, { question: 'Predict Tencent stock', purpose: 'forecast', mode: 'preset' })
    assert.equal(globalThis.location.hash, '#/course')
    assert.equal(fetches, 0)
  } finally { controller.setLocale('zh-CN', { persist: false }); controller.dispose() }
})

test('tutorial language changes preserve user edits, cleared drafts, and programmatically staged text', async () => {
  installDom()
  globalThis.fetch = async () => { throw new Error('language changes must not fetch') }
  const { html, controller } = localeController()
  try {
    for (const { value, typed } of [
      { value: 'Research my own company', typed: true },
      { value: '', typed: true },
      { value: '预测腾讯股票', typed: true },
      { value: '用户自己输入的问题', typed: false },
    ]) {
      controller.setLocale('zh-CN', { persist: false })
      const ctx = { courseRetryInput: null }
      const root = rootOf(await guideView(ctx, ['guide', 'recovery', 'done']))
      html.replaceChildren(root)
      const input = root.querySelector('.guide-prefill-input')
      input.value = value
      if (typed) input.dispatchEvent({ type: 'input' })
      controller.setLocale('en', { persist: false })
      assert.equal(input.value, value)
      controller.setLocale('zh-CN', { persist: false })
      assert.equal(input.value, value)
      assert.equal(ctx.courseRetryInput, null)
      assert.equal(globalThis.location.hash, '#/guide')
    }
  } finally { controller.setLocale('zh-CN', { persist: false }); controller.dispose() }
})

test('an unknown tutorial path falls back to the index without reading demo files', async () => {
  installDom()
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('unknown path must not fetch') }
  const root = rootOf(await guideView({}, ['guide', 'missing']))
  assert.match(root.textContent, /找不到这条教程路径/)
  assert.equal(root.querySelectorAll('button').some(node => node.textContent === '返回欢迎页'), true)
  assert.equal(fetches, 0)
})

test('welcome page introduces the lab and embeds the three tutorial paths without fetching', () => {
  installDom()
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('welcome must not fetch') }
  const root = rootOf(welcomeView())
  assert.equal(root.querySelectorAll('.guide-path-card').length, 3)
  assert.match(root.textContent, /一次预测会经过这四步/)
  assert.match(root.textContent, /教程：从案例看懂研究室/)
  assert.match(root.textContent, /研究室里都有谁/)
  assert.equal(root.querySelectorAll('.welcome-person').length, 10)
  assert.equal(root.querySelectorAll('.welcome-lead').length, 1)
  assert.equal(root.querySelectorAll('.welcome-person h3').some(node => node.textContent === '预测市场研究员'), true)
  assert.equal(root.querySelectorAll('button').some(node => node.textContent === '先看教程'), true)
  assert.equal(root.querySelectorAll('a').some(link => link.href === '#/guide'), false)
  assert.equal(fetches, 0)
})

test('root locations open the welcome page while private deep links stay in the room', () => {
  for (const hash of ['', '#', '#/']) assert.equal(initialRouteHash(hash), '#/welcome')
  assert.equal(initialRouteHash('#/predictions'), '#/predictions')
  for (const hash of ['', '#/welcome', '#/guide', '#/guide/update/1']) assert.equal(isPublicRoute(hash), true)
  for (const hash of ['#/room', '#/predictions', '#/course/request-1', '#/model-connection']) assert.equal(isPublicRoute(hash), false)
  assert.equal(isGuideIndex('#/guide'), true)
  assert.equal(isGuideIndex('#/guide/'), true)
  assert.equal(isGuideIndex('#/guide/update/1'), false)
})
