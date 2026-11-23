import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelProvider } from './model-provider.mjs'
import { runWorker } from './worker-loop.mjs'

const environment = { WORLD_API_KEY: 'fixture-credential', WORLD_MODEL_NAME: 'fixture-model', WORLD_BASE_URL: 'http://127.0.0.1:9999/v1' }
const message = { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_docs', arguments: '{"query":"appointment"}' } }], reasoning_content: 'PRIVATE PROTOCOL FIXTURE' }

test('versioned research calls can lower reasoning effort without changing the provider defaults', async () => {
  const bodies = []
  const provider = createModelProvider({ ...environment, WORLD_BASE_URL: 'https://api.deepseek.com', WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled', WORLD_MODEL_REASONING_EFFORT: 'high' }, async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { total_tokens: 10 } })
  })
  await provider.complete({ messages: [], tools: [], maxTokens: 100, reasoningEffortOverride: 'low' })
  await provider.complete({ messages: [], tools: [], maxTokens: 100 })
  assert.equal(bodies[0].reasoning_effort, 'low'); assert.equal(bodies[1].reasoning_effort, 'high')
  assert.equal(provider.settings.reasoningEffort, 'high')
})

test('a DeepSeek report can disable thinking for one request without changing durable provider settings', async () => {
  const bodies = []
  const provider = createModelProvider({ ...environment, WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled', WORLD_MODEL_REASONING_EFFORT: 'high' }, async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { total_tokens: 10 } })
  })
  const identity = provider.configurationId
  await provider.complete({ messages: [message], tools: [], maxTokens: 100, thinkingOverride: 'disabled', reasoningEffortOverride: 'low' })
  await provider.complete({ messages: [], tools: [], maxTokens: 100 })
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
  assert(!Object.hasOwn(bodies[0], 'reasoning_effort'))
  assert.equal(bodies[0].tool_choice, 'auto')
  assert.deepEqual(bodies[0].messages, [message], 'Private native protocol is not stripped when switching report mode')
  assert.deepEqual(bodies[1].thinking, { type: 'enabled' })
  assert.equal(bodies[1].reasoning_effort, 'high')
  assert.equal(provider.settings.thinking, 'enabled')
  assert.equal(provider.configurationId, identity)
  for (const thinkingOverride of ['enabled', 'automatic', null]) await assert.rejects(provider.complete({ messages: [], tools: [], thinkingOverride }), { code: 'MODEL_CONFIG' })
  const compatible = createModelProvider(environment, () => assert.fail('DeepSeek-only override must not reach a generic endpoint'))
  await assert.rejects(compatible.complete({ messages: [], tools: [], thinkingOverride: 'disabled' }), { code: 'MODEL_CONFIG' })
  assert.equal(bodies.length, 2)
})

test('native provider sends tool definitions and returns the full assistant message', async () => {
  const requests = []
  const provider = createModelProvider(environment, async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return Response.json({ model: 'fixture-version', choices: [{ message, finish_reason: 'tool_calls' }], usage: { total_tokens: 21 } })
  })
  const messages = [{ role: 'user', content: 'Check appointment.' }]
  const tools = [{ type: 'function', function: { name: 'search_docs', parameters: { type: 'object' } } }]
  const result = await provider.complete({ messages, tools, maxTokens: 100 })
  assert.equal(requests[0].url, 'http://127.0.0.1:9999/v1/chat/completions')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-credential')
  assert.deepEqual(requests[0].body, { model: 'fixture-model', messages, tools, tool_choice: 'auto', max_tokens: 100, stream: false })
  assert.deepEqual(result.message, message)
  assert.equal(result.model, 'fixture-version')
  assert.equal(result.usage.total_tokens, 21)
})

