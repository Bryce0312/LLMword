import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './worker-loop.mjs'
import { createModelProvider, RuntimeError } from './model-provider.mjs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

const spec = { agentSpecId: 'verification', specVersion: 1, instructions: '读取实际材料后交报告，不编造未来结果。', allowedTools: ['read_source'] }
const base = { topicId: 'topic', predictionId: 'prediction', runId: 'run', assignmentId: 'assignment', agentInstanceId: 'worker',
  objective: '有限预算完成证据调查', inputEvidence: [], allowedTools: ['read_source'],
  budget: { maxModelRequests: 6, maxToolCalls: 4, maxTotalTokens: 65536, maxTokens: 8192, reserveReportTokens: 18000, reportRepairRequests: 1, reportOutputTokens: 8192, maxRetries: 0, inputAwareCloseout: true } }
const action = (id, name, args, tokens) => ({ message: { role: 'assistant', content: null, reasoning_content: 'PRIVATE_REASONING_NOT_SUMMARY',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls', usage: { total_tokens: tokens } })
const report = { status: 'complete', summary: '已读取材料，保留未来结果未知。', evidenceIds: ['evidence-1'], support: [], counterevidence: [], missingEvidence: [], probability: null, nextSuggestion: '总结已有资料。' }
function sourceTool(count) { return { toolId: 'read_source', version: 1, inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async execute() { count.value++; return { status: 'ok', data: { text: '已实际读取的来源原文。'.repeat(200) }, evidenceIds: ['evidence-1'], summary: '已读原文', observedAt: new Date().toISOString(), error: null } } } }

test('closeout admission budgets input and reserves reports before investigation can use all tokens', async () => {
  let calls = 0; const requests = [], checkpoints = [], events = [], count = { value: 0 }
  const provider = { async complete(input) {
    requests.push(input); calls++
    if (calls === 1) return action('read', 'read_source', {}, 50000)
    assert.deepEqual(input.tools.map(t => t.function.name), ['submit_report'])
    assert(input.messages[0].content.includes('只允许submit_report'))
    assert(!JSON.stringify(input.messages).includes('PRIVATE_REASONING_NOT_SUMMARY'))
    assert(input.messages.at(-1).content.includes('已实际读取的来源原文'))
    assert(input.maxTokens < 8192, 'current input and correction reserve must reduce completion cap')
    return action('report', 'submit_report', report, 4500)
  } }
  const result = await runWorker({ provider, assignment: base, agentSpec: spec, tools: [sourceTool(count)], finishOnToolBudget: true,
    onCheckpoint: value => checkpoints.push(value), onEvent: value => events.push(value) })
  assert.equal(result.report.status, 'complete')
  assert.equal(calls, 2)
  assert.equal(count.value, 1)
  assert.equal(result.usage.totalTokens, 54500)
  assert(events.some(e => e.type === 'model.context_compacted'))
  assert(checkpoints.at(-1).messageArchives.some(group => JSON.stringify(group.messages).includes('PRIVATE_REASONING_NOT_SUMMARY')))
  assert(!JSON.stringify(events).includes('PRIVATE_REASONING_NOT_SUMMARY'))
})

test('the penultimate request is report-only and the last request can repair an invalid report', async () => {
  const count = { value: 0 }; let calls = 0
  const provider = { async complete(input) {
    calls++
    if (calls <= 4) {
      assert(input.tools.some(t => t.function.name === 'read_source'))
      return action('read-' + calls, 'read_source', {}, 100)
    }
    assert.deepEqual(input.tools.map(t => t.function.name), ['submit_report'])
    if (calls === 5) return action('bad-report', 'submit_report', { ...report, evidenceIds: ['forged'] }, 100)
    assert(input.messages.some(m => m.role === 'tool' && m.content.includes('INVALID_CITATION')))
    return action('fixed-report', 'submit_report', report, 100)
  } }
  const result = await runWorker({ provider, assignment: base, agentSpec: spec, tools: [sourceTool(count)], finishOnToolBudget: true })
  assert.equal(calls, 6)
  assert.equal(result.report.status, 'complete')
  assert(!result.evidenceIds.includes('forged'))
})

test('a paid report is validated instead of discarded when provider usage exceeds the admission estimate', async () => {
  const count = { value: 0 }, events = []; let calls = 0
  const provider = { async complete() {
    calls++
    return calls === 1 ? action('read', 'read_source', {}, 100) : action('report', 'submit_report', report, 66000)
  } }
  const result = await runWorker({ provider, assignment: base, agentSpec: spec, tools: [sourceTool(count)], finishOnToolBudget: true, onEvent: e => events.push(e) })
  assert.equal(result.usage.totalTokens, 66100)
  assert.equal(result.report.status, 'complete')
  assert(events.some(e => e.type === 'budget.exceeded'))
  assert.equal(events.filter(e => e.type === 'model.failed').length, 0)
  assert.equal(calls, 2)
})

test('an unrepairable report produces an explicit insufficient harness receipt, never a fabricated complete opinion', async () => {
  const count = { value: 0 }, events = []; let calls = 0
  const assignment = { ...base, budget: { ...base.budget, maxModelRequests: 3 } }
  const provider = { async complete() { return ++calls === 1 ? action('read', 'read_source', {}, 100) : action('invalid-' + calls, 'submit_report', { ...report, evidenceIds: ['forged'] }, 100) } }
  const result = await runWorker({ provider, assignment, agentSpec: spec, tools: [sourceTool(count)], finishOnToolBudget: true,
    reportPolicy: { version: 'fixture', check: value => value.evidenceIds.some(id => id !== 'evidence-1') ? '无效引用' : null, review: value => value },
    onEvent: e => events.push(e) })
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.report.probability, null)
  assert.equal(result.report.delivery.modelGenerated, false)
  assert.equal(result.budgetCloseout.substantiveReportComplete, false)
  assert.deepEqual(result.report.evidenceIds, ['evidence-1'])
  assert.equal(result.report.support.length, 0)
  assert(events.some(e => e.type === 'budget.closeout'))
  assert.equal(calls, 3)
})

test('input that cannot fit gets a free insufficient receipt without starting a doomed model request', async () => {
  let calls = 0
  const assignment = { ...base, budget: { ...base.budget, maxTotalTokens: 1200, reserveReportTokens: 600 } }
  const result = await runWorker({ provider: { async complete() { calls++; throw new Error('must not call') } }, assignment,
    agentSpec: { ...spec, instructions: '非常长的方法要求。'.repeat(1000) }, tools: [], finishOnToolBudget: true })
  assert.equal(calls, 0)
  assert.equal(result.usage.modelRequests, 0)
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.report.probability, null)
  assert.deepEqual(result.report.evidenceIds, [])
})

test('cancellation never becomes a successful or insufficient budget closeout report', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(runWorker({ provider: {}, assignment: base, agentSpec: spec, tools: [], finishOnToolBudget: true, signal: controller.signal }), { code: 'CANCELLED' })
})

