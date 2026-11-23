import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'

const NOW = '2026-11-19T07:20:30.000Z'
async function setup(t, { enrichWorkerDates = false, fixturePages } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-course-recovery-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW, fixturePages })
  const services = []
  let reads = 0
  const sourceTools = { capabilities: gateway.capabilities, toolsFor(options) {
    return gateway.toolsFor({ ...options, onEvidence(record, context) {
      reads++
      return options.onEvidence(enrichWorkerDates && options.roleId !== 'main' ? { ...record, publishedAt: '2026-11-18T00:00:00.000Z' } : record, context)
    } })
  } }
  t.after(async () => { for (const service of services) await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { get reads() { return reads }, open(provider = createCourseMockProvider()) {
    const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools, provider,
      modelMode: 'mock', now: () => NOW, watchIntervalMs: 3_600_000, harnessVersion: 2 })
    services.push(service); return service
  } }
}
const firstContext = (messages) => { try { return JSON.parse(messages.find((message) => message.role === 'user')?.content || '{}') } catch { return {} } }

test('mid-worker shutdown and a new service reopen durable checkpoints without re-reading completed tool calls', { timeout: 10000 }, async (t) => {
  const fixture = await setup(t)
  const protocol = createCourseMockProvider()
  let pause
  const paused = new Promise((resolve) => { pause = resolve })
  let once = false
  const provider = { ...protocol, async complete(input) {
    const context = firstContext(input.messages)
    if (!once && context.agentSpecId === 'verification' && input.messages.some((message) => message.role === 'tool' && JSON.parse(message.content).data?.evidenceId)) {
      once = true; pause()
      await new Promise((resolve, reject) => {
        if (input.signal.aborted) reject(new Error('interrupted'))
        else input.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })
      })
    }
    return protocol.complete(input)
  } }
  const initial = fixture.open(provider)
  const request = initial.createRequest({ question: '【模拟】虚构科技展未来48小时会正式开幕吗？' })
  await paused
  const before = initial.getRequest(request.requestId)
  assert.equal(before.run.phase, 'workers')
  assert.equal(fixture.reads, 4)
  await initial.close()
  const resumed = fixture.open(protocol)
  resumed.resume(); await resumed.idle()
  const done = resumed.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(done.forecasts.length, 1)
  assert.equal(fixture.reads, 5, 'Only the new follow-up may fetch after restart')
  assert.equal(new Set(done.run.events.map((event) => event.eventId)).size, done.run.events.length)
  assert.equal(done.run.assignments.filter((item) => item.followUp).length, 1)
})

test('main protocol repairs a text-only reply and preserves every read-only batch tool-call result', async (t) => {
  const fixture = await setup(t)
  const protocol = createCourseMockProvider()
  let natural = false; let batched = false
  const provider = { ...protocol, async complete(input) {
    const context = firstContext(input.messages)
    if (context.kind === 'course-main') {
      for (const message of input.messages.filter((item) => item.role === 'assistant')) {
        for (const call of message.tool_calls || []) assert(input.messages.some((item) => item.role === 'tool' && item.tool_call_id === call.id), 'All assistant tool-call IDs must have matched results before another model request')
      }
      if (!natural) { natural = true; return { message: { role: 'assistant', content: '开始核查公开来源。' }, finishReason: 'stop', usage: { total_tokens: 10 } } }
    }
    const response = await protocol.complete(input)
    const call = response.message.tool_calls[0]
    if (context.kind === 'course-main' && !batched && call.function.name === 'search_web') {
      batched = true
      response.message.tool_calls.push({ ...structuredClone(call), id: `${call.id}_second` })
    }
    return response
  } }
  const service = fixture.open(provider)
  const request = service.createRequest({ question: '【模拟】虚构科技展48小时内会开幕吗？' })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert(natural && batched)
  assert.equal(done.forecasts.length, 1)
  assert(done.run.events.filter((event) => event.type === 'tool.completed' && event.payload.agentSpecId === 'main' && event.payload.toolId === 'search_web').length >= 2)
})

