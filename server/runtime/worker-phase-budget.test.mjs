import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './worker-loop.mjs'
import { RuntimeError } from './model-provider.mjs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

const quote = 'The company published an audited report.'
const claim = { claim: quote, basis: 'fact', evidenceIds: ['e1'], citations: [{ evidenceId: 'e1', quote }] }
const valid = { status: 'complete', summary: 'A bounded model report.', evidenceIds: ['e1'], support: [claim], counterevidence: [], missingEvidence: [], probability: .61, nextSuggestion: 'Review the remaining uncertainties.' }
const assignment = { topicId: 'topic', predictionId: 'prediction', runId: 'run', assignmentId: 'assignment', agentInstanceId: 'actor',
  objective: 'Investigate the original question using actual evidence.', inputEvidence: [], allowedTools: ['read_source', 'search_web'],
  budget: { maxModelRequests: 10, maxInvestigationRequests: 6, maxToolCalls: 8, maxTotalTokens: 120000, maxTokens: 4096,
    reserveReportTokens: 24000, reportRepairRequests: 2, reportOutputTokens: 4096, inputAwareCloseout: true, maxRetries: 0 } }
const spec = { agentSpecId: 'verification', specVersion: 1, instructions: 'Read actual source material; do not invent evidence.', allowedTools: assignment.allowedTools }
const action = (id, name, args, usage = { total_tokens: 100 }) => ({ message: { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls', usage })
function readTool(counter = { value: 0 }) { return { toolId: 'read_source', version: 1, inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async execute() { counter.value++; return { status: 'ok', data: { text: quote }, evidenceIds: ['e1'], summary: 'An actual owned read.', observedAt: new Date().toISOString(), error: null } } } }
const policy = { version: 'original-grounding-validator', check(value) {
  if (value.status !== 'complete' && !value.support.length && !value.counterevidence.length) return null
  try { validateGroundedClaims([...value.support, ...value.counterevidence], [{ evidenceId: 'e1', text: quote, readBy: ['assignment'] }], { readerId: 'assignment' }); return null }
  catch (error) { return error.message }
}, review: value => value }

test('six investigation requests leave the seventh for reports even when two tool calls remain', async () => {
  let calls = 0
  const result = await runWorker({ provider: { async complete(input) {
    calls++
    if (calls <= 6) { assert(input.tools.some(tool => tool.function.name === 'read_source')); return action('read-' + calls, 'read_source', {}) }
    assert.deepEqual(input.tools.map(tool => tool.function.name), ['submit_report'])
    return action('report', 'submit_report', valid)
  } }, assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy })
  assert.equal(calls, 7)
  assert.equal(result.usage.investigationRequests, 6)
  assert.equal(result.usage.reportRequests, 1)
  assert.equal(result.usage.toolCalls, 6)
})

test('an early report starts a separate initial-plus-two-repair allowance and compacts each real correction', async () => {
  let calls = 0; const checkpoints = []
  const result = await runWorker({ provider: { async complete(input) {
    calls++
    if (calls === 1) return action('read', 'read_source', {})
    if (calls > 2) {
      assert.deepEqual(input.tools.map(tool => tool.function.name), ['submit_report'])
      const context = JSON.parse(input.messages.find(message => message.role === 'user').content)
      assert.equal(context.lastReportIssue.code, 'INVALID_CITATION')
    }
    return action('report-' + calls, 'submit_report', calls < 4 ? { ...valid, evidenceIds: ['foreign'] } : valid)
  } }, assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy, onCheckpoint: value => checkpoints.push(value) })
  assert.equal(calls, 4)
  assert.equal(result.usage.investigationRequests, 1)
  assert.equal(result.usage.reportRequests, 3)
  assert.equal(result.report.status, 'complete')
  assert.equal(checkpoints.at(-1).messageArchives.filter(group => group.reason === 'report-correction').length, 2)
  assert(checkpoints.at(-1).messageArchives.every(group => group.messages.filter(message => message.role === 'assistant').every(message =>
    (message.tool_calls || []).every(call => group.messages.some(result => result.role === 'tool' && result.tool_call_id === call.id)))))
})

test('report repairs cannot spend unused investigation requests and an evidence-free closeout makes no empty paid report', async () => {
  let calls = 0
  const result = await runWorker({ provider: { async complete() { return ++calls === 1 ? action('read', 'read_source', {}) : action('bad-' + calls, 'submit_report', { ...valid, evidenceIds: ['foreign'] }) } },
    assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy })
  assert.equal(calls, 4)
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.report.probability, null)
  let emptyCalls = 0
  const search = { toolId: 'search_web', version: 1, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, execute() { return { status: 'ok', data: { results: [{ url: 'https://example.com/a' }] }, evidenceIds: [], summary: 'Search candidates only', observedAt: new Date().toISOString(), error: null } } }
  const empty = await runWorker({ provider: { async complete() { emptyCalls++; return action('search', 'search_web', {}) } },
    assignment: { ...assignment, budget: { ...assignment.budget, maxInvestigationRequests: 1 } }, agentSpec: spec, tools: [search], finishOnToolBudget: true })
  assert.equal(emptyCalls, 1)
  assert.equal(empty.report.status, 'insufficient')
  assert.equal(empty.report.probability, null)
  assert.deepEqual(empty.evidenceIds, [])
})

test('budget compression preserves actual search candidates for a remaining investigation before forcing closeout', async () => {
  let calls = 0
  const search = { toolId: 'search_web', version: 1, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, execute() { return { status: 'ok',
    data: { results: Array.from({ length: 12 }, (_, index) => ({ url: 'https://example.com/' + index, title: 'Actual candidate ' + index, snippet: 's'.repeat(6000) })) },
    evidenceIds: [], summary: 'Search candidates only', observedAt: new Date().toISOString(), error: null } } }
  const result = await runWorker({ provider: { async complete(input) {
    calls++
    if (calls === 1) return action('search', 'search_web', {})
    if (calls === 2) {
      assert(input.tools.some(tool => tool.function.name === 'read_source'))
      const context = JSON.parse(input.messages.find(message => message.role === 'user').content)
      assert.equal(context.receipts[0].data.results.length, 3)
      assert.equal(context.receipts[0].data.results[0].url, 'https://example.com/0')
      assert.equal(context.receipts[0].data.results[0].snippet.length, 500)
      assert.deepEqual(context.acquiredEvidenceIds, [])
      return action('read', 'read_source', {})
    }
    return action('report', 'submit_report', valid)
  } }, assignment: { ...assignment, budget: { ...assignment.budget, maxTotalTokens: 20000, reserveReportTokens: 6000, maxTokens: 2048, reportOutputTokens: 2048 } },
    agentSpec: spec, tools: [search, readTool()], finishOnToolBudget: true, reportPolicy: policy })
  assert.equal(calls, 3)
  assert.equal(result.report.status, 'complete')
})

test('one malformed or unsupported claim cannot erase separately validated model claims or silently upgrade the original opinion', async () => {
  const invalid = { ...valid, summary: 'UNVERIFIED SUMMARY claims profit of 99999.', support: [claim,
    { ...claim, claim: 'Profit is 99999.', citations: [{ evidenceId: 'e1', quote }] },
    { ...claim, claim: 'A malformed short excerpt.', citations: [{ evidenceId: 'e1', quote: '12' }] },
    { ...claim, evidenceIds: ['foreign'], citations: [{ evidenceId: 'foreign', quote }] }] }
  let calls = 0; const checkpoints = []
  const result = await runWorker({ provider: { async complete() { return ++calls === 1 ? action('read', 'read_source', {}) : action('report-' + calls, 'submit_report', invalid) } },
    assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy, onCheckpoint: value => checkpoints.push(value) })
  assert.equal(calls, 4)
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.report.probability, null)
  assert.equal(result.partialReport.status, 'insufficient')
  assert.equal(result.partialReport.probability, invalid.probability)
  assert.deepEqual(result.partialReport.support, [claim])
  assert.equal(result.partialReport.summary, quote)
  assert.deepEqual(result.partialReport.evidenceIds, ['e1'])
  assert.equal(result.partialReport.delivery.originalStatus, 'complete')
  assert.equal(result.partialReport.delivery.rejectedCount, 3)
  assert.equal(result.partialReport.delivery.mode, 'validated-partial-model-report')
  assert.equal(result.partialReport.delivery.substantiveReportComplete, false)
  assert.equal(checkpoints.at(-1).partialReport.probability, invalid.probability)
  assert(!result.partialReport.summary.includes('99999'))
})

test('a model insufficient report can retain its valid facts and exact candidate probability in a separate partial delivery', async () => {
  let calls = 0
  const candidate = { ...valid, status: 'insufficient', probability: .45, summary: 'UNVERIFIED free-form prose', missingEvidence: ['The baseline remains unverified.'] }
  const result = await runWorker({ provider: { async complete() { return ++calls === 1 ? action('read', 'read_source', {}) : action('report', 'submit_report', candidate) } },
    assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy })
  assert.equal(result.report.summary, candidate.summary)
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.partialReport.summary, quote)
  assert.equal(result.partialReport.probability, .45)
  assert.equal(result.partialReport.delivery.originalStatus, 'insufficient')
  assert.equal(result.partialReport.delivery.rejectedCount, 0)
})

