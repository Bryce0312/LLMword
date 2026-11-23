import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseChart } from './workbench-course-chart.js'
import { translateUiText } from './locale.mjs'

class Element {
  constructor(tag, namespace = null) { this.tagName = tag.toUpperCase(); this.namespaceURI = namespace; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.className = '' }
  append(...children) { this.children.push(...children) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  get textContent() { return this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join('') }
  set textContent(text) { this.children = [String(text)] }
}
const descendants = node => [node, ...node.children.filter(child => typeof child === 'object').flatMap(descendants)]

test('chart labels and accessible descriptions are UI while dates, numeric probabilities and saved summaries stay separate', () => {
  const saved = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag, ns) }
  try {
    const targetAt = '2026-12-01T08:00:00Z'
    const point = { predictionId: 'p', predictionVersion: 1, forecastId: 'f', publishedAt: '2026-11-23T04:00:00Z', targetAt, type: 'price_direction', probabilityUp: .5, probabilityFlat: .3, probabilityDown: .2, summary: '开始预测' }
    const chart = courseChart([point], { predictionId: 'p', version: 1, targetAt, type: 'price_direction', timezone: 'Asia/Hong_Kong' })
    const nodes = descendants(chart), svg = nodes.find(node => node.tagName === 'SVG')
    assert(svg); assert.doesNotMatch(translateUiText(svg.attributes['aria-label'], 'en'), /[\p{Script=Han}]/u)
    const dates = nodes.filter(node => node.attributes['data-i18n-date'])
    assert(dates.length >= 5)
    assert(dates.some(node => node.tagName === 'TSPAN' && node.namespaceURI === 'http://www.w3.org/2000/svg'))
    assert(dates.every(node => Number.isFinite(Date.parse(node.attributes['data-i18n-date']))))
    const original = nodes.find(node => node.attributes['data-i18n-skip'] === 'true' && node.textContent === '开始预测')
    assert(original, 'saved model summary has a hard data boundary even when it matches UI text')
    const untranslated = []
    const walk = node => {
      if (node.attributes['data-i18n-skip'] === 'true' || node.attributes['data-i18n-date']) return
      for (const child of node.children) if (typeof child === 'object') walk(child); else if (/[\p{Script=Han}]/u.test(String(child))) untranslated.push(translateUiText(String(child), 'en'))
    }
    walk(chart); assert.doesNotMatch(untranslated.join(' '), /[\p{Script=Han}]/u)
    assert.equal(original.textContent, '开始预测'); assert(chart.textContent.includes('50%'))
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
})
