import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseBoard, courseStartForm, courseWatchEnabled } from './workbench-course.js'
import { sidebar } from './workbench-views.js'
import { agentForm } from './workbench-forms.js'
import { initLocaleUI } from './locale.mjs'

// Only DOM operations used by the actual entry form; no browser, network or model.
class FormElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this.className = '' }
  append(...items) { for (const item of items) { this.children.push(item); if (typeof item === 'object') item.parentElement = this } }
  prepend(...items) { this.children.unshift(...items); for (const item of items) if (typeof item === 'object') item.parentElement = this }
  replaceChildren(...items) { this.children = []; this.append(...items) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) }
  dispatchEvent(event) { for (const handler of this.listeners[event.type] ?? []) handler(event); return true }
  async fire(name) { for (const handler of this.listeners[name] ?? []) await handler({ preventDefault() {}, target: this }) }
  get textContent() { return this.children.map(item => typeof item === 'object' ? item.textContent : String(item)).join('') }
  set textContent(value) { this.children = [String(value)] }
  get isConnected() { return this.tagName === 'BODY' || this.parentElement?.isConnected === true }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    if (selector === '[data-field-error]') return this.dataset.fieldError !== undefined
    const error = selector.match(/^\[data-field-error="([^"]+)"\]$/)
    if (error) return this.dataset.fieldError === error[1]
    const attribute = selector.match(/^\[([\w-]+)="([^"]*)"\]$/)
    if (attribute) return this.getAttribute(attribute[1]) === attribute[2]
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) { return this.children.flatMap(item => typeof item === 'object' ? [...(item.matches(selector) ? [item] : []), ...item.querySelectorAll(selector)] : []) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  scrollIntoView() {}
}

async function withEntry({ prior, financial = true, supported = true, englishSupported = true, board = false, roomShell = false, courseRequests = [] } = {}, exercise) {
  const saved = Object.fromEntries(['document', 'FormData', 'fetch', 'location', 'CSS', 'setTimeout', 'dispatchEvent'].map(key => [key, globalThis[key]]))
  const timers = []
  const body = new FormElement('body'); body.dataset = { financialEntry: String(financial), hideStrictMode: 'true', roomShell: String(roomShell) }
  globalThis.document = { body, createElement: tag => new FormElement(tag), getElementById: id => body.querySelector('#' + id) }
  globalThis.FormData = class { constructor(form) { this.entries = form.querySelectorAll('input').concat(form.querySelectorAll('textarea'), form.querySelectorAll('select')).filter(el => el.name && !el.disabled && (el.type !== 'checkbox' || el.checked)).map(el => [el.name, el.value]) } [Symbol.iterator]() { return this.entries[Symbol.iterator]() } get(name) { return this.entries.find(entry => entry[0] === name)?.[1] ?? null } getAll(name) { return this.entries.filter(entry => entry[0] === name).map(entry => entry[1]) } }
  globalThis.location = { hash: '', origin: 'http://localhost' }
  globalThis.CSS = { escape: String }
  globalThis.dispatchEvent = () => true
  globalThis.setTimeout = (...args) => { const timer = saved.setTimeout(...args); timers.push(timer); return timer }
  const writes = []
  globalThis.fetch = async (url, options) => {
    writes.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ requestId: 'isolated-form-request', status: 'queued' }) }
  }
  const capability = { available: true, kind: 'available', config: { ...(supported ? { tradingDayHorizons: { options: [1, 3, 5, 20], default: 5, defaultMarket: 'HK' } } : {}), ...(englishSupported ? { outputLanguages: ['zh-CN', 'en'] } : {}) } }
  const ctx = { courseRetryInput: prior, courseFreshRequests: new Set(), cache: { config: {}, courseRequests, predictions: [], topics: [], courseCapability: capability },
    checkCourseCapability: async () => ctx.cache.courseCapability, setCourseCapability: value => { ctx.cache.courseCapability = value }, refreshSidebar() {} }
  try {
    const panel = board ? courseBoard(ctx) : courseStartForm(ctx); body.append(...(Array.isArray(panel) ? panel : [panel]))
    const toast = new FormElement('div'); toast.id = 'wb-toast'; body.append(toast)
    await exercise({ form: body.querySelector('form'), root: body, ctx, writes })
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  }
}

