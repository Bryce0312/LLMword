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