test('unknown usage, absent valid claims or invalid probabilities cannot produce an eligible partial model report', async () => {
  for (const variant of ['unknown-usage', 'no-claim', 'invalid-probability']) {
    let calls = 0
    const candidate = variant === 'no-claim' ? { ...valid, support: [{ ...claim, citations: [{ evidenceId: 'e1', quote: 'FORGED QUOTE SENTENCE' }] }] }
      : variant === 'invalid-probability' ? { ...valid, probability: 1.1 } : { ...valid, evidenceIds: ['foreign'] }
    const result = await runWorker({ provider: { async complete() { return ++calls === 1 ? action('read', 'read_source', {}) : action('report-' + calls, 'submit_report', candidate, variant === 'unknown-usage' ? null : { total_tokens: 100 }) } },
      assignment, agentSpec: spec, tools: [readTool()], finishOnToolBudget: true, reportPolicy: policy })
    assert.equal(result.partialReport, undefined, variant)
    assert.equal(result.report.status, 'insufficient')
    assert.equal(result.report.probability, null)
  }
})

test('six investigation decisions, one incomplete report and its single recovery share the ten-call total cap', async () => {
  let calls = 0; const count = { value: 0 }, checkpoints = []
  const provider = { settings: { protocol: 'deepseek', thinking: 'enabled' }, async complete(input) {
    calls++
    if (calls <= 6) return action('read-' + calls, 'read_source', {})
    assert.equal(input.thinkingOverride, 'disabled')
    assert.deepEqual(input.tools.map(tool => tool.function.name), ['submit_report'])
    if (calls === 7) throw new RuntimeError('MODEL_INCOMPLETE', 'A paid truncated report.', { usage: { total_tokens: 100 } })
    return action('report-' + calls, 'submit_report', calls < 10 ? { ...valid, evidenceIds: ['foreign'] } : valid)
  } }
  const result = await runWorker({ provider, assignment: { ...assignment, modelProfile: { reasoningEffort: 'low', reportThinking: 'disabled' } },
    agentSpec: spec, tools: [readTool(count)], finishOnToolBudget: true, reportPolicy: policy, onCheckpoint: value => checkpoints.push(value) })
  assert.equal(calls, 10)
  assert.equal(count.value, 6)
  assert.equal(result.usage.investigationRequests, 6)
  assert.equal(result.usage.reportRequests, 4)
  assert.equal(result.usage.totalTokens, 1000)
  assert.equal(result.report.status, 'complete')
  assert.equal(checkpoints.at(-1).incompleteReportRecovery.afterModelRequest, 7)
})