test('financial entry submits supported trading-day choices and preserves recovery semantics', async t => {
  await t.test('one named security input submits the selected default without hidden purpose or strict fields', async () => withEntry({ board: true }, async ({ form, root, writes }) => {
    assert.equal(root.querySelector('h1').textContent, '写下一个你想预测的股票')
    assert.equal(root.querySelector('.wb-page-heading').querySelector('p').textContent, '主 Agent 按题选择研究员，查来源、讨论并生成预测结果')
    assert.equal(form.querySelector('h2'), null)
    assert.equal(form.querySelectorAll('input').filter(control => control.type !== 'checkbox').length, 1)
    assert.equal(form.querySelectorAll('select').length, 0)
    assert.equal(form.querySelectorAll('textarea').length, 0)
    const security = form.querySelector('input')
    assert.equal(security.getAttribute('aria-labelledby'), root.querySelector('h1').id)
    const chips = form.querySelectorAll('.cc-time-chip')
    assert.deepEqual(chips.map(chip => chip.dataset.tradingDays), [1, 3, 5, 20])
    assert.equal(chips[2].getAttribute('aria-pressed'), 'true')
    security.value = '  00700.HK  '
    await form.fire('submit')
    assert.deepEqual(writes, [{ url: '/api/v1/course/requests', body: { outputLanguage: 'zh-CN', purpose: 'forecast', question: '00700.HK', mode: 'preset', watch: false, horizonTradingDays: 5 } }])
  }))
  await t.test('all four buttons send trading days rather than hours', async () => {
    for (const days of [1, 3, 5, 20]) await withEntry({}, async ({ form, writes }) => {
      form.querySelector('input').value = '腾讯控股'
      await form.querySelectorAll('.cc-time-chip').find(chip => chip.dataset.tradingDays === days).fire('click')
      await form.fire('submit')
      assert.equal(writes[0].body.horizonTradingDays, days)
      assert.equal('horizonHours' in writes[0].body, false)
    })
  })
  await t.test('unsupported running service blocks even programmatic submit without losing input', async () => withEntry({ supported: false }, async ({ form, ctx, writes }) => {
    assert.equal(form.querySelector('h2').textContent, '写下一个你想预测的股票')
    assert.equal(form.querySelector('input').getAttribute('aria-labelledby'), form.querySelector('h2').id)
    form.querySelector('input').value = '阿里巴巴'
    assert.equal(form.querySelector('.cc-start').disabled, true)
    await form.fire('submit')
    assert.equal(writes.length, 0)
    assert.equal(form.querySelector('input').value, '阿里巴巴')
    assert.equal(ctx.cache.courseCapability.available, true, 'local trading guard must not rewrite global capability')
    assert.match(form.querySelector('.cc-capability-notice').textContent, /重启当前服务/)
  }))
  await t.test('a historical research retry stays research without acquiring a forecast window', async () => withEntry({ prior: { purpose: 'research', question: '核验腾讯财报', mode: 'preset' }, supported: false }, async ({ form, writes }) => {
    assert.equal(form.querySelector('.cc-duration').hidden, true)
    await form.fire('submit')
    assert.deepEqual(writes[0].body, { outputLanguage: 'zh-CN', purpose: 'research', question: '核验腾讯财报', mode: 'preset', watch: false })
  }))
  await t.test('trading retry restores its window and unchanged market, changing security triggers recognition again', async () => {
    const prior = { question: '00700.HK', purpose: 'forecast', horizonTradingDays: 3, tradingHorizon: { market: 'HK' }, mode: 'strict', strict: { resolutionRule: 'old hidden rule' } }
    for (const [question, expectedMarket] of [['00700.HK', 'HK'], ['NVDA（美股）', undefined]]) await withEntry({ prior }, async ({ form, writes }) => {
      form.querySelector('input').value = question
      await form.fire('submit')
      assert.equal(writes[0].body.horizonTradingDays, 3)
      assert.equal(writes[0].body.market, expectedMarket)
      assert.equal(writes[0].body.mode, 'preset')
      assert.equal('strict' in writes[0].body, false)
    })
  })
  await t.test('removing financial flag restores the original hourly entry contract', async () => withEntry({ financial: false, supported: false }, async ({ form, writes }) => {
    form.querySelector('textarea').value = '未来48小时是否下雨？'
    assert.ok(form.querySelector('select'))
    await form.fire('submit')
    assert.equal(writes[0].body.horizonHours, 48)
    assert.equal('horizonTradingDays' in writes[0].body, false)
  }))
})

