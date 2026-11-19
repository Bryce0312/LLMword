import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './worker-loop.mjs'

const base = {
  topicId: 'topic-protocol', predictionId: 'prediction-protocol', runId: 'run-protocol', assignmentId: 'assignment-protocol',
  agentInstanceId: 'worker-protocol', objective: '验证执行状态与预算协议，不预测事件。', inputEvidence: [], allowedTools: ['read_document'], timePolicy: 'live',
  budget: { maxModelRequests: 2, maxToolCalls: 4, maxTotalTokens: 1000, maxTokens: 300, maxRetries: 0 },
}
const spec = { agentSpecId: 'verification', specVersion: 1, allowedTools: ['read_document'], instructions: '核对工具返回，证据不足就明确缺口。' }
const action = (index, name, args) => ({ message: { role: 'assistant', reasoning_content: 'PRIVATE_PROTOCOL_ONLY', tool_calls: [
  { id: 'action_' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] }, finishReason: 'tool_calls', usage: { total_tokens: 20 } })
const report = { status: 'complete', summary: '协议执行检查完成。', evidenceIds: ['ev-protocol'], support: [], counterevidence: [], missingEvidence: [], probability: null, nextSuggestion: '不生成预测。' }
function documentTool(counter) {
  return { toolId: 'read_document', version: 1, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute() { counter.calls++; return { status: 'ok', data: { test: true }, evidenceIds: ['ev-protocol'], summary: '本地协议处理器已返回。', observedAt: new Date().toISOString(), error: null } } }
}

test('worker emits real request states and refreshes system budget while reserving its final model call for a report', async () => {
  const counter = { calls: 0 }, events = [], requests = []
  const provider = { async complete(input) {
    requests.push(input)
    assert.equal(input.messages[0].role, 'system')
    assert(input.messages[0].content.includes('300中文字'))
    if (requests.length === 1) {
      assert(input.messages[0].content.includes('第1/2'))
      assert(input.tools.some(t => t.function.name === 'read_document'))
      return action(1, 'read_document', {})
    }
    assert(input.messages[0].content.includes('第2/2'))
    assert(input.messages[0].content.includes('剩余980'))
    assert.deepEqual(input.tools.map(t => t.function.name), ['submit_report'])
    assert(input.messages.find(m => m.role === 'assistant').reasoning_content === 'PRIVATE_PROTOCOL_ONLY')
    return action(2, 'submit_report', report)
  } }
  const result = await runWorker({ provider, assignment: base, agentSpec: spec, tools: [documentTool(counter)], finishOnToolBudget: true, onEvent: e => events.push(e) })
  assert.equal(counter.calls, 1)
  assert.equal(result.usage.modelRequests, 2)
  assert.deepEqual(events.filter(e => e.type === 'model.requested').map(e => e.payload.modelRequestIndex), [1, 2])
  assert.equal(events.filter(e => e.type === 'model.completed').length, 2)
  assert.equal(events.filter(e => e.type === 'model.requested')[1].payload.reportOnly, true)
  assert(!JSON.stringify(events).includes('PRIVATE_PROTOCOL_ONLY'))
  assert.equal(new Set(events.filter(e => e.type === 'model.requested').map(e => e.payload.modelRequestId)).size, 2)
})

test('a model cannot execute extra research in its reserved report step even if it ignores the advertised tool set', async () => {
  const counter = { calls: 0 }, checkpoints = []
  let requests = 0
  const provider = { async complete() { return action(++requests, 'read_document', {}) } }
  await assert.rejects(runWorker({ provider, assignment: base, agentSpec: spec, tools: [documentTool(counter)], finishOnToolBudget: true,
    onCheckpoint: state => checkpoints.push(state) }), e => e.code === 'BUDGET_EXHAUSTED')
  assert.equal(counter.calls, 1)
  assert.equal(requests, 2)
  assert.equal(checkpoints.at(-1).toolExecutions.at(-1).result.error.code, 'REPORT_STEP_REQUIRED')
  assert.equal(checkpoints.at(-1).usage.toolCalls, 1)
})