test('official DeepSeek thinking controls, output cap and timeout are explicit and part of the durable provider identity', async () => {
  const requests = []
  const official = { ...environment, WORLD_BASE_URL: 'https://api.deepseek.com', WORLD_MODEL_NAME: 'deepseek-flash' }
  const transport = async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] }) }
  const disabled = createModelProvider(official, transport)
  await disabled.complete({ messages: [{ role: 'user', content: 'check' }], tools: [] })
  assert.deepEqual(requests[0].thinking, { type: 'disabled' })
  assert(!Object.hasOwn(requests[0], 'reasoning_effort'))
  const enabledEnv = { ...official, WORLD_MODEL_THINKING: 'enabled', WORLD_MODEL_REASONING_EFFORT: 'high', WORLD_MODEL_MAX_OUTPUT_TOKENS: '8192', WORLD_MODEL_TIMEOUT_MS: '180000' }
  const enabled = createModelProvider(enabledEnv, transport)
  await enabled.complete({ messages: [{ role: 'user', content: 'check' }], tools: [], maxTokens: 12000 })
  assert.deepEqual(requests[1].thinking, { type: 'enabled' }); assert.equal(requests[1].reasoning_effort, 'high')
  assert.equal(requests[1].max_tokens, 8192); assert(!Object.hasOwn(requests[1], 'tool_choice'))
  await enabled.complete({ messages: [], tools: [], maxTokens: 2000 })
  assert.equal(requests[2].max_tokens, 2000, 'Environment must never raise a smaller harness output limit')
  assert.equal(enabled.settings.timeoutMs, 180000)
  assert.equal(enabled.settings.maxOutputTokens, 8192)
  assert.notEqual(enabled.configurationId, disabled.configurationId)
  for (const patch of [{ WORLD_MODEL_REASONING_EFFORT: 'max' }, { WORLD_MODEL_MAX_OUTPUT_TOKENS: '9000' }, { WORLD_MODEL_TIMEOUT_MS: '240000' }, { WORLD_MODEL_NAME: 'deepseek-v4-pro' }]) {
    assert.notEqual(createModelProvider({ ...enabledEnv, ...patch }, transport).configurationId, enabled.configurationId)
  }
  assert.equal(createModelProvider({ ...enabledEnv, WORLD_API_KEY: 'rotated-fixture-key' }, transport).configurationId, enabled.configurationId)
  assert(!JSON.stringify(enabled.settings).includes(environment.WORLD_API_KEY))
})

test('generic compatible providers receive no DeepSeek-only defaults and invalid thinking settings fail before transport', async () => {
  const invalid = [
    { WORLD_MODEL_THINKING: 'enabled' }, { WORLD_MODEL_THINKING: 'automatic' },
    { WORLD_MODEL_REASONING_EFFORT: 'high' }, { WORLD_MODEL_MAX_OUTPUT_TOKENS: '0' },
    { WORLD_MODEL_MAX_OUTPUT_TOKENS: '393217' }, { WORLD_MODEL_TIMEOUT_MS: '2147483648' },
    { WORLD_MODEL_PROTOCOL: 'unknown' },
  ]
  for (const patch of invalid) assert.throws(() => createModelProvider({ ...environment, ...patch }), { code: 'MODEL_CONFIG' })
  for (const patch of [{ WORLD_MODEL_REASONING_EFFORT: 'medium' }, { WORLD_MODEL_THINKING: 'disabled', WORLD_MODEL_REASONING_EFFORT: 'high' }]) {
    assert.throws(() => createModelProvider({ ...environment, WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled', ...patch }), { code: 'MODEL_CONFIG' })
  }
  let body
  const provider = createModelProvider(environment, async (_url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ message: { role: 'assistant', content: 'finished', tool_calls: null }, finish_reason: 'stop' }] }) })
  const response = await provider.complete({ messages: [], tools: [], maxTokens: 10000 })
  assert(!Object.hasOwn(body, 'thinking')); assert(!Object.hasOwn(body, 'reasoning_effort'))
  assert.equal(body.max_tokens, 10000, 'Unconfigured global cap preserves existing explicit per-call limits')
  assert.equal(response.message.tool_calls, null)
})