test('monitoring is optional and explicitly opted into for forecasts only', async t => {
  await t.test('new predictions start unchecked and send watch false', async () => withEntry({}, async ({ form, writes }) => {
    const watch = form.querySelector('#field-watch')
    assert.equal(watch.checked, false)
    assert.equal(watch.disabled, false)
    form.querySelector('input').value = 'NVDA（美股）'
    await form.fire('submit')
    assert.equal(writes[0].body.watch, false)
  }))
  await t.test('checking the option is the only new-form opt in', async () => withEntry({}, async ({ form, writes }) => {
    const watch = form.querySelector('#field-watch'); watch.checked = true; await watch.fire('change')
    form.querySelector('input').value = '00700.HK'
    await form.fire('submit')
    assert.equal(writes[0].body.watch, true)
  }))
  await t.test('research hides monitoring and submits false, then restores the forecast choice on switching back', async () => withEntry({ financial: false }, async ({ form, writes }) => {
    const watch = form.querySelector('#field-watch'), purpose = form.querySelector('select')
    watch.checked = true; await watch.fire('change')
    purpose.value = 'research'; await purpose.fire('change')
    assert.equal(form.querySelector('.cc-watch-choice').hidden, true)
    assert.equal(watch.disabled, true)
    assert.equal(watch.checked, false)
    purpose.value = 'forecast'; await purpose.fire('change')
    assert.equal(watch.disabled, false); assert.equal(watch.checked, true)
    purpose.value = 'research'; await purpose.fire('change')
    // Even changing a hidden control programmatically cannot enable research monitoring.
    watch.checked = true
    form.querySelector('textarea').value = '核验财报'
    await form.fire('submit')
    assert.equal(writes[0].body.purpose, 'research')
    assert.equal(writes[0].body.watch, false)
  }))
  await t.test('copied tasks preserve an explicit monitoring choice', async () => {
    for (const selected of [false, true]) await withEntry({ prior: { purpose: 'forecast', question: '00700.HK', watch: selected } }, async ({ form, writes }) => {
      assert.equal(form.querySelector('#field-watch').checked, selected)
      await form.fire('submit')
      assert.equal(writes[0].body.watch, selected)
    })
  })
})

test('monitoring intent from current and historical public records is not confused with a watch-plan object', () => {
  assert.equal(courseWatchEnabled(), false)
  assert.equal(courseWatchEnabled({ watch: false }), false)
  assert.equal(courseWatchEnabled({ watch: { status: 'off' } }), false)
  assert.equal(courseWatchEnabled({ watch: { status: 'stopped' } }), false)
  assert.equal(courseWatchEnabled({ watch: { status: 'active' } }), true)
  assert.equal(courseWatchEnabled({ watch: { status: 'paused_provider' } }), true)
  assert.equal(courseWatchEnabled({ watchEnabled: false, watch: { status: 'active' } }), false)
  assert.equal(courseWatchEnabled({ purpose: 'research', watchEnabled: true }), false)
})

test('room-shell popup keeps its accessible financial form without mounting another decorative research room', async () => withEntry({ roomShell: true }, async ({ form, root, writes }) => {
  assert.equal(root.querySelectorAll('img').length, 0)
  assert.equal(root.querySelector('.cc-entry-art'), null)
  assert(root.querySelector('.cc-entry-popup'))
  assert.equal(form.querySelector('h2').textContent, '写下一个你想预测的股票')
  assert.equal(form.querySelector('input').getAttribute('aria-labelledby'), form.querySelector('h2').id)
  assert.equal(writes.length, 0, 'opening the popup never creates a prediction')
  form.querySelector('input').value = '00700.HK'
  await form.fire('submit')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.horizonTradingDays, 5)
}))

