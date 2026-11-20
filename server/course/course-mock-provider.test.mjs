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
