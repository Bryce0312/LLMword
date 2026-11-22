import test from 'node:test'
import assert from 'node:assert/strict'
import { createCourseMockProvider } from './course-mock-provider.mjs'

test('mock usage carries the same split token fields as a real provider', async () => {
  const result = await createCourseMockProvider().complete({
    messages: [{ role: 'user', content: JSON.stringify({ question: '测试问题' }) }],
    tools: [{ function: { name: 'draft_and_delegate' } }],
  })
  assert.equal(result.usage.total_tokens, result.usage.prompt_tokens + result.usage.completion_tokens)
  assert.equal(result.usage.prompt_tokens, result.usage.prompt_cache_hit_tokens + result.usage.prompt_cache_miss_tokens)
  for (const key of ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
    assert.ok(Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0, key)
  }
})

test('only an explicit bounded worker marker supplies disclosed synthetic role-score examples', async () => {
  const protocol = createCourseMockProvider()
  for (const [agentSpecId, task, expected] of [
    ['official', { forecastPolicy: 'bounded-forecast-v1' }, .5],
    ['timeline', { forecastPolicy: 'bounded-forecast-v1' }, .55],
    ['verification', { forecastPolicy: 'bounded-forecast-v1' }, .6],
    ['market', { forecastPolicy: 'bounded-forecast-v1' }, .55],
    ['official', {}, null], ['official', { purpose: 'research' }, null],
    ['official', { strict: { targetAt: '2026-11-24T08:00:00.000Z' } }, null],
    ['official', { forecastPolicy: 'unknown-policy' }, null],
  ]) {
    const url = 'https://example.com/course-lab/official'
    const messages = [
      { role: 'user', content: JSON.stringify({ agentSpecId, objective: JSON.stringify(task) }) },
      { role: 'assistant', tool_calls: [{ id: 'search', function: { name: 'search_web' } }] },
      { role: 'tool', tool_call_id: 'search', content: JSON.stringify({ data: { results: [{ url }] } }) },
      { role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'fetch_page' } }] },
      { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ status: 'ok', evidenceIds: ['fixture_evidence'], data: { url, title: '静态协议资料', text: '这是只用于软件协议验证的虚构原文，不代表真实新闻。' } }) },
    ]
    const response = await protocol.complete({ messages, tools: [{ function: { name: 'submit_report' } }] })
    const call = response.message.tool_calls[0]
    assert.equal(call.function.name, 'submit_report')
    const report = JSON.parse(call.function.arguments)
    assert.equal(report.probability, expected)
    if (expected !== null) assert.match(report.summary, /固定示例概率仅验证协议，不是现实预测或准确率/u)
  }
})