test('room-shell history renders actual forecast and research records plus unduplicated legacy predictions without requests', async () => withEntry({ roomShell: true }, async ({ root, ctx, writes }) => {
  ctx.projection = { runs: {} }; ctx.filterTopic = 'old-filter-must-not-hide-history'
  ctx.activeCourseRequestId = 'forecast/one'
  ctx.cache.courseRequests = [
    { requestId: 'forecast/one', question: '实际证券题目', predictionId: 'prediction-shared', createdAt: '2026-11-22T08:00:00Z', timezone: 'Asia/Hong_Kong', status: 'failed', forecast: { probabilityYes: 0.37 } },
    { requestId: 'research-two', question: '实际已披露财报', purpose: 'research', createdAt: '2026-11-21T08:00:00Z', status: 'completed', researchReport: { summary: '封存研报' } },
  ]
  ctx.cache.predictions = [
    { predictionId: 'prediction-shared', question: '不应重复显示的契约', status: 'ready' },
    { predictionId: 'legacy-one', question: '真实旧版记录', status: 'resolved', createdAt: '2026-11-20T08:00:00Z' },
  ]
  globalThis.location.hash = '#/agents'
  const nodes = sidebar(ctx); const container = new FormElement('nav'); container.append(...nodes)
  const cards = container.querySelectorAll('.wb-task-slip')
  assert.equal(cards.length, 3)
  assert.equal(container.querySelector('select'), null, 'history no longer substitutes topic filtering for actual records')
  assert.equal(cards[0].querySelector('a').href, '#/course/forecast%2Fone?results=1')
  assert.equal(cards[0].getAttribute('aria-current'), 'page')
  assert.match(cards[0].textContent, /实际证券题目/u)
  assert.match(cards[0].textContent, /调查失败.*保留判断/u)
  assert.match(cards[0].textContent, /Yes 37%/u)
  assert.match(cards[0].textContent, /创建于.*2026/u)
  assert.equal(cards[1].querySelector('a').href, '#/course/research-two?results=1')
  assert.match(cards[1].textContent, /财报核验.*实际已披露财报.*研报已封存/u)
  assert.equal(cards[2].href, '#/predictions/legacy-one')
  assert(!container.textContent.includes('不应重复显示的契约'))
  assert.equal(writes.length, 0, 'rendering history does not check, retry or create tasks')
}))

test('room-shell history distinguishes unavailable reads and capability from genuinely empty history', async () => withEntry({ roomShell: true }, async ({ ctx, writes }) => {
  ctx.projection = { runs: {} }
  const text = () => { const container = new FormElement('nav'); container.append(...sidebar(ctx)); return container.textContent }
  assert.match(text(), /还没有已保存/u)
  ctx.cache.courseHistoryError = '历史读取失败，请重新读取。'
  assert.match(text(), /历史读取失败/u)
  assert(!text().includes('还没有已保存'))
  ctx.cache.courseHistoryError = null
  ctx.cache.courseCapability = { available: false, message: '当前服务不提供历史接口。' }
  assert.match(text(), /当前服务不提供历史接口/u)
  assert(!text().includes('还没有已保存'))
  ctx.cache.courseCapability = null
  assert.match(text(), /正在读取历史记录/u)
  assert.equal(writes.length, 0)
}))


const savedSeat = { agentSpecId: 'test-researcher', specVersion: 1, name: '当前研究员', instructions: '核验本轮来源。', allowedTools: [], skillRefs: [], extensionSlots: [null, null], modelRef: null }

test('an agent save completing after its popup closes updates shared cache without navigating, callback or touching the old form', async () => withEntry({ roomShell: true }, async ({ root, ctx }) => {
  let active = true; let complete; let callbacks = 0; let calls = 0
  ctx.cache.tools = []; ctx.cache.agents = [savedSeat]
  const form = agentForm(ctx.cache, savedSeat, () => { callbacks++; globalThis.location.hash = '#/agents/unwanted-navigation' }, { isActive: () => active })
  root.append(form)
  globalThis.fetch = async (_url, options) => {
    calls++
    assert.equal(JSON.parse(options.body).expectedVersion, 1)
    return new Promise(resolve => { complete = saved => resolve({ ok: true, json: async () => saved }) })
  }
  const pending = form.fire('submit')
  const save = form.querySelector('button')
  assert.equal(save.disabled, true)
  active = false
  globalThis.location.hash = '#/course/current-scene'
  complete({ ...savedSeat, specVersion: 2, name: '后台实际保存的新版本' })
  await pending
  assert.equal(ctx.cache.agents[0].specVersion, 2)
  assert.equal(callbacks, 0)
  assert.equal(globalThis.location.hash, '#/course/current-scene')
  assert.equal(save.disabled, true, 'inactive owner must not mutate even a retained connected form')
  await form.fire('submit')
  assert.equal(calls, 1, 'an inactive old form cannot submit again')
}))

