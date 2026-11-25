import { uiTranslations, dynamicRules } from './locale-zh-en.js'
import { formatUiDate } from './locale-format.js'

const PREFERENCE_KEY = 'world-lab.locale'
const ATTRIBUTE_NAMES = ['placeholder', 'title', 'aria-label', 'alt', 'aria-description', 'aria-valuetext']
const DATE_ATTRIBUTES = ['data-i18n-date', 'data-i18n-timezone', 'data-i18n-date-format']
const HARD_BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'])
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'BLOCKQUOTE', 'TEMPLATE', 'NOSCRIPT'])
const VALUE_ELEMENTS = new Set(['INPUT', 'TEXTAREA'])
const CONTENT_SELECTORS = [
  '.wb-prewrap', '[data-i18n-skip]', '[data-i18n-content]', '[data-user-content]', '[data-model-content]',
  '.wb-task-slip strong', '.wb-board-card h3',
  '.wb-agent-tile strong', '.cc-answer h2', '.cc-answer-summary',
  '.cc-source summary', '.cc-source > p', '.cc-relation > span', '.wb-evidence-item h3',
]
let activeLocale = 'zh-CN'
const initialized = new WeakMap()

export function getLocale() { return activeLocale }

/** Only explicit UI strings/templates are eligible; never recursively translate captured data. */
export function translateUiText(text, locale = 'en') {
  if (typeof text !== 'string' || locale !== 'en') return text
  const source = text.trim()
  if (!source) return text
  let translated = Object.prototype.hasOwnProperty.call(uiTranslations, source) ? uiTranslations[source] : null
  if (typeof translated !== 'string') {
    translated = null
    for (const rule of dynamicRules ?? []) {
      if (!(rule.pattern instanceof RegExp) || !rule.pattern.source.startsWith('^') || !rule.pattern.source.endsWith('$')) continue
      rule.pattern.lastIndex = 0
      if (!rule.pattern.test(source)) continue
      rule.pattern.lastIndex = 0
      translated = source.replace(rule.pattern, rule.replace)
      break
    }
  }
  if (typeof translated !== 'string') return text
  const start = text.indexOf(source)
  return text.slice(0, start) + translated + text.slice(start + source.length)
}

function protectedContent(element) {
  for (let owner = element; owner; owner = owner.parentElement) {
    if (HARD_BLOCKED_TAGS.has(owner.tagName)) return true
    for (const name of ['data-i18n-skip', 'data-i18n-content', 'data-user-content', 'data-model-content']) if (owner.hasAttribute?.(name)) return true
  }
  return false
}

function skipped(element) {
  if (protectedContent(element)) return true
  let explicitUI = false
  for (let owner = element; owner; owner = owner.parentElement) if (owner.getAttribute?.('data-i18n-ui') === 'true') explicitUI = true
  if (explicitUI) return false
  for (let owner = element; owner; owner = owner.parentElement) {
    if (BLOCKED_TAGS.has(owner.tagName) || owner.tagName === 'OPTION') return true
    for (const selector of CONTENT_SELECTORS) { try { if (owner.matches?.(selector)) return true } catch {} }
  }
  return false
}