test('opt-in DeepSeek report serialization disables thinking, keeps later real excerpts and permits a grounded repair', async () => {
  const requests = [], checkpoints = [], events = []
  const quote = 'The actually read source confirms the observation.'
  const text = 'a'.repeat(2600) + quote + 'b'.repeat(4000)
  const assignment = { ...base, modelProfile: { version: 'report-serialization-v1', reasoningEffort: 'low', reportThinking: 'disabled' },
    budget: { ...base.budget, maxModelRequests: 3 } }
  const tools = [{ ...sourceTool({ value: 0 }), async execute() { return { status: 'ok', data: { text }, evidenceIds: ['evidence-1'], summary: 'Actual original body', observedAt: new Date().toISOString(), error: null } } }]
  const validReport = { ...report, probability: .6, support: [{ claim: quote, basis: 'fact', evidenceIds: ['evidence-1'], citations: [{ evidenceId: 'evidence-1', quote }] }] }
  const provider = createModelProvider({ WORLD_API_KEY: 'TEST_ONLY', WORLD_MODEL_NAME: 'test-only', WORLD_BASE_URL: 'https://api.deepseek.com', WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled' }, async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body)
    const reply = requests.length === 1 ? action('source', 'read_source', {}, 100)
      : action('report-' + requests.length, 'submit_report', requests.length === 2
        ? { ...validReport, support: [{ ...validReport.support[0], citations: [{ evidenceId: 'evidence-1', quote: 'FORGED SOURCE SENTENCE' }] }] }
        : validReport, 100)
    return Response.json({ choices: [{ message: reply.message, finish_reason: reply.finishReason }], usage: reply.usage })
  })
  const result = await runWorker({ provider, assignment, agentSpec: spec, tools, finishOnToolBudget: true,
    reportPolicy: { version: 'actual-quoted-source', check(value) { try { validateGroundedClaims(value.support, [{ evidenceId: 'evidence-1', text, readBy: ['assignment'] }], { readerId: 'assignment' }); return null } catch (error) { return error.message } }, review: value => value },
    onCheckpoint: value => checkpoints.push(value), onEvent: value => events.push(value) })
  assert.equal(result.report.status, 'complete')
  assert.equal(requests.length, 3)
  assert.equal(requests[0].thinking.type, 'enabled'); assert.equal(requests[0].reasoning_effort, 'low')
  for (const body of requests.slice(1)) {
    assert.equal(body.thinking.type, 'disabled'); assert(!Object.hasOwn(body, 'reasoning_effort'))
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['submit_report'])
    assert(JSON.stringify(body.messages).includes(quote), 'An excerpt beyond the former 1800-character cutoff must remain available')
  }
  assert(requests[2].messages.some(item => item.role === 'tool' && item.tool_call_id === 'report-2'))
  assert.equal(result.report.support[0].citations[0].quote, quote)
  assert(checkpoints.at(-1).messageArchives.some(group => group.messages.some(item => item.role === 'tool' && item.tool_call_id === 'source')))
  assert.equal(provider.settings.thinking, 'enabled')
  assert.equal(events.filter(item => item.type === 'model.requested' && item.payload.reportThinkingDisabled).length, 2)
  assert(!JSON.stringify(events).includes('PRIVATE_REASONING'))
})