test('an inactive agent popup suppresses late save errors instead of writing them into old DOM', async () => withEntry({ roomShell: true }, async ({ root, ctx }) => {
  let active = true; let fail
  ctx.cache.tools = []; ctx.cache.agents = [savedSeat]
  const form = agentForm(ctx.cache, savedSeat, () => assert.fail('late failure cannot call onSaved'), { isActive: () => active })
  root.append(form)
  globalThis.fetch = async () => new Promise((_resolve, reject) => { fail = reject })
  const pending = form.fire('submit')
  const before = form.textContent
  active = false; fail(new Error('OLD_POPUP_SAVE_ERROR'))
  await pending
  assert.equal(form.textContent, before)
  assert.equal(ctx.cache.agents[0].specVersion, 1)
}))

test('agent form without an ownership callback retains its existing successful save behavior', async () => withEntry({}, async ({ root, ctx }) => {
  let callback = null
  ctx.cache.tools = []; ctx.cache.agents = [savedSeat]
  const form = agentForm(ctx.cache, savedSeat, saved => { callback = saved })
  root.append(form)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...savedSeat, specVersion: 2 }) })
  await form.fire('submit')
  assert.equal(callback.specVersion, 2)
  assert.equal(ctx.cache.agents[0].specVersion, 2)
  assert.equal(form.querySelector('button').disabled, false)
}))

test('history delete badges are sibling actions, remain disabled for active watches and never decorate legacy records', async () => withEntry({ roomShell: true }, async ({ ctx, writes }) => {
  ctx.projection = { runs: {} }
  const base = { question: '原始股票题目', updatedAt: '2026-11-23T04:00:00Z', createdAt: '2026-11-23T03:00:00Z', status: 'completed', latestRunId: 'done-run', latestRun: { runId: 'done-run', status: 'completed' }, forecast: { probabilityYes: .5 }, activeRunId: null, watch: { status: 'off' } }
  ctx.cache.courseRequests = [
    { ...base, requestId: 'judged' },
    { ...base, requestId: 'watched', watch: { status: 'active' } },
    { ...base, requestId: 'queued', latestRun: { runId: 'queued-run', status: 'queued' }, activeRunId: 'queued-run' },
  ]
  ctx.cache.predictions = [{ predictionId: 'legacy', question: '原旧版记录', status: 'resolved' }]
  const container = new FormElement('nav'); container.append(...sidebar(ctx))
  const cards = container.querySelectorAll('.wb-task-slip')
  assert.equal(cards[0].tagName, 'ARTICLE'); assert.equal(cards[0].dataset.requestId, 'judged')
  assert.equal(cards[0].querySelector('a').querySelectorAll('button').length, 0)
  assert.equal(cards[0].querySelector('.wb-history-delete').textContent, '删除记录'); assert.equal(cards[0].querySelector('.wb-history-delete').disabled, false)
  assert.equal(cards[1].querySelector('.wb-history-delete').disabled, true); assert.match(cards[1].querySelector('.wb-history-delete').title, /停止持续预测/)
  assert.equal(cards[2].querySelector('.wb-history-delete'), null); assert.equal(cards[3].tagName, 'A'); assert.equal(cards[3].querySelector('button'), null)
  assert.equal(writes.length, 0)
}))


