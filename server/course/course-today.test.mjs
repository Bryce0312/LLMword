import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasTodayCalendarDeadline, resolveRequestDeadline, requestTime } from './course-context.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { RuntimeError } from '../runtime/model-provider.mjs'
import { createCourseStore } from './course-store.mjs'

const CREATED = '2026-11-18T17:36:32.745Z' // Hong Kong/Shanghai: November 19, 01:36.
const END = '2026-11-19T15:59:59.999Z'
const request = (question, timezone = 'Asia/Hong_Kong') => ({ question, timezone, createdAt: CREATED, horizonHours: 24, mode: 'preset' })

test('today/今日/今天 resolve from the created local date across UTC midnight in Hong Kong and Shanghai', () => {
  for (const timezone of ['Asia/Hong_Kong', 'Asia/Shanghai']) for (const question of ['香港红磡今天会下雨吗', '今日会下雨吗', 'Will it rain today?']) {
    const input = request(question, timezone)
    assert.equal(resolveRequestDeadline(input), END)
    const time = requestTime(input, '2026-11-19T16:10:00.000Z')
    assert.equal(time.targetAtUtc, END, 'A later retry must not move today to the retry date')
    assert.equal(time.forecastClosesAtUtc, END)
    assert.match(time.targetAtLocalLabel, /2026-11-19 23:59:59/)
  }
  assert.equal(resolveRequestDeadline({ ...request('今天会下雨吗'), createdAt: '2026-11-18T15:59:59.123Z' }), '2026-11-18T15:59:59.999Z')
  assert.equal(resolveRequestDeadline(request('红磡会下雨吗')), '2026-11-19T17:36:32.745Z', 'Unqualified relative-hour windows remain unchanged')
})

test('an explicit strict target wins and qualified clocks/dates stay outside the simple today resolver', () => {
  const targetAt = '2026-11-21T06:00:00.000Z'
  assert.equal(resolveRequestDeadline({ ...request('今天会下雨吗'), strict: { targetAt, timezone: 'Asia/Shanghai' } }), targetAt)
  for (const question of ['今天18:00会下雨吗', '今天下午三点会下雨吗', 'rain today at 6 pm?', '今天2026年11月19日会下雨吗']) assert.equal(hasTodayCalendarDeadline(question), false)
  const frozen = { ...request('今天会下雨吗'), normalized: { targetAt: '2026-11-20T01:36:32.745Z', forecastClosesAt: '2026-11-20T01:36:32.745Z', timezone: 'Asia/Hong_Kong' } }
  assert.equal(resolveRequestDeadline(frozen), frozen.normalized.targetAt, 'Previously compiled contracts are not silently migrated')
})

test('IANA day-end conversion respects a 23-hour spring day and a 25-hour autumn day', () => {
  assert.equal(resolveRequestDeadline({ ...request('today rain?', 'America/New_York'), createdAt: '2026-03-08T05:30:00.000Z' }), '2026-03-09T03:59:59.999Z')
  assert.equal(resolveRequestDeadline({ ...request('today rain?', 'America/New_York'), createdAt: '2026-11-01T04:30:00.000Z' }), '2026-11-02T04:59:59.999Z')
})

async function fixture(t, provider, { pages } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-today-'))
  let at = CREATED
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => at })
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => at, fixturePages: pages })
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools: gateway, provider, modelMode: 'mock', now: () => at })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { service, advance(value) { at = value } }
}

test('main target, normalization, worker time context and new rain rules use today while final limitations replace preparation gaps', async (t) => {
  const protocol = createCourseMockProvider()
  const contexts = []
  let corrupted = false
  const provider = { ...protocol, async complete(input) {
    contexts.push(structuredClone(input.messages))
    const response = await protocol.complete(input)
    const call = response.message.tool_calls[0]
    const args = JSON.parse(call.function.arguments)
    if (call.function.name === 'normalize_prediction') {
      args.resolutionRule = '错误示例：实况或预报出现降水都判YES。'
      args.sourceLimitations = ['准备时尚未取得辅助来源。']
      if (!corrupted) { corrupted = true; args.targetAt = '2026-11-19T17:36:32.745Z'; args.forecastClosesAt = args.targetAt }
      call.function.arguments = JSON.stringify(args)
    }
    if (call.function.name === 'propose_forecast') { args.sourceLimitations = []; call.function.arguments = JSON.stringify(args) }
    return response
  } }
  const { service } = await fixture(t, provider)
  const created = service.createRequest({ question: '【协议模拟】香港红磡会下雨吗今天', timezone: 'Asia/Hong_Kong', horizonHours: 24 })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(done.normalized.targetAt, END)
  assert.equal(done.normalized.forecastClosesAt, END)
  assert.match(done.normalized.question, /2026-11-19 23:59:59/)
  assert.match(done.normalized.resolutionRule, /实况观测/)
  assert.match(done.normalized.resolutionRule, /不能单独作为YES/)
  assert(!done.normalized.resolutionRule.includes('实况或预报出现降水都判YES'))
  assert.deepEqual(done.normalized.sourceLimitations, ['准备时尚未取得辅助来源。'], 'Preparation record remains immutable')
  assert.deepEqual(done.forecast.sourceLimitations, [], 'Final candidate may explicitly clear resolved limitations')
  const mainInputs = contexts.map((messages) => JSON.parse(messages.find((item) => item.role === 'user').content)).filter((context) => context.kind === 'course-main')
  assert(mainInputs.every((context) => context.targetAt === END && context.timeContext.targetAtUtc === END))
  assert(contexts.some((messages) => messages.some((message) => message.role === 'user' && message.content.includes('agentSpecId') && message.content.includes(END))))
})

