import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService, createCourseMockProvider } from './course-service.mjs'
import { createCourseStore } from './course-store.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createModelProvider } from '../runtime/model-provider.mjs'

const NOW = '2026-11-19T10:00:00.000Z'
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-output-budget-'))
  const path = join(folder, 'course.sqlite')
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const services = []
  t.after(async () => { for (const service of services) await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { path, open(provider) {
    const service = createCourseService({ path, workbench, sourceTools, provider, modelMode: 'mock', now: () => NOW })
    services.push(service); return service
  } }
}

test('thinking defaults to 16384, explicit output caps reach 32768, and non-thinking remains at 4800', async (t) => {
  for (const [thinking, configured, requested, expected] of [
    ['enabled', false, 2048, 16384], ['enabled', true, 32768, 32768], ['enabled', true, 65536, 32768],
    ['disabled', true, 32768, 4800], ['disabled', true, 2048, 2048],
  ]) {
    const setup = await fixture(t)
    const protocol = createCourseMockProvider()
    const limits = []
    const provider = { ...protocol, settings: { thinking, outputCapConfigured: configured, maxOutputTokens: requested, timeoutMs: 180000 },
      async complete(input) { limits.push(input.maxTokens); return protocol.complete(input) } }
    const service = setup.open(provider)
    const request = service.createRequest({ question: '【模拟】课程科技展会开幕吗？', watch: false })
    await service.idle()
    const done = service.getRequest(request.requestId)
    assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
    assert(limits.length > 3 && limits.every((limit) => limit === expected))
    assert.equal(service.capabilities.limits.maxOutputTokens, expected)
    await service.close()
    const persisted = createCourseStore({ path: setup.path, now: () => NOW })
    try {
      const run = persisted.getRun(done.run.runId)
      assert.equal(run.budget.maxTokens, expected)
      assert.equal(run.budget.maxTotalTokens, 300000)
      assert(persisted.listAssignments(run.runId).every((assignment) => assignment.config.budget.maxTokens === expected))
    } finally { persisted.close() }
  }
})

test('course main failure records known truncated tokens and never exposes a partial protocol or fabricates a forecast', async (t) => {
  const setup = await fixture(t)
  let calls = 0
  const provider = createModelProvider({ WORLD_API_KEY: 'TEST_NOT_REAL', WORLD_MODEL_NAME: 'length-fixture', WORLD_BASE_URL: 'https://provider.example/v1' }, async () => {
    calls++
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'PRIVATE PARTIAL TEXT', reasoning_content: 'PRIVATE REASONING' }, finish_reason: 'length' }],
      usage: { total_tokens: 2345, prompt_tokens: 300, completion_tokens: 2045, secret: 'PRIVATE UPSTREAM DATA' } })
  })
  const service = setup.open(provider)
  const request = service.createRequest({ question: '【模拟】课程科技展会开幕吗？', watch: false })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'failed')
  assert.equal(done.run.error.code, 'MODEL_INCOMPLETE')
  assert.equal(done.run.usage.modelRequests, 1)
  assert.equal(done.run.usage.totalTokens, 2345)
  assert.equal(done.run.usage.unknownUsage, false)
  assert.equal(calls, 1)
  assert.equal(done.forecasts.length, 0)
  assert(!JSON.stringify(done).includes('PRIVATE'))
})
