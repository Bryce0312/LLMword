import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateModelInputTokens, planModelCall, compactToolReceipt } from './model-budget.mjs'

const messages = [{ role: 'system', content: '以实际证据调查。' }, { role: 'user', content: '需要有期限的判断。' }]
const tools = [{ type: 'function', function: { name: 'read_source', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }]

test('input admission includes messages and tool schemas and subtracts the closeout reserve before output', () => {
  const inputTokens = estimateModelInputTokens(messages, tools)
  assert(inputTokens > estimateModelInputTokens(messages, []))
  const plan = planModelCall({ messages, tools, maxTotalTokens: 10000, usedTotalTokens: 5000, maxOutputTokens: 4096, reserveTokens: 2000 })
  assert.equal(plan.inputTokens, inputTokens)
  assert.equal(plan.maxTokens, 3000 - inputTokens)
  assert.equal(plan.estimatedRequestTokens + plan.reservedTokens, 5000)
  assert.equal(plan.canCall, true)
})

test('input costs can reject a call even when its proposed completion alone would fit', () => {
  const plan = planModelCall({ messages, tools, maxTotalTokens: 1000, usedTotalTokens: 800, maxOutputTokens: 100, minOutputTokens: 1 })
  assert.equal(plan.canCall, false)
  assert.equal(plan.maxTokens, 0)
  assert.equal(plan.reason, 'INPUT_BUDGET')
  assert.throws(() => planModelCall({ messages, usedTotalTokens: -1 }), TypeError)
})

test('unlimited total still returns an explicit bounded output and estimate, not a false exact bill', () => {
  const plan = planModelCall({ messages, tools, maxTotalTokens: null, usedTotalTokens: 100000, maxOutputTokens: 2048, reserveTokens: 2000 })
  assert.equal(plan.canCall, true)
  assert.equal(plan.remainingTokens, null)
  assert.equal(plan.maxTokens, 2048)
  assert(plan.estimatedRequestTokens > 2048)
})

test('working receipt excerpts preserve actual evidence, do not promote failed evidence, and leave archives untouched', () => {
  const receipt = { toolId: 'fetch_page', toolCallId: 'call-1', result: { status: 'ok', evidenceIds: ['ev-1'], summary: '已读取',
    data: { text: '原文。'.repeat(1000), rawCandles: [[1, 2, 3]], citationHints: [{ quote: '原文。' }] }, observedAt: '2026-11-22T00:00:00Z' } }
  const copy = structuredClone(receipt)
  const compact = compactToolReceipt(receipt, { textCharacters: 90 })
  assert.deepEqual(compact.evidenceIds, ['ev-1'])
  assert.equal(compact.data.text.length, 90)
  assert.equal(compact.data.citationHints[0].quote, '原文。')
  assert(!Object.hasOwn(compact.data, 'rawCandles'))
  assert.deepEqual(receipt, copy)
  assert.deepEqual(compactToolReceipt({ ...receipt, result: { ...receipt.result, status: 'error' } }).evidenceIds, [])
})