test('new tasks snapshot the language selected at submission, preserve original input and reject an old English-report service', async () => {
  const locale = initLocaleUI({ document: { documentElement: { childNodes: [], querySelectorAll: () => [] }, getElementById: () => null }, storage: null })
  try {
    await withEntry({ prior: { purpose: 'forecast', question: '腾讯控股', outputLanguage: 'zh-CN' } }, async ({ form, writes }) => {
      locale.setLocale('en')
      assert.match(form.querySelector('.cc-output-language-hint').textContent, /已有报告和引用原文保持原样/)
      await form.fire('submit')
      assert.equal(writes.length, 1); assert.equal(writes[0].body.outputLanguage, 'en')
      assert.equal(writes[0].body.question, '腾讯控股')
    })
    await withEntry({ englishSupported: false }, async ({ form, ctx, writes }) => {
      form.querySelector('input').value = '阿里巴巴'
      await form.fire('submit')
      assert.equal(writes.length, 0); assert.equal(form.querySelector('input').value, '阿里巴巴')
      assert.match(form.querySelector('.cc-capability-notice').textContent, /英文报告功能/)
      assert.equal(ctx.cache.courseCapability.available, true)
    })
    await withEntry({ prior: { purpose: 'research', question: '核验腾讯财报', outputLanguage: 'en' } }, async ({ form, writes }) => {
      locale.setLocale('zh-CN'); await form.fire('submit')
      assert.equal(writes.length, 1); assert.equal(writes[0].body.outputLanguage, 'zh-CN')
      assert.equal(writes[0].body.purpose, 'research')
    })
  } finally { locale.setLocale('zh-CN'); locale.dispose() }
})

test('the non-shell board renders existing binary and direction forecasts without losing their original questions', async () => withEntry({ board: true, courseRequests: [
  { requestId: 'binary', question: '原始用户题目', status: 'completed', forecast: { probabilityYes: .7 }, normalized: { targetAt: '2026-11-23T08:00:00Z' } },
  { requestId: 'direction', question: '原始方向问题', status: 'completed', forecast: { type: 'price_direction', probabilityUp: .5, probabilityFlat: .3, probabilityDown: .2 } },
] }, async ({ root, writes }) => {
  const cards = root.querySelectorAll('.wb-board-card')
  assert.equal(cards.length, 2); assert.match(root.textContent, /原始用户题目/); assert.match(root.textContent, /上涨 50%/)
  assert.equal(cards[0].querySelector('a').getAttribute('data-i18n-skip'), 'true')
  assert.equal(writes.length, 0)
}))


test('local language changes restore an old-service form from English to Chinese without a request or lost input', async () => withEntry({ englishSupported: false }, async ({ form, root, writes }) => {
  const document = { documentElement: { childNodes: [], querySelectorAll: selector => root.querySelectorAll(selector) }, getElementById: () => null,
    defaultView: { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } } } }
  const locale = initLocaleUI({ document, storage: null })
  try {
    const security = form.querySelector('input'), start = form.querySelector('.cc-start')
    security.value = '00700.HK'
    assert.equal(form.getAttribute('data-i18n-language-control'), 'true')
    assert.equal(start.disabled, false)
    locale.setLocale('en')
    assert.equal(start.disabled, true); assert.equal(writes.length, 0)
    assert.match(form.querySelector('.cc-capability-notice').textContent, /英文报告功能/)
    locale.setLocale('zh-CN')
    assert.equal(start.disabled, false); assert.equal(start.textContent, '开始预测')
    assert.equal(form.querySelector('input'), security); assert.equal(security.value, '00700.HK'); assert.equal(writes.length, 0)
    await form.fire('submit')
    assert.equal(writes.length, 1); assert.equal('outputLanguage' in writes[0].body, false)
  } finally { locale.setLocale('zh-CN'); locale.dispose() }
}))

test('the fresh capability snapshot controls whether Chinese language metadata is sent and never silently drops English', async () => {
  const locale = initLocaleUI({ document: { documentElement: { childNodes: [], querySelectorAll: () => [] }, getElementById: () => null }, storage: null })
  try {
    for (const language of ['zh-CN', 'en']) await withEntry({}, async ({ form, ctx, writes }) => {
      locale.setLocale(language)
      let probes = 0
      ctx.checkCourseCapability = async () => { probes++; const { outputLanguages, ...config } = ctx.cache.courseCapability.config; return { ...ctx.cache.courseCapability, config } }
      form.querySelector('input').value = '腾讯控股'
      await form.fire('submit')
      assert.equal(probes, 1)
      assert.equal(writes.length, language === 'en' ? 0 : 1)
      if (writes.length) assert.equal('outputLanguage' in writes[0].body, false)
      assert.equal(form.querySelector('input').value, '腾讯控股')
    })
  } finally { locale.setLocale('zh-CN'); locale.dispose() }
})
