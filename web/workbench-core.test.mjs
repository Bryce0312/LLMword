import assert from 'node:assert/strict'
import { test } from 'node:test'
import { api, formError, h } from './workbench-core.js'
import { apiErrorPresentation, courseErrorPresentation } from './course-errors.mjs'
import { courseRoleNameContent } from './course-role-ui.js'
import { renderCollaboration } from './course-collaboration.js'
import { COURSE_ROLE_LABELS } from './course-team.mjs'
import { translateUiText } from './locale.mjs'

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.className = '' }
  append(...items) { this.children.push(...items) }
  prepend(...items) { this.children.unshift(...items) }
  replaceChildren(...items) { this.children = [...items] }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  getAttribute(key) { return this.attributes[key] ?? null }
  addEventListener() {}
  scrollIntoView() { this.scrolled = true }
  get textContent() { return this.children.map(item => typeof item === 'object' ? item.textContent : String(item)).join('') }
  set textContent(value) { this.children = [String(value)] }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/u).includes(selector.slice(1))
    if (selector === '[data-field-error]') return this.dataset.fieldError !== undefined
    const field = selector.match(/^\[data-field-error="([^"]+)"\]$/u)
    if (field) return this.dataset.fieldError === field[1]
    if (selector === 'details[open][data-assignment-id]') return this.tagName === 'DETAILS' && this.open && this.dataset.assignmentId
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) { return this.children.flatMap(item => typeof item === 'object' ? [...(item.matches(selector) ? [item] : []), ...item.querySelectorAll(selector)] : []) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
async function withDom(exercise) {
  const previous = { document: globalThis.document, CSS: globalThis.CSS, fetch: globalThis.fetch }
  globalThis.document = { createElement: tag => new Element(tag) }
  globalThis.CSS = { escape: String }
  try { await exercise() }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
}
const english = text => translateUiText(text, 'en')

test('a mocked MODEL_NOT_CONFIGURED API failure renders an English-ready form action without a version-refresh suffix or lost input', () => withDom(async () => {
  let requests = 0
  globalThis.fetch = async () => { requests++; return { ok: false, status: 409, json: async () => ({ error: { code: 'MODEL_NOT_CONFIGURED', message: '请先在“模型连接”保存 DeepSeek API Key，再开始任务。', fields: ['question'] } }) } }
  let error
  try { await api('/course/requests', { method: 'POST', body: { question: 'isolated test' } }) } catch (value) { error = value }
  assert.equal(requests, 1); assert.equal(error.code, 'MODEL_NOT_CONFIGURED'); assert.equal(error.status, 409)
  const form = h('form'), input = h('input'), note = h('small'); note.dataset.fieldError = 'question'
  Object.defineProperty(input, 'value', { get() { throw new Error('Rendering an error must not read input') }, set() { throw new Error('Rendering an error must not write input') } })
  form.append(input, note); formError(form, error)
  const alert = form.querySelector('.wb-form-error')
  assert.equal(alert.getAttribute('role'), 'alert'); assert.equal(alert.children.length, 1)
  assert.equal(alert.children[0].getAttribute('data-i18n-ui'), 'true')
  assert.equal(english(alert.textContent), 'Save a DeepSeek API key in Model connection before starting a task.')
  assert(!alert.textContent.includes('最新版本')); assert.equal(form.children.includes(input), true)
  assert.equal(note.textContent, '请补充或修正此项。'); assert.equal(alert.scrolled, true)
  assert.equal(error.message, '请先在“模型连接”保存 DeepSeek API Key，再开始任务。', 'the API error itself is not mutated for display')
}))

test('only a real VERSION_CONFLICT receives refresh advice; busy, closed and unknown 409 failures preserve the correct action', () => withDom(() => {
  for (const code of ['MODEL_NOT_CONFIGURED', 'PROVIDER_UPDATE_BUSY', 'PREDICTION_BUSY', 'REQUEST_CLOSED', 'UNKNOWN']) {
    const error = { code, status: 409, message: 'Unrecognized service detail' }, form = h('form')
    formError(form, error)
    assert.equal(form.querySelector('.wb-form-error').children.length, 1, code)
    assert.equal(apiErrorPresentation(error).refreshVersion, false)
  }
  const form = h('form'); formError(form, { code: 'VERSION_CONFLICT', status: 409, message: 'vendor text is not a UI instruction' })
  const alert = form.querySelector('.wb-form-error')
  assert.equal(alert.children.length, 2)
  assert.equal(english(alert.children[0].textContent), 'The record version has changed.')
  assert.equal(english(alert.children[1].textContent).trim(), 'Refresh to load the latest version. Your current input is retained.')
}))

test('known system codes never echo vendor bodies, while unknown messages and malformed code names remain stable', () => {
  for (const code of ['MODEL_NOT_CONFIGURED', 'MODEL_AUTH_FAILED', 'MODEL_BALANCE_REQUIRED', 'MODEL_UNAVAILABLE', 'TOOL_UNAVAILABLE', 'PREDICTION_BUSY', 'REQUEST_DELETED', 'AGENT_DELETED']) {
    const shown = apiErrorPresentation({ code, message: 'VENDOR_SECRET_BODY', status: 409 })
    assert(!shown.message.includes('VENDOR_SECRET_BODY')); assert.doesNotMatch(english(shown.message), /[\p{Script=Han}]/u)
  }
  for (const code of ['UNKNOWN', '__proto__', 'toString']) {
    const error = { code, status: 400, message: 'Original detail for fallback' }, before = { ...error }
    assert.equal(apiErrorPresentation(error).message, error.message)
    assert.equal(courseErrorPresentation(error).detail, error.message)
    assert.deepEqual(error, before)
  }
  assert.equal(english(apiErrorPresentation({}).message), 'The request could not be completed. Please try again later.')
})

test('default role names require both canonical identity and the exact factory label; custom names remain protected', () => withDom(() => {
  for (const roleId of ['official', 'market', 'statistics', 'verification', 'main']) {
    const canonicalId = roleId === 'main' ? 'supervisor' : roleId
    const node = courseRoleNameContent(roleId, COURSE_ROLE_LABELS[canonicalId], 'strong')
    assert.equal(node.tagName, 'STRONG'); assert.equal(node.getAttribute('data-i18n-ui'), 'true')
    assert.doesNotMatch(english(node.textContent), /[\p{Script=Han}]/u)
  }
  for (const [roleId, name] of [['market', '我的市场研究员'], ['custom', COURSE_ROLE_LABELS.market], ['market', COURSE_ROLE_LABELS.verification]]) {
    const node = courseRoleNameContent(roleId, name)
    assert.equal(node.getAttribute('data-i18n-skip'), 'true'); assert.equal(node.textContent, name)
  }
  assert.equal(courseRoleNameContent('verification').getAttribute('data-i18n-ui'), 'true')
}))

test('actual collaboration report headings, follow-up recipients and decision rows use role UI nodes without changing saved names', () => withDom(() => {
  const report = (roleId, name, assignmentId) => ({ roleId, name, assignmentId, objective: '原任务', reason: '原理由', summary: '原报告', reportStatus: 'complete', probability: .6, support: [], counterevidence: [], missingEvidence: [], decision: { disposition: 'qualified', reason: '原裁决', evidenceIds: [] } })
  const known = report('verification', COURSE_ROLE_LABELS.verification, 'known')
  const custom = report('market', '我的自定义席位', 'custom')
  const review = { ...known, assignmentId: 'followup', followUp: true, cycle: 2, responseStatus: 'submitted', newEvidenceIds: [] }
  const trace = { runId: 'r', modelMode: 'live', sourceMode: 'live', sources: [], team: [known, custom], reviews: [review], reports: [known, custom], decision: { kind: 'forecast', probabilityYes: .6, delta: null, recordedNotes: 2, totalReports: 2, dissent: [] } }
  const before = structuredClone(trace), node = h('section'); renderCollaboration(node, trace)
  const spans = node.querySelectorAll('span')
  const knownNames = spans.filter(span => span.textContent === COURSE_ROLE_LABELS.verification)
  assert(knownNames.length >= 4, 'heading, follow-up, report card and decision row all render the canonical role')
  assert(knownNames.every(span => span.getAttribute('data-i18n-ui') === 'true'))
  const customNames = spans.filter(span => span.textContent === custom.name)
  assert(customNames.length >= 2); assert(customNames.every(span => span.getAttribute('data-i18n-skip') === 'true'))
  assert.deepEqual(trace, before)
}))
