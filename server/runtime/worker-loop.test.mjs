import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createModelProvider } from './model-provider.mjs'
import { runWorker } from './worker-loop.mjs'

const assignment = {
  topicId: 'topic-fixture', predictionId: 'prediction-fixture', runId: 'run-fixture',
  assignmentId: 'assignment-fixture', agentInstanceId: 'worker-fixture',
  objective: '读取样例公告并计算数字。', inputEvidence: [], allowedTools: ['search_docs', 'add_numbers'],
  timePolicy: 'live',
}
const agentSpec = { agentSpecId: 'official', specVersion: 1, instructions: '核验来源并保留引用。', allowedTools: ['search_docs', 'add_numbers'] }
const result = (data, evidenceIds = []) => ({ status: 'ok', data, evidenceIds, summary: '样例处理器已返回数据。', observedAt: new Date().toISOString(), error: null, usage: { cost: null } })
const report = (evidenceIds = ['ev-document', 'ev-sum']) => ({ status: 'complete', summary: '样例两项数值相加等于五。', evidenceIds, support: [{ claim: '样例数值和为五。', evidenceIds }], counterevidence: [], missingEvidence: [], probability: 0.55, nextSuggestion: '等待正式结果。' })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const reply = (calls) => ({ message: { role: 'assistant', content: null, reasoning_content: 'PRIVATE MODEL DETAIL', tool_calls: calls }, finishReason: 'tool_calls', usage: { total_tokens: 15 } })

function fixtureTools(executions) {
  return [
    { toolId: 'search_docs', version: 1, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      execute(args, context) { executions.push({ id: 'search_docs', args, context }); return result({ values: [2, 3], source: 'fixture' }, ['ev-document']) } },
    { toolId: 'add_numbers', version: 1, inputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } }, required: ['values'], additionalProperties: false },
      execute(args, context) { executions.push({ id: 'add_numbers', args, context }); return result({ sum: args.values.reduce((sum, value) => sum + value, 0) }, ['ev-sum']) } },
  ]
}

function scripted(responses) {
  let index = 0
  return { async complete(input) {
    const entry = responses[index++]
    assert(entry, 'Unexpected extra model request')
    return typeof entry === 'function' ? entry(input) : entry
  } }
}

test('protocol HTTP fixture drives two genuine handlers with native tool result feedback', async (t) => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(request)
    const responses = [
      reply([call('lookup', 'search_docs', { query: 'appointment' })]),
      reply([call('calculate', 'add_numbers', { values: [2, 3] })]),
      reply([call('finish', 'submit_report', report())]),
    ]
    const answer = responses[requests.length - 1]
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: answer.message, finish_reason: answer.finishReason }], usage: answer.usage }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const provider = createModelProvider({ WORLD_API_KEY: 'fixture-only', WORLD_MODEL_NAME: 'protocol-fixture', WORLD_BASE_URL: `http://127.0.0.1:${server.address().port}` })
  const executions = []
  const events = []
  const checkpoints = []
  const output = await runWorker({ provider, assignment, agentSpec, tools: fixtureTools(executions), onEvent: (event) => events.push(event), onCheckpoint: async (state) => checkpoints.push(state) })
  assert.equal(requests.length, 3)
  assert.deepEqual(executions.map(({ id }) => id), ['search_docs', 'add_numbers'])
  assert.equal(executions[0].context.toolCallId, 'lookup')
  assert.equal(executions[0].context.toolId, 'search_docs')
  assert.match(executions[0].context.argsHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(executions[1].context.inputEvidenceIds, ['ev-document'])
  const assistant = requests[1].messages.find(({ role }) => role === 'assistant')
  assert.equal(assistant.reasoning_content, 'PRIVATE MODEL DETAIL')
  assert.equal(assistant.tool_calls[0].id, 'lookup')
  const feedback = requests[1].messages.at(-1)
  assert.equal(feedback.role, 'tool')
  assert.equal(feedback.tool_call_id, 'lookup')
  assert.equal(JSON.parse(feedback.content).data.values[0], 2)
  assert.equal(JSON.parse(requests[2].messages.at(-1).content).data.sum, 5)
  assert.equal(output.report.probability, 0.55)
  assert.equal(output.report.assignmentId, assignment.assignmentId)
  assert.deepEqual(output.usage, { modelRequests: 3, toolCalls: 2, totalTokens: 45, unknownUsage: false })
  assert(checkpoints.at(-1).report)
  assert(checkpoints.at(-1).messages.some((message) => message.reasoning_content))
  assert(!JSON.stringify(events).includes('PRIVATE MODEL DETAIL'))
  assert(!Object.hasOwn(output, 'messages'))
})