test('report thinking override is absent for legacy budgets, generic providers and profiles without opt-in', async () => {
  for (const variant of [
    { inputAwareCloseout: false, settings: { protocol: 'deepseek', thinking: 'enabled' }, modelProfile: { reportThinking: 'disabled' } },
    { inputAwareCloseout: true, settings: { protocol: 'openai', thinking: null }, modelProfile: { reportThinking: 'disabled' } },
    { inputAwareCloseout: true, settings: { protocol: 'deepseek', thinking: 'enabled' }, modelProfile: {} },
  ]) {
    let calls = 0
    const provider = { settings: variant.settings, async complete(input) {
      assert.equal(Object.hasOwn(input, 'thinkingOverride'), false)
      return ++calls === 1 ? action('read', 'read_source', {}, 100) : action('report', 'submit_report', report, 100)
    } }
    const result = await runWorker({ provider, assignment: { ...base, modelProfile: variant.modelProfile,
      budget: { ...base.budget, inputAwareCloseout: variant.inputAwareCloseout, maxModelRequests: variant.inputAwareCloseout ? 3 : 2 } },
      agentSpec: spec, tools: [sourceTool({ value: 0 })], finishOnToolBudget: true })
    assert.equal(result.report.status, 'complete')
  }
})

test('working report context contains at most four actual source bodies of 4000 characters while full receipts remain archived', async () => {
  const checkpoints = []; let pages = 0, calls = 0
  const evidenceIds = Array.from({ length: 6 }, (_, index) => 'page-' + (index + 1))
  const provider = { async complete(input) {
    calls++
    if (calls === 1) return { ...action('unused', 'read_source', {}, 100), message: { role: 'assistant', tool_calls: evidenceIds.map((id) => action(id, 'read_source', {}, 0).message.tool_calls[0]) } }
    const context = JSON.parse(input.messages.find(item => item.role === 'user').content)
    assert.equal(context.receipts.length, 6)
    const bodies = context.receipts.filter(item => typeof item.data?.text === 'string')
    assert.equal(bodies.length, 4)
    assert.deepEqual(bodies.map(item => item.evidenceIds[0]), evidenceIds.slice(-4))
    assert(bodies.every(item => item.data.text.length === 4000))
    assert.deepEqual(context.acquiredEvidenceIds, evidenceIds)
    return action('report', 'submit_report', { ...report, evidenceIds }, 100)
  } }
  const tool = { ...sourceTool({ value: 0 }), async execute() { const evidenceId = evidenceIds[pages++]; return { status: 'ok', data: { text: evidenceId + 'x'.repeat(5500) }, evidenceIds: [evidenceId], summary: 'Actual read body', observedAt: new Date().toISOString(), error: null } } }
  const result = await runWorker({ provider, assignment: { ...base, budget: { ...base.budget, maxTotalTokens: 262144, maxToolCalls: 6, maxModelRequests: 3 } },
    agentSpec: spec, tools: [tool], finishOnToolBudget: true, onCheckpoint: value => checkpoints.push(value) })
  assert.equal(result.report.status, 'complete')
  const archive = checkpoints.at(-1).messageArchives[0].messages.filter(item => item.role === 'tool')
  assert.equal(archive.length, 6)
  assert(archive.every(item => JSON.parse(item.content).data.text.length > 5500))
})