test('relative preset time cannot shift eight hours during timezone display conversion and partial strict remains automatic', async (t) => {
  const fixture = await setup(t)
  const protocol = createCourseMockProvider()
  let corrupted = false
  const provider = { ...protocol, async complete(input) {
    const response = await protocol.complete(input)
    const call = response.message.tool_calls[0]
    if (!corrupted && call.function.name === 'normalize_prediction') {
      corrupted = true
      const args = JSON.parse(call.function.arguments)
      args.targetAt = args.targetAt.replace('Z', '+08:00')
      args.forecastClosesAt = args.targetAt
      call.function.arguments = JSON.stringify(args)
    }
    return response
  } }
  const service = fixture.open(provider)
  assert.throws(() => service.createRequest({ question: '未来48小时会发生吗？', horizonHours: 0 }), { code: 'INVALID_PRESET' })
  const request = service.createRequest({ question: '【模拟】未来48小时虚构科技展会开幕吗（it may open）？', mode: 'strict', strict: { timezone: 'Asia/Shanghai' } })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(Date.parse(done.normalized.targetAt), Date.parse(NOW) + 48 * 3_600_000)
  assert.equal(done.normalized.timezone, 'Asia/Shanghai')
  assert(corrupted)
  assert.equal(done.forecasts.length, 1)
})

test('stop during a model response keeps the cancellation terminal across restart and never publishes', { timeout: 10000 }, async (t) => {
  const fixture = await setup(t)
  const protocol = createCourseMockProvider()
  let pause
  const paused = new Promise((resolve) => { pause = resolve })
  const provider = { ...protocol, async complete(input) {
    pause()
    await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return protocol.complete(input)
  } }
  const service = fixture.open(provider)
  const request = service.createRequest({ question: '【模拟】虚构科技展会开幕吗？' })
  await paused
  const stopped = service.stop(request.requestId)
  assert.equal(stopped.run.status, 'cancelled')
  await service.idle(); await service.close()
  const reopened = fixture.open(protocol)
  reopened.resume(); await reopened.idle()
  const done = reopened.getRequest(request.requestId)
  assert.equal(done.status, 'stopped')
  assert.equal(done.run.status, 'cancelled')
  assert.equal(done.forecasts.length, 0)
  assert.throws(() => reopened.check(request.requestId), { code: 'REQUEST_STOPPED' })
})

test('a current fact cannot settle an at-target future state even when the model proposes outcomeKnown', async (t) => {
  const fixture = await setup(t)
  const protocol = createCourseMockProvider()
  let injected = false
  const provider = { ...protocol, async complete(input) {
    const response = await protocol.complete(input)
    const call = response.message.tool_calls[0]
    if (!injected && call.function.name === 'propose_forecast') {
      injected = true
      const args = JSON.parse(call.function.arguments)
      args.outcomeKnown = true; args.outcome = 1
      args.summary = '错误模型提案：由于当前状态已知，将其当作两天后的已知结果。'
      call.function.arguments = JSON.stringify(args)
    }
    return response
  } }
  const service = fixture.open(provider)
  const request = service.createRequest({ question: '【模拟】负责人两天后是否仍担任虚构科技展的负责人？' })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(done.normalized.temporalPolicy, 'at_target')
  assert.equal(done.result, null)
  assert.equal(done.forecasts.length, 1)
  assert(injected)
  assert(done.forecast.probabilityYes > 0 && done.forecast.probabilityYes < 1)
})