test('permissions, malformed arguments and forged report evidence produce error feedback without execution', async () => {
  const executions = []
  const provider = scripted([
    ({ tools }) => {
      assert(!tools.some(({ function: fn }) => fn.name === 'search_docs'))
      return reply([call('forbidden', 'search_docs', { query: 'x' })])
    },
    ({ messages }) => { assert.equal(JSON.parse(messages.at(-1).content).error.code, 'TOOL_FORBIDDEN'); return reply([call('malformed', 'add_numbers', { values: 'wrong type' })]) },
    ({ messages }) => { assert.equal(JSON.parse(messages.at(-1).content).error.code, 'INVALID_ARGUMENTS'); return reply([call('forged', 'submit_report', report(['fabricated']))]) },
    ({ messages }) => {
      assert.equal(JSON.parse(messages.at(-1).content).error.code, 'INVALID_CITATION')
      return reply([call('honest', 'submit_report', { ...report([]), status: 'insufficient', probability: null, support: [], missingEvidence: ['正式材料'] })])
    },
  ])
  const output = await runWorker({ provider, assignment, agentSpec: { ...agentSpec, allowedTools: ['add_numbers'] }, tools: fixtureTools(executions) })
  assert.equal(executions.length, 0)
  assert.deepEqual(output.evidenceIds, [])
  assert.equal(output.report.status, 'insufficient')
})

test('tool failures cannot introduce evidence and are visible as failures', async () => {
  const events = []
  const tools = fixtureTools([])
  tools[0].execute = () => ({ ...result(null, ['forged-failure-evidence']), status: 'error', error: { code: 'SOURCE_UNAVAILABLE' } })
  const provider = scripted([
    reply([call('source', 'search_docs', { query: 'x' })]),
    ({ messages }) => {
      assert.equal(JSON.parse(messages.at(-1).content).status, 'error')
      assert.deepEqual(JSON.parse(messages.at(-1).content).evidenceIds, [])
      return reply([call('done', 'submit_report', { ...report([]), status: 'blocked', probability: null, support: [] })])
    },
  ])
  const output = await runWorker({ provider, assignment, agentSpec, tools, onEvent: (event) => events.push(event) })
  assert.deepEqual(output.evidenceIds, [])
  assert(events.some(({ type }) => type === 'tool.failed'))
})

test('native tool call IDs must be nonempty strings of at most 120 characters before execution', async () => {
  for (const invalidId of [1, {}, '', '   ', 'x'.repeat(121)]) {
    const executions = []
    await assert.rejects(runWorker({
      provider: scripted([reply([call(invalidId, 'search_docs', { query: 'x' })])]),
      assignment, agentSpec, tools: fixtureTools(executions),
    }), { code: 'MODEL_PROTOCOL' })
    assert.equal(executions.length, 0, 'Malformed protocol IDs cannot reach a real tool handler')
  }
})