test('retrying an unprepared today task the next local day ends without spending a new model request', async (t) => {
  const protocol = createCourseMockProvider()
  let blocked = true; let calls = 0
  const provider = { ...protocol, async complete(input) {
    calls++
    if (blocked) throw new RuntimeError('MODEL_BALANCE_REQUIRED', 'fixture', { status: 402, actionRequired: true })
    return protocol.complete(input)
  } }
  const { service, advance } = await fixture(t, provider)
  const created = service.createRequest({ question: '香港红磡会下雨吗今天', timezone: 'Asia/Hong_Kong' })
  await service.idle()
  const old = structuredClone(service.getRequest(created.requestId).run)
  assert.equal(old.status, 'failed')
  blocked = false; advance('2026-11-19T16:00:00.000Z')
  service.check(created.requestId); await service.idle()
  const expired = service.getRequest(created.requestId)
  assert.equal(expired.run.status, 'insufficient')
  assert.equal(expired.run.usage.modelRequests, 0)
  assert.equal(calls, 1)
  assert.equal(expired.watch.status, 'completed')
  assert.equal(expired.watch.nextDueAt, null)
  assert.equal(expired.forecasts.length, 0)
  assert.deepEqual(expired.runs.find((run) => run.runId === old.runId), old)
})

test('forecast-only webpages cannot register either weather outcome; model can repair to a probability with no recorded result', async (t) => {
  const protocol = createCourseMockProvider()
  let knownAttempts = 0
  const rejections = []
  const provider = { ...protocol, async complete(input) {
    for (const message of input.messages.filter((item) => item.role === 'tool')) {
      const result = JSON.parse(message.content)
      if (result.error?.code === 'WEATHER_OBSERVATION_REQUIRED') rejections.push(result.error)
    }
    const response = await protocol.complete(input)
    const call = response.message.tool_calls[0]
    if (call.function.name === 'propose_forecast' && knownAttempts < 2) {
      const args = JSON.parse(call.function.arguments)
      args.outcomeKnown = true; args.outcome = knownAttempts++
      args.summary = '错误协议提案：试图仅根据含雨字的预报页面提前登记结果。'
      call.function.arguments = JSON.stringify(args)
    }
    return response
  } }
  const pages = ['official', 'news', 'verification'].map((role) => ({ url: `https://example.com/course-lab/${role}`, title: `【模拟预报】${role}`,
    text: '【协议模拟】页面只有未来降雨预报和概率，没有实况观测；即使有“雨”字也不是已发生结果。' }))
  const { service } = await fixture(t, provider, { pages })
  const created = service.createRequest({ question: '【协议模拟】香港红磡会下雨吗今天', timezone: 'Asia/Hong_Kong', watch: false })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(knownAttempts, 2)
  assert(rejections.length >= 2)
  assert(rejections.every((error) => error.message.includes('outcomeKnown')))
  assert.equal(done.result, null)
  assert.equal(done.forecasts.length, 1)
  assert(Number.isFinite(done.forecast.probabilityYes))
  assert(!done.run.events.some((event) => event.type === 'run.finished' && event.payload.summary?.includes('已登记事实')))
})

test('storage also rejects direct preset-weather result registration without modifying its known-result ledger', () => {
  const store = createCourseStore({ path: ':memory:', now: () => CREATED })
  try {
    const created = store.createRequest({ ...request('香港红磡今天会下雨吗'), modelMode: 'mock', sourceMode: 'replay', providerIdentity: 'fixture' })
    for (const outcome of [0, 1]) assert.throws(() => store.recordResult(created.requestId, { outcome, evidenceIds: ['arbitrary-rain-page'] }), { code: 'WEATHER_OBSERVATION_REQUIRED' })
    assert.equal(store.getResult(created.requestId), null)
  } finally { store.close() }
})
