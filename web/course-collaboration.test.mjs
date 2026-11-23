import assert from 'node:assert/strict'
import test from 'node:test'
import { renderCollaboration } from './course-collaboration.js'
import { translateUiText } from './locale.mjs'

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.className = '' }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = [...children] }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener() {}
  get textContent() { return this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join('') }
  querySelectorAll(selector) {
    return this.children.flatMap(child => typeof child === 'object' ? [
      ...(selector === 'details[open][data-assignment-id]' && child.tagName === 'DETAILS' && child.open && child.dataset.assignmentId ? [child] : []),
      ...(selector.startsWith('.') && child.className.split(/\s+/).includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ] : [])
  }
}

test('each independent or follow-up report shows its own uncalibrated estimate without filling missing scores', () => {
  const saved = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  try {
    const report = (assignmentId, probability, followUp = false) => ({ assignmentId, roleId: 'verification', objective: '核验资料', reason: '独立核验', summary: '已提交报告', reportStatus: 'complete', probability, followUp, support: [], counterevidence: [], missingEvidence: [] })
    const reports = [report('zero', 0), report('fraction', .67), report('one', 1), report('missing', null), report('absent', undefined), report('invalid', 1.2)]
    const review = { ...report('review', .72, true), responseStatus: 'submitted', newEvidenceIds: [], probabilityBefore: .67, probabilityAfter: .72 }
    const node = new Element('section')
    renderCollaboration(node, { runId: 'r', modelMode: 'live', sourceMode: 'live', sources: [], team: reports, reviews: [review], reports: [...reports, review], decision: null })
    const cards = node.querySelectorAll('.cc-collab-report')
    assert.deepEqual(cards.map(card => card.dataset.assignmentId), ['zero', 'fraction', 'one', 'missing', 'absent', 'invalid', 'review'])
    assert.deepEqual(cards.map(card => card.children.find(child => typeof child === 'object' && child.tagName === 'P' && child.textContent.startsWith('本席 Yes 估计'))?.textContent), [
      '本席 Yes 估计 0%（未校准）', '本席 Yes 估计 67%（未校准）', '本席 Yes 估计 100%（未校准）',
      '本席 Yes 估计：未给估计。', '本席 Yes 估计：未给估计。', '本席 Yes 估计：未给估计。', '本席 Yes 估计 72%（未校准）',
    ])
    assert(!cards.some(card => card.textContent.includes('50%')))
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
})

test('researcher estimate labels support the English interface', () => {
  assert.equal(translateUiText('本席 Yes 估计 67%（未校准）', 'en'), 'This researcher’s Yes estimate: 67% (uncalibrated)')
  assert.equal(translateUiText('本席 Yes 估计：未给估计。', 'en'), 'This researcher’s Yes estimate: not provided.')
})

test('collaboration labels eligible partial evidence without claiming report completion or promoting empty reports', () => {
  const saved = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  try {
    const report = (assignmentId, extra = {}) => ({ assignmentId, roleId: 'verification', status: 'completed', objective: '核验资料',
      reason: '独立核验', summary: '已有少量已读来源', reportStatus: 'insufficient', probability: .48, reportQuality: 'partial',
      evidenceIds: ['owned-source'], support: [], counterevidence: [], missingEvidence: [], ...extra })
    const reports = [report('partial'), report('failed', { status: 'failed' }),
      report('legacy', { reportQuality: null }), report('empty', { evidenceIds: [] }), report('invalid', { probability: 1.2 }),
      report('complete', { reportStatus: 'complete', reportQuality: 'complete' })]
    const node = new Element('section')
    renderCollaboration(node, { runId: 'r', modelMode: 'live', sourceMode: 'live', sources: [], team: reports, reviews: [], reports, decision: null })
    const cards = node.querySelectorAll('.cc-collab-report')
    assert.deepEqual(cards.map(card => card.children[0].textContent.split(' · ').at(-1)), [
      '资料有限', '未完整，部分依据已保留', '资料不足', '资料不足', '资料不足', '报告完成',
    ])
    assert(cards[0].textContent.includes('48%（未校准）'))
    assert(!cards[4].textContent.includes('120%'))
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
})

test('limited evidence and report correction labels support English without changing model content', () => {
  assert.equal(translateUiText('已有依据，资料有限', 'en'), 'Evidence available, with limitations')
  assert.equal(translateUiText('资料有限', 'en'), 'Limited evidence')
  assert.equal(translateUiText('未完整，部分依据已保留', 'en'), 'Incomplete; some supported findings retained')
  assert.equal(translateUiText('每位研究员最多 6 次调查决策；资料足够可提前提交报告，最迟第 7 次进入报告阶段，另留 2 次报告修正。调查与报告分开计数，仍受本席总调用与 token 上限约束。', 'en'),
    'Each researcher may make up to 6 research decisions and report early when ready. Reporting starts no later than request 7, with 2 report corrections reserved. Research and reporting are counted separately within the same overall request and token limits.')
})


test('rendered collaboration UI translates around protected names, tasks, report prose, evidence and citations', () => {
  const saved = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  try {
    const claim = { basis: 'inference', claim: '资料不足', evidenceIds: ['e'], citations: [{ quote: '开始预测' }] }
    const report = { assignmentId: 'a', roleId: 'verification', name: '保存预算', objective: '开始预测', reason: '模型连接', summary: '删除记录', reportStatus: 'complete', probability: .67, followUp: false, support: [claim], counterevidence: [{ ...claim, basis: 'fact' }], missingEvidence: ['等待模型'], decision: { disposition: 'qualified', reason: '查看来源原文', evidenceIds: ['e'] } }
    const review = { ...report, assignmentId: 'b', followUp: true, cycle: 2, responseStatus: 'submitted', newEvidenceIds: ['e'], probabilityBefore: .67, probabilityAfter: .7 }
    const node = new Element('section')
    renderCollaboration(node, { runId: 'r', modelMode: 'live', sourceMode: 'live', sources: [{ evidenceId: 'e', title: '保存预算', url: 'https://example.invalid/source' }], team: [report], reviews: [review], reports: [report, review], conclusion: '已发布；可逐项查看补查答复与裁决。', decision: { kind: 'forecast', groundingPolicy: true, reasoningClaims: [claim], probabilityYes: .7, delta: .03, recordedNotes: 1, totalReports: 2, dissent: ['保存预算'] } })
    const protectedValues = [], translated = []
    const walk = (element, protectedAncestor = false) => {
      const protectedHere = protectedAncestor || element.attributes['data-i18n-skip'] === 'true'
      if (protectedHere && !protectedAncestor) { protectedValues.push(element.textContent); return }
      for (const child of element.children) {
        if (typeof child === 'object') walk(child, protectedHere)
        else translated.push(translateUiText(String(child), 'en'))
      }
    }
    walk(node)
    assert.doesNotMatch(translated.join(' '), /[\p{Script=Han}]/u)
    for (const value of ['保存预算', '开始预测', '模型连接', '删除记录', '资料不足', '等待模型', '查看来源原文']) assert(protectedValues.includes(value), value)
    assert.equal(node.querySelectorAll('.cc-collab-report')[0].children[0].attributes['data-i18n-ui'], 'true')
    assert.match(node.textContent, /保存预算.*独立调查/u)
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
})


test('collaboration localizes exact round-scope and executor receipts without exposing arbitrary reports to UI translation', () => {
  const saved = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  try {
    const receipt = '执行器预算收尾回执：本研究员已取得2项资料，但未在本次额度内完成有效判断。以下资料供主Agent整理，不代表完整研究报告或已验证概率。'
    const gap = '研究员的最终证据判断未完成；需保留本次额度和校验限制。'
    const report = { assignmentId: 'a', roleId: 'official', summary: receipt, objective: '保存预算', reason: '模型连接', reportStatus: 'insufficient', probability: null, support: [], counterevidence: [], missingEvidence: [gap, '删除记录'] }
    const trace = { runId: 'r', modelMode: 'live', sourceMode: 'live', sources: [], triage: { reason: '首次按题选择差异职责。' }, team: [report], reviews: [], reports: [report], decision: null }
    const node = new Element('section'); renderCollaboration(node, trace)
    const translate = element => element.attributes['data-i18n-skip'] === 'true' ? element.textContent : element.children.map(child => typeof child === 'object' ? translate(child) : translateUiText(String(child), 'en')).join('')
    const english = translate(node)
    assert.match(english, /The initial team is selected for distinct responsibilities/u)
    assert.match(english, /Executor budget close-out receipt: this researcher obtained 2 materials/u)
    assert.match(english, /The researcher’s final evidence assessment is incomplete/u)
    for (const original of ['保存预算', '模型连接', '删除记录']) assert(english.includes(original))
    renderCollaboration(node, { ...trace, triage: { reason: '保存预算' }, team: [{ ...report, summary: '模型连接' }] })
    assert(translate(node).includes('保存预算')); assert(translate(node).includes('模型连接'))
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
})