test('private checkpoint resumes pending and completed tool turns without repeating saved handlers', async () => {
  for (const checkpointPoint of ['assistant', 'receipt']) {
    const executions = []
    let saved
    const provider = scripted([
      reply([call('lookup', 'search_docs', { query: 'x' })]),
      reply([call('finish', 'submit_report', report(['ev-document']))]),
    ])
    const options = { provider, assignment, agentSpec, tools: fixtureTools(executions) }
    await assert.rejects(runWorker({ ...options, onCheckpoint(state) {
      const matches = checkpointPoint === 'assistant'
        ? state.pendingToolCalls.length === 1 && state.usage.toolCalls === 0
        : state.toolExecutions.length === 1
      if (matches) { saved = state; throw new Error('fixture process interruption') }
    } }), /fixture process interruption/)
    const output = await runWorker({ ...options, resume: saved })
    assert.equal(executions.length, 1)
    assert.equal(output.usage.modelRequests, 2)
    assert.equal(output.report.status, 'complete')
    const recordedCall = saved.messages.find(({ role }) => role === 'assistant').tool_calls
    assert.equal(recordedCall.length, 1, 'Dequeuing a pending call must not mutate native assistant history')
    assert.equal(recordedCall[0].id, 'lookup')
    await assert.rejects(runWorker({ ...options, resume: saved, assignment: { ...assignment, predictionId: 'other-prediction' } }), { code: 'CHECKPOINT_INVALID' })
  }
})

test('cancellation ignores a late handler response and cannot submit a report', async () => {
  let completeTool
  let announceStart
  const started = new Promise((resolve) => { announceStart = resolve })
  const held = new Promise((resolve) => { completeTool = resolve })
  const controller = new AbortController()
  const events = []
  const checkpoints = []
  const tools = fixtureTools([])
  tools[0].execute = () => { announceStart(); return held }
  const pending = runWorker({ provider: scripted([reply([call('lookup', 'search_docs', { query: 'x' })])]), assignment, agentSpec, tools, signal: controller.signal, onEvent: (event) => events.push(event), onCheckpoint: (state) => checkpoints.push(state) })
  await started
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  completeTool(result('late', ['late-evidence']))
  await new Promise((resolve) => setImmediate(resolve))
  assert(!events.some(({ type }) => ['tool.completed', 'assignment.completed'].includes(type)))
  assert.deepEqual(checkpoints.at(-1).evidenceIds, [])
  assert.equal(checkpoints.at(-1).report, null)
})

test('a persisted tool reservation resumes within the last budget slot before execution', async () => {
  const executions = []
  const provider = scripted([
    reply([call('reserved', 'search_docs', { query: 'x' })]),
    reply([call('finish', 'submit_report', report(['ev-document']))]),
  ])
  const options = { provider, assignment, agentSpec, tools: fixtureTools(executions), limits: { maxToolCalls: 1 } }
  let saved
  await assert.rejects(runWorker({ ...options, onCheckpoint(state) {
    if (state.inFlightToolCallId === 'reserved') {
      saved = state
      throw new Error('fixture interruption after budget reservation')
    }
  } }), /fixture interruption after budget reservation/)
  assert.equal(executions.length, 0)
  assert.equal(saved.usage.toolCalls, 1)
  const checkpoints = []
  const output = await runWorker({ ...options, resume: saved, onCheckpoint: (state) => checkpoints.push(state) })
  assert.equal(executions.length, 1)
  assert.equal(output.usage.toolCalls, 1)
  assert.equal(output.report.status, 'complete')
  assert.equal(checkpoints.at(-1).inFlightToolCallId, null)
})

test('budgets stop repeated calls and truncated model responses cannot complete a report', async () => {
  const executions = []
  await assert.rejects(runWorker({
    provider: scripted([reply([call('a', 'search_docs', { query: 'x' })]), reply([call('b', 'search_docs', { query: 'y' })])]),
    assignment, agentSpec, tools: fixtureTools(executions), limits: { maxToolCalls: 1 },
  }), { code: 'BUDGET_EXHAUSTED' })
  assert.equal(executions.length, 1)
  await assert.rejects(runWorker({ provider: scripted([{ ...reply([]), finishReason: 'length' }]), assignment, agentSpec, tools: fixtureTools([]) }), { code: 'MODEL_PROTOCOL' })
})