test('enabled thinking preserves every assistant reasoning field and matched native tool result across actual worker handlers', async () => {
  const requests = []; const executed = []; const events = []
  const action = (id, name, args, reasoning) => ({ role: 'assistant', content: '', reasoning_content: reasoning,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const finalReport = { status: 'complete', summary: 'Read and checked two provided fixture records.',
    evidenceIds: ['ev_read', 'ev_check'], support: [], counterevidence: [], missingEvidence: [], probability: null, nextSuggestion: 'Done.' }
  const replies = [action('read_1', 'read_doc', {}, 'PRIVATE REASONING STEP ONE'),
    action('check_2', 'check_doc', {}, 'PRIVATE REASONING STEP TWO'), action('submit_3', 'submit_report', finalReport, 'PRIVATE REASONING FINAL')]
  const provider = createModelProvider({ ...environment, WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled', WORLD_MODEL_REASONING_EFFORT: 'high', WORLD_MODEL_MAX_OUTPUT_TOKENS: '8192' }, async (_url, options) => {
    requests.push(JSON.parse(options.body)); const reply = replies[requests.length - 1]
    return Response.json({ choices: [{ message: reply, finish_reason: 'tool_calls' }], usage: { total_tokens: 100 } })
  })
  const tools = ['read_doc', 'check_doc'].map((toolId, index) => ({ toolId, version: 1,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute(_args, context) { executed.push(context.toolCallId); return { status: 'ok', data: { text: `Source ${index}` },
      evidenceIds: [index ? 'ev_check' : 'ev_read'], summary: 'Actual fixture handler result', observedAt: '2026-11-19T00:00:00.000Z', error: null, usage: null } },
  }))
  const output = await runWorker({ provider, tools,
    assignment: { topicId: 'topic_thinking', predictionId: 'prediction_thinking', runId: 'run_thinking', assignmentId: 'assignment_thinking', agentInstanceId: 'actor_thinking',
      objective: 'Read and check the two fixture sources.', inputEvidence: [], allowedTools: ['read_doc', 'check_doc'], timePolicy: 'live' },
    agentSpec: { agentSpecId: 'verification', specVersion: 1, instructions: 'Use actual tool results.', allowedTools: ['read_doc', 'check_doc'] },
    onEvent(event) { events.push(event) },
  })
  assert.deepEqual(executed, ['read_1', 'check_2'])
  assert.equal(requests[1].messages.find((item) => item.role === 'assistant').reasoning_content, replies[0].reasoning_content)
  assert.deepEqual(requests[2].messages.filter((item) => item.role === 'assistant').map((item) => item.reasoning_content), replies.slice(0, 2).map((item) => item.reasoning_content))
  assert.deepEqual(requests[2].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id), ['read_1', 'check_2'])
  assert(requests.every((body) => body.thinking.type === 'enabled' && body.reasoning_effort === 'high'))
  assert.equal(output.report.status, 'complete'); assert.equal(output.usage.totalTokens, 300)
  assert(!JSON.stringify(output).includes('PRIVATE REASONING')); assert(!JSON.stringify(events).includes('PRIVATE REASONING'))
})

test('thinking adapter replays reasoning on earlier no-tool assistant turns without stripping or mutating it', async () => {
  const previous = { role: 'assistant', content: 'I will verify the claim.', reasoning_content: 'PRIVATE EARLIER NO-TOOL REASONING', tool_calls: null }
  const messages = [{ role: 'user', content: 'Check one' }, previous, { role: 'user', content: 'Now use a tool.' }]
  let sent
  const provider = createModelProvider({ ...environment, WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'enabled' }, async (_url, options) => {
    sent = JSON.parse(options.body); return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] })
  })
  const output = await provider.complete({ messages, tools: [{ type: 'function', function: { name: 'search_docs', parameters: { type: 'object' } } }] })
  assert.deepEqual(sent.messages[1], previous)
  assert.equal(output.message.reasoning_content, message.reasoning_content)
  output.message.reasoning_content = 'caller mutation'
  assert.equal(previous.reasoning_content, 'PRIVATE EARLIER NO-TOOL REASONING')
})

test('HTTP errors are actionable without echoing service response bodies or credentials', async () => {
  const provider = createModelProvider(environment, async () => Response.json({ message: 'sensitive-service-detail' }, { status: 429, headers: { 'retry-after': '2' } }))
  await assert.rejects(provider.complete({ messages: [], tools: [] }), (error) => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED')
    assert.equal(error.status, 429)
    assert.equal(error.retryable, true)
    assert.equal(error.retryAfterMs, 2000)
    assert(!error.message.includes('sensitive-service-detail'))
    assert(!error.message.includes('fixture-credential'))
    return true
  })
})

test('model HTTP failures have stable safe status classes and never read the upstream error body', async () => {
  for (const [status, code, retryable, actionRequired] of [
    [401, 'MODEL_AUTH_FAILED', false, true], [402, 'MODEL_BALANCE_REQUIRED', false, true],
    [403, 'MODEL_ACCESS_DENIED', false, true], [429, 'MODEL_RATE_LIMITED', true, false],
    [408, 'MODEL_SERVICE_UNAVAILABLE', true, false], [500, 'MODEL_SERVICE_UNAVAILABLE', true, false],
    [503, 'MODEL_SERVICE_UNAVAILABLE', true, false], [400, 'MODEL_HTTP', false, false],
  ]) {
    let calls = 0; let bodyReads = 0
    const provider = createModelProvider(environment, async () => {
      calls++
      return { ok: false, status, headers: new Headers({ 'retry-after': '90' }),
        async json() { bodyReads++; throw new Error('PRIVATE ERROR BODY') },
        async text() { bodyReads++; throw new Error('PRIVATE ERROR BODY') } }
    })
    await assert.rejects(provider.complete({ messages: [], tools: [] }), (error) => {
      assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.httpStatus, status)
      assert.equal(error.retryable, retryable); assert.equal(error.actionRequired, actionRequired)
      assert.equal(error.retryAfterMs, actionRequired ? undefined : 30000)
      assert(!error.message.includes(environment.WORLD_API_KEY)); assert(!error.message.includes('PRIVATE ERROR BODY'))
      return true
    })
    assert.equal(calls, 1, 'Transport does not hide retries from harness accounting')
    assert.equal(bodyReads, 0)
  }
})