test('later discovery of a source publication time creates a provenance version instead of blocking the worker fetch', async (t) => {
  const fixture = await setup(t, { enrichWorkerDates: true })
  const service = fixture.open()
  const request = service.createRequest({ question: '【模拟】未来48小时虚构科技展会开幕吗？' })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(done.run.assignments.find((item) => item.roleId === 'official').report.status, 'complete')
  const versions = done.evidence.filter((item) => item.url.endsWith('/official'))
  assert.equal(versions.length, 2)
  assert(versions.some((item) => item.publishedAt === null))
  assert(versions.some((item) => item.publishedAt === '2026-11-18T00:00:00.000Z'))
  assert.notEqual(versions[0].evidenceId, versions[1].evidenceId)
})

test('supervisor phase boundaries retain compact reports while excluding all earlier raw source bodies from later model requests', async (t) => {
  const sentinel = 'SOURCE_BODY_ONLY_DO_NOT_RESEND_TO_LATER_MAIN_PHASES'
  const fixture = await setup(t, { fixturePages: ['official', 'news', 'verification'].map((role) => ({
    url: `https://example.com/course-lab/${role}`, title: `【模拟】${role}资料`, text: `【课程虚构正文】${sentinel} 此处是本轮保存的材料原文，不是现实事件。`,
  })) })
  const protocol = createCourseMockProvider()
  const phases = new Set()
  const provider = { ...protocol, async complete(input) {
    const context = firstContext(input.messages)
    if (context.kind === 'course-main' && ['plan', 'review'].includes(context.phase)) {
      phases.add(context.phase)
      assert(!JSON.stringify(input.messages).includes(sentinel), 'Raw prepare bodies must not be re-injected into later main requests')
      assert(!JSON.stringify(input.messages).includes('phaseArchive'))
      if (context.phase === 'review') assert(context.reports.length >= 3)
      if (context.followUpDone) assert(context.reviewFocus.length > 0)
    }
    return protocol.complete(input)
  } }
  const service = fixture.open(provider)
  const request = service.createRequest({ question: '【模拟】未来48小时虚构科技展会开幕吗？' })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.deepEqual([...phases].sort(), ['plan', 'review'])
  assert(done.evidence.some((item) => item.text.includes(sentinel)), 'Original evidence remains persisted and inspectable')
  assert(!JSON.stringify(done).includes('phaseArchive'), 'Private phase protocols never enter public API state')
  assert.equal(done.forecasts.length, 1)
})

test('a newly checked run uses upgraded provider settings while preserving the old forecast, target and contract version', async (t) => {
  let revision = 1
  const fixture = await setup(t, { fixturePages: () => ['official', 'news', 'verification'].map((role) => ({
    url: `https://example.com/course-lab/${role}`, title: `【模拟】${role}`, text: `【模拟原文】普通增量版本${revision}，用于检查模型配置升级后继续研究。`,
  })) })
  const initial = fixture.open()
  const created = initial.createRequest({ question: '马斯克会不会发推特', watch: false })
  await initial.idle()
  const before = initial.getRequest(created.requestId)
  assert.equal(before.run.status, 'completed')
  const frozen = structuredClone(before.forecast)
  await initial.close()
  revision++
  const protocol = createCourseMockProvider()
  const upgraded = fixture.open({ ...protocol, model: 'course-upgraded-model', configurationId: 'course-upgraded-thinking-configuration',
    settings: { thinking: 'enabled', reasoningEffort: 'high', timeoutMs: 180000, maxOutputTokens: 8192, outputCapConfigured: true, protocol: 'test' } })
  upgraded.check(created.requestId); await upgraded.idle()
  const after = upgraded.getRequest(created.requestId)
  assert.equal(after.run.status, 'completed', JSON.stringify(after.run.error))
  assert.equal(after.run.modelRef, 'course-upgraded-model')
  assert.equal(after.run.memory.previousForecast.forecastId, frozen.forecastId)
  assert.deepEqual(after.forecasts[0], frozen)
  assert.equal(after.forecast.targetAt, frozen.targetAt)
  assert.equal(after.forecast.predictionVersion, frozen.predictionVersion)
  assert.equal(upgraded.capabilities.reasoningSettings.thinking, 'enabled')
})