test('a paid incomplete generation gets one admitted report serialization without executing its truncated tool action', async () => {
  for (const failureAt of [2, 5]) {
    const requests = [], checkpoints = [], count = { value: 0 }, events = []
    const provider = createModelProvider({ WORLD_API_KEY: 'TEST_ONLY', WORLD_MODEL_NAME: 'test-only', WORLD_BASE_URL: 'https://api.deepseek.com', WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled' }, async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body)
      const index = requests.length
      const reply = index <= failureAt ? action('read-' + index, 'read_source', {}, 100) : action('final-report', 'submit_report', report, 100)
      return Response.json({ choices: [{ message: reply.message, finish_reason: index === failureAt ? 'length' : reply.finishReason }], usage: { total_tokens: index === failureAt ? 1200 : 100 } })
    })
    const assignment = { ...base, modelProfile: { reasoningEffort: 'low', reportThinking: 'disabled' } }
    const result = await runWorker({ provider, assignment, agentSpec: spec, tools: [sourceTool(count)], finishOnToolBudget: true,
      onCheckpoint: value => checkpoints.push(value), onEvent: value => events.push(value) })
    assert.equal(result.report.status, 'complete')
    assert.equal(requests.length, failureAt + 1)
    assert(requests.length <= 6)
    assert.equal(count.value, failureAt - 1, 'The truncated read_source action must never execute or re-execute an earlier call')
    assert.equal(result.usage.totalTokens, failureAt * 100 + 1200)
    assert.equal(requests.at(-1).thinking.type, 'disabled')
    assert.deepEqual(requests.at(-1).tools.map(tool => tool.function.name), ['submit_report'])
    assert(!JSON.stringify(requests.at(-1).messages).includes('read-' + failureAt), 'No truncated assistant candidate may enter the recovery protocol')
    assert.equal(checkpoints.at(-1).incompleteReportRecovery.afterModelRequest, failureAt)
    assert.equal(events.filter(item => item.type === 'model.report_recovery_requested').length, 1)
  }
})

test('incomplete serialization recovery is attempted only once and exhausted calls keep an insufficient receipt', async () => {
  let calls = 0
  const provider = { settings: { protocol: 'deepseek', thinking: 'enabled' }, async complete() {
    if (++calls === 1) return action('source', 'read_source', {}, 100)
    throw new RuntimeError('MODEL_INCOMPLETE', 'Fixture truncation', { usage: { total_tokens: 100 } })
  } }
  const assignment = { ...base, modelProfile: { reportThinking: 'disabled' } }
  await assert.rejects(runWorker({ provider, assignment, agentSpec: spec, tools: [sourceTool({ value: 0 })], finishOnToolBudget: true }), { code: 'MODEL_INCOMPLETE' })
  assert.equal(calls, 3, 'A second truncation must not start a second serialization recovery')
  let lastCallCount = 0
  const result = await runWorker({ provider: { ...provider, async complete() { lastCallCount++; throw new RuntimeError('MODEL_INCOMPLETE', 'Fixture last-call truncation', { usage: { total_tokens: 100 } }) } },
    assignment: { ...assignment, budget: { ...base.budget, maxModelRequests: 1 } }, agentSpec: spec, tools: [], finishOnToolBudget: true })
  assert.equal(lastCallCount, 1)
  assert.equal(result.report.status, 'insufficient')
  assert.equal(result.report.probability, null)
  assert.equal(result.report.delivery.substantiveReportComplete, false)
})

test('legacy and unknown-usage truncations do not gain a new paid serialization request', async () => {
  for (const legacy of [true, false]) {
    let calls = 0
    const provider = { settings: { protocol: 'deepseek', thinking: 'enabled' }, async complete() {
      if (++calls === 1) return action('source', 'read_source', {}, 100)
      throw new RuntimeError('MODEL_INCOMPLETE', 'Fixture truncation', legacy ? { usage: { total_tokens: 100 } } : {})
    } }
    await assert.rejects(runWorker({ provider, assignment: { ...base, modelProfile: { reportThinking: 'disabled' },
      budget: { ...base.budget, inputAwareCloseout: !legacy } }, agentSpec: spec, tools: [sourceTool({ value: 0 })], finishOnToolBudget: true }), { code: 'MODEL_INCOMPLETE' })
    assert.equal(calls, 2)
  }
})