test('provider cancellation and timeout work even when injected transport ignores its signal', async () => {
  const delayed = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] })
  }
  const controller = new AbortController()
  const provider = createModelProvider(environment, delayed)
  const pending = provider.complete({ messages: [], tools: [], signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  const short = createModelProvider({ ...environment, WORLD_MODEL_TIMEOUT_MS: '5' }, delayed)
  await assert.rejects(short.complete({ messages: [], tools: [] }), { code: 'MODEL_TIMEOUT' })
})

test('truncated generations and missing tool calls are rejected before execution', async () => {
  for (const choice of [
    { message, finish_reason: 'length' },
    { message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' },
  ]) {
    const provider = createModelProvider(environment, async () => Response.json({ choices: [choice] }))
    await assert.rejects(provider.complete({ messages: [], tools: [] }), (error) => ['MODEL_INCOMPLETE', 'MODEL_PROTOCOL'].includes(error.code))
  }
})

test('truncated output preserves only numeric usage and worker failure accounts for it once without publishing a report', async () => {
  let calls = 0; let checkpoint
  const provider = createModelProvider(environment, async () => {
    calls++
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'PRIVATE TRUNCATED TEXT', reasoning_content: 'PRIVATE REASONING' }, finish_reason: 'length' }],
      usage: { total_tokens: 1234, prompt_tokens: 100, completion_tokens: 1134, privateField: 'PRIVATE ACCOUNT DETAIL' } })
  })
  await assert.rejects(runWorker({ provider, tools: [],
    assignment: { topicId: 'topic_length', predictionId: 'prediction_length', runId: 'run_length', assignmentId: 'assignment_length', agentInstanceId: 'actor_length',
      objective: 'Protocol-only output accounting test.', inputEvidence: [], allowedTools: [], timePolicy: 'live' },
    agentSpec: { agentSpecId: 'verification', specVersion: 1, instructions: 'Submit only actual findings.', allowedTools: [] },
    onCheckpoint(value) { checkpoint = value },
  }), (error) => {
    assert.equal(error.code, 'MODEL_INCOMPLETE')
    assert.equal(error.retryable, false)
    assert.deepEqual(error.usage, { total_tokens: 1234, prompt_tokens: 100, completion_tokens: 1134 })
    assert(!JSON.stringify(error).includes('PRIVATE'))
    return true
  })
  assert.equal(calls, 1, 'Length truncation must not be blindly retried')
  assert.equal(checkpoint.usage.modelRequests, 1)
  assert.equal(checkpoint.usage.totalTokens, 1234)
  assert.equal(checkpoint.usage.unknownUsage, false)
  assert.equal(checkpoint.report, null)
})

test('full school completion URL is called once without path duplication or DeepSeek-only fields', async () => {
  const url = 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions'
  let seen
  const provider = createModelProvider({ ...environment, WORLD_CHAT_COMPLETIONS_URL: url, WORLD_MODEL_NAME: 'DeepSeek-V4-Flash' }, async (endpoint, options) => {
    seen = { endpoint, body: JSON.parse(options.body) }
    return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] })
  })
  await provider.complete({ messages: [], tools: [], maxTokens: 100 })
  assert.equal(seen.endpoint, url)
  assert.equal(seen.body.model, 'DeepSeek-V4-Flash')
  assert.equal(provider.settings.protocol, 'openai')
  assert.equal(seen.body.tool_choice, 'auto')
  assert(!Object.hasOwn(seen.body, 'thinking'))
  assert(!Object.hasOwn(seen.body, 'reasoning_effort'))
})

test('full official endpoint takes precedence and endpoint edits change the durable provider identity', async () => {
  let called
  const env = { ...environment, WORLD_CHAT_COMPLETIONS_URL: 'https://api.deepseek.com/chat/completions', WORLD_MODEL_NAME: 'deepseek-flash' }
  const transport = async (endpoint, options) => { called = { endpoint, body: JSON.parse(options.body) }; return Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] }) }
  const provider = createModelProvider(env, transport)
  await provider.complete({ messages: [], tools: [] })
  assert.equal(called.endpoint, env.WORLD_CHAT_COMPLETIONS_URL)
  assert.equal(called.body.model, 'deepseek-flash')
  assert.deepEqual(called.body.thinking, { type: 'disabled' })
  assert.notEqual(createModelProvider({ ...env, WORLD_CHAT_COMPLETIONS_URL: 'https://gateway.example/custom/completion' }, transport).configurationId, provider.configurationId)
  assert.equal(createModelProvider({ ...env, WORLD_BASE_URL: 'https://ignored.example' }, transport).configurationId, provider.configurationId)
  for (const url of ['file:///invalid', 'https://user:pass@host.example/chat/completions', 'https://host.example/chat/completions?key=secret']) assert.throws(() => createModelProvider({ ...env, WORLD_CHAT_COMPLETIONS_URL: url }, transport), { code: 'MODEL_CONFIG' })
})