export function initLocaleUI(options = {}) {
  const doc = options.document ?? globalThis.document
  if (!doc?.documentElement) throw new Error('A document is required to initialize the interface language.')
  if (initialized.has(doc)) return initialized.get(doc)
  let storage = null
  try { storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : doc.defaultView?.localStorage ?? globalThis.localStorage } catch {}
  let locale = 'zh-CN'
  try { if (storage?.getItem(PREFERENCE_KEY) === 'en') locale = 'en' } catch {}
  activeLocale = locale
  const texts = new WeakMap(), attributes = new WeakMap(), listeners = new Map()
  let disposed = false

  function textNode(node) {
    if (node.isConnected === false || skipped(node.parentElement) || VALUE_ELEMENTS.has(node.parentElement?.tagName) || node.parentElement?.hasAttribute?.('data-i18n-date')) return
    const value = node.data
    let record = texts.get(node)
    if (!record || value !== record.rendered) { record = { source: value, rendered: value }; texts.set(node, record) }
    const rendered = translateUiText(record.source, locale)
    record.rendered = rendered
    if (value !== rendered) node.data = rendered
  }
  function attribute(element, name) {
    if (skipped(element)) return
    const excluded = element.getAttribute('data-i18n-skip-attributes')
    if (excluded?.split(/\s+/).includes(name)) return
    const value = element.getAttribute(name)
    let records = attributes.get(element)
    if (value === null) { records?.delete(name); return }
    if (!records) { records = new Map(); attributes.set(element, records) }
    let record = records.get(name)
    if (!record || value !== record.rendered) { record = { source: value, rendered: value }; records.set(name, record) }
    const rendered = translateUiText(record.source, locale)
    record.rendered = rendered
    if (value !== rendered) element.setAttribute(name, rendered)
  }
  function scan(root) {
    if (!root || root.isConnected === false) return
    if (root.nodeType === 3) { textNode(root); return }
    if (root.nodeType === 1) {
      if (protectedContent(root)) return
      if (root.hasAttribute?.('data-i18n-date')) {
        const rendered = formatUiDate(root.getAttribute('data-i18n-date'), { locale, timezone: root.getAttribute('data-i18n-timezone') || undefined, kind: root.getAttribute('data-i18n-date-format') || 'date-time' })
        if (root.textContent !== rendered) root.textContent = rendered
      }
      if (!skipped(root)) for (const name of ATTRIBUTE_NAMES) attribute(root, name)
      if (VALUE_ELEMENTS.has(root.tagName)) return
    }
    for (const child of root.childNodes ?? []) scan(child)
  }
  function updateSwitch() {
    const group = doc.getElementById('wb-language-switch')
    if (!group) return
    const groupLabel = locale === 'en' ? 'Interface language' : '界面语言'
    if (group.getAttribute('aria-label') !== groupLabel) group.setAttribute('aria-label', groupLabel)
    for (const control of group.querySelectorAll('[data-locale]')) {
      const pressed = String(control.getAttribute('data-locale') === locale)
      if (control.getAttribute('aria-pressed') !== pressed) control.setAttribute('aria-pressed', pressed)
      if (!listeners.has(control)) {
        const listener = () => setLocale(control.getAttribute('data-locale'))
        control.addEventListener('click', listener); listeners.set(control, listener)
      }
    }
    for (const [control, listener] of listeners) if (control.isConnected === false) { control.removeEventListener('click', listener); listeners.delete(control) }
  }
  function setLocale(value, { persist = true } = {}) {
    if (disposed) return locale
    locale = value === 'en' ? 'en' : 'zh-CN'; activeLocale = locale
    doc.documentElement.lang = locale
    updateSwitch(); scan(doc.documentElement)
    const EventType = doc.defaultView?.CustomEvent ?? globalThis.CustomEvent
    if (typeof EventType === 'function') for (const control of doc.documentElement.querySelectorAll('[data-i18n-language-control="true"]')) {
      control.dispatchEvent?.(new EventType('world-lab:localechange', { detail: { locale } }))
    }
    if (persist) { try { storage?.setItem(PREFERENCE_KEY, locale) } catch {} }
    return locale
  }
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  setLocale(locale, { persist: false })
  const observer = typeof Observer === 'function' ? new Observer(records => {
    if (disposed) return
    for (const mutation of records) {
      if (mutation.type === 'characterData') textNode(mutation.target)
      else if (mutation.type === 'attributes' && DATE_ATTRIBUTES.includes(mutation.attributeName)) scan(mutation.target)
      else if (mutation.type === 'attributes' && ATTRIBUTE_NAMES.includes(mutation.attributeName)) attribute(mutation.target, mutation.attributeName)
      else if (mutation.type === 'childList') for (const child of mutation.addedNodes) scan(child)
    }
    updateSwitch()
  }) : null
  observer?.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRIBUTE_NAMES, ...DATE_ATTRIBUTES] })
  const controller = {
    getLocale: () => locale, setLocale,
    refresh(root = doc.documentElement) { if (!disposed) { updateSwitch(); scan(root) } },
    dispose() { if (disposed) return; disposed = true; observer?.disconnect(); for (const [control, listener] of listeners) control.removeEventListener('click', listener); listeners.clear(); initialized.delete(doc) },
  }
  initialized.set(doc, controller)
  return controller
}
