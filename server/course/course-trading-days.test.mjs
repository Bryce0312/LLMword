import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identifyTradingMarket, buildTradingHorizon, TRADING_DAY_CAPABILITIES } from './trading-calendar.mjs'
import { createCourseStore } from './course-store.mjs'
import { createCourseService } from './course-service.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { resolveRequestDeadline, requestTime } from './course-context.mjs'
import { handleCourseApi } from '../course-http.mjs'

const NOW = '2026-11-22T08:00:00.000Z'
const horizon = (question, tradingDays = 1, createdAt = NOW, market) => buildTradingHorizon({ question, tradingDays, createdAt, market })
async function fixture(t, provider = createCourseMockProvider()) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-trading-days-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools, provider, now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return service
}

test('market identity uses explicit codes, defaults ambiguous names to HK, and does not treat fund share suffixes as US tickers', () => {
  for (const question of ['阿里巴巴', '腾讯控股', '华夏成长混合A', '易方达基金C类', '华夏基金 A', '腾讯 EPS', '恒生ETF']) assert.equal(identifyTradingMarket(question).market, 'HK', question)
  for (const question of ['600519', '贵州茅台600519', '贵州茅台 600519', '510300', '588000', '159915', '000001.SZ', '600519.SH', '510300.SS', '159915.SZ', 'SH600519', '沪深300ETF']) assert.equal(identifyTradingMarket(question).market, 'CN', question)
  for (const question of ['00700.HK', '腾讯 港股', 'HK:9988', '9988']) assert.equal(identifyTradingMarket(question).market, 'HK', question)
  for (const question of ['NVDA', 'aapl', '腾讯 TCEHY', 'NVDA（美股）', 'NASDAQ: AAPL', 'BABA.US']) assert.equal(identifyTradingMarket(question).market, 'US', question)
  assert.equal(identifyTradingMarket('阿里巴巴', 'US').market, 'US')
  assert(identifyTradingMarket('阿里巴巴').assumptions.some(text => text.includes('默认港股')))
  for (const [question, market] of [['NVDA 港股腾讯', undefined], ['NYSE BABA 9988.HK', undefined], ['00700.HK', 'US'], ['贵州茅台600519', 'HK']]) assert.throws(() => identifyTradingMarket(question, market), { code: 'TRADING_MARKET_CONFLICT' })
  assert.throws(() => identifyTradingMarket('腾讯', 'LSE'), { code: 'INVALID_TRADING_MARKET' })
})

test('HK counts real sessions after the creation date including holidays and half-day closing auctions', () => {
  const one = horizon('00700.HK')
  assert.equal(one.targetAt, '2026-11-23T08:10:00.000Z')
  assert.equal(one.sessions.length, 1)
  const half = horizon('00700.HK', 1, '2026-02-13T03:00:00.000Z')
  assert.equal(half.targetSessionDate, '2026-02-16')
  assert.equal(half.targetAt, '2026-02-16T04:10:00.000Z')
  assert.equal(half.sessions[0].earlyClose, true)
  const holidays = horizon('00700.HK', 3, '2026-02-13T03:00:00.000Z')
  assert.deepEqual(holidays.sessions.map(session => session.date), ['2026-02-16', '2026-02-20', '2026-02-23'])
  const twenty = horizon('00700.HK', 20)
  assert.equal(twenty.targetAt, '2026-12-18T08:10:00.000Z')
  assert.equal(twenty.sessions.length, 20)
  assert(Date.parse(twenty.targetAt) - Date.parse(NOW) > 168 * 3600000)
  assert(twenty.calendarSources.every(url => url.startsWith('https://')))
  assert(twenty.assumptions.some(text => text.includes('基金净值')))
  assert.equal(horizon('00700.HK', 1, '2026-11-23T03:00:00.000Z').targetSessionDate, '2026-11-24', 'creation day is excluded even before its close')
})

test('CN excludes official holiday sessions and government make-up weekends instead of counting natural days', () => {
  const value = horizon('贵州茅台600519', 1, '2026-02-13T03:00:00.000Z')
  assert.equal(value.market, 'CN')
  assert.equal(value.targetAt, '2026-02-24T07:00:00.000Z')
  const nationalDay = horizon('510300', 1, '2026-09-30T03:00:00.000Z')
  assert.equal(nationalDay.targetSessionDate, '2026-10-08')
})

test('US uses NYSE half days and exchange-local DST instead of Shanghai or fixed UTC hours', () => {
  assert.equal(horizon('AAPL', 1, '2026-11-25T15:00:00.000Z').targetAt, '2026-11-27T18:00:00.000Z')
  assert.equal(horizon('AAPL', 1, '2026-03-06T15:00:00.000Z').targetAt, '2026-03-09T20:00:00.000Z')
  assert.equal(horizon('AAPL', 1, '2026-10-30T14:00:00.000Z').targetAt, '2026-11-02T21:00:00.000Z')
  assert.equal(horizon('AAPL', 5).targetAt, '2026-11-30T21:00:00.000Z')
  const localAnchor = horizon('AAPL', 1, '2026-11-24T01:00:00.000Z')
  assert.equal(localAnchor.anchorSessionDate, '2026-11-23')
  assert.equal(localAnchor.targetSessionDate, '2026-11-24')
  assert(localAnchor.marketLabel.includes('NYSE'))
})

test('published coverage is bounded, cross-year calendars are used explicitly and invalid options never approximate', () => {
  assert.throws(() => horizon('600519', 1, '2026-12-31T01:00:00.000Z'), { code: 'TRADING_CALENDAR_COVERAGE' })
  assert.throws(() => horizon('00700.HK', 20, '2027-12-20T01:00:00.000Z'), { code: 'TRADING_CALENDAR_COVERAGE' })
  const hk = horizon('00700.HK', 3, '2026-12-30T01:00:00.000Z')
  assert.deepEqual(hk.sessions.map(session => session.date), ['2026-12-31', '2027-01-04', '2027-01-05'])
  assert(hk.calendarSources.some(url => url.includes('2025')))
  assert(hk.calendarSources.some(url => url.includes('2026')))
  for (const value of [0, 2, 7, 21, '5', null]) assert.throws(() => horizon('腾讯', value), { code: 'INVALID_TRADING_HORIZON' })
})

test('store captures its actual creation clock once, idempotent replay and reopening retain the original horizon', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-trading-store-')), path = join(folder, 'course.sqlite')
  let at = NOW, store = createCourseStore({ path, now: () => at })
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }) })
  const input = { question: 'AAPL', purpose: 'forecast', horizonTradingDays: 5, timezone: 'America/New_York', budget: { maxTotalTokens: 1000000 } }
  const created = store.createRequest(input, { idempotencyKey: 'five-us-sessions' })
  const original = structuredClone(created.tradingHorizon)
  assert.equal(original.anchorAt, created.createdAt)
  assert.equal(original.targetAt, '2026-11-30T21:00:00.000Z')
  at = '2026-11-25T15:00:00.000Z'
  assert.deepEqual(store.createRequest(input, { idempotencyKey: 'five-us-sessions' }).tradingHorizon, original)
  assert.equal(store.listRequests().length, 1)
  at = '2026-12-31T01:00:00.000Z'
  assert.throws(() => store.createRequest({ ...input, question: '600519' }), { code: 'TRADING_CALENDAR_COVERAGE' })
  assert.equal(store.listRequests().length, 1, 'missing coverage rolls back the entire request')
  store.close(); store = createCourseStore({ path, now: () => at })
  const reopened = store.getRequest(created.requestId)
  assert.deepEqual(reopened.tradingHorizon, original)
  assert.equal(resolveRequestDeadline(reopened), original.targetAt)
  assert.equal(requestTime(reopened, at).tradingHorizon.market, 'US')
  assert.equal(resolveRequestDeadline({ ...reopened, normalized: { targetAt: '2026-12-03T00:00:00.000Z' } }), '2026-12-03T00:00:00.000Z')
  assert.equal(resolveRequestDeadline({ ...reopened, strict: { targetAt: '2026-12-04T00:00:00.000Z' } }), '2026-12-04T00:00:00.000Z')
  assert.equal(resolveRequestDeadline({ question: '旧小时任务', createdAt: NOW, horizonHours: 48 }), '2026-11-24T08:00:00.000Z')
})

test('new request validation isolates trading horizons from research/hours, keeps raw symbols and bypasses 168-hour limits', async t => {
  const service = await fixture(t)
  assert.deepEqual(service.capabilities.tradingDayHorizons, TRADING_DAY_CAPABILITIES)
  for (const input of [{question:'腾讯',horizonTradingDays:2}, {question:'腾讯',horizonTradingDays:5,horizonHours:48}, {question:'腾讯',horizonTradingDays:5,purpose:'research'},
    {question:'腾讯',horizonTradingDays:5,market:'LSE'}, {question:'腾讯',market:'HK'}, {question:'腾讯',horizonTradingDays:5,tradingHorizon:{targetAt:'2099-01-01'}}]) assert.throws(() => service.createRequest(input), error => error.status === 400)
  const request = service.createRequest({question:'00700.HK',horizonTradingDays:20,watch:false})
  service.stop(request.requestId)
  assert.equal(request.question, '00700.HK')
  assert.equal(request.horizonHours, undefined)
  assert.equal(request.horizonTradingDays, 20)
  assert.equal(request.tradingHorizon.targetAt, '2026-12-18T08:10:00.000Z')
  const strict = service.createRequest({question:'600519',horizonTradingDays:20,watch:false,mode:'strict',strict:{targetAt:'2027-01-10T10:00:00.000Z'}})
  service.stop(strict.requestId)
  assert.equal(strict.tradingHorizon, undefined, 'explicit strict target takes priority even beyond the bundled computed horizon')
  assert.equal(resolveRequestDeadline(strict), '2027-01-10T10:00:00.000Z')
  const old = service.createRequest({question:'旧小时输入',horizonHours:168,watch:false})
  service.stop(old.requestId)
  assert.equal(old.horizonHours, 168)
  assert.equal(old.tradingHorizon, undefined)
})

test('normalization repairs model changes to a sealed trading deadline and bare symbols remain unscored without a real baseline', async t => {
  const protocol = createCourseMockProvider(), observedErrors = [], workerContexts = []
  let corrupted = false
  const provider = { ...protocol, async complete(input) {
    for (const message of input.messages.filter(item => item.role === 'tool')) { try { const value = JSON.parse(message.content); if (value.error?.code) observedErrors.push(value.error.code) } catch {} }
    let worker; try { worker = JSON.parse(input.messages.find(item => item.role === 'user')?.content || '{}') } catch {}
    if (worker?.assignmentId) workerContexts.push(worker)
    const response = await protocol.complete(input)
    const call = response.message.tool_calls?.[0]
    if (!corrupted && call?.function.name === 'normalize_prediction') {
      const args = JSON.parse(call.function.arguments)
      args.targetAt = new Date(Date.parse(args.targetAt) + 86400000).toISOString(); args.forecastClosesAt = args.targetAt
      call.function.arguments = JSON.stringify(args); corrupted = true
    }
    return response
  } }
  const service = await fixture(t, provider)
  const created = service.createRequest({question:'AAPL',horizonTradingDays:5,watch:false})
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status,'completed',JSON.stringify(done.run.error))
  assert(observedErrors.includes('TRADING_TARGET_MISMATCH'))
  assert.equal(done.normalized.targetAt, created.tradingHorizon.targetAt)
  assert.equal(done.normalized.forecastClosesAt, created.tradingHorizon.targetAt)
  assert.equal(done.normalized.temporalPolicy,'at_target')
  assert.equal(done.normalized.conditionalOnly,true)
  assert.equal(done.forecast.scoringEligible,false)
  assert(done.normalized.defaultAssumptions.some(text=>text.includes('收盘')&&text.includes('基准')))
  assert.equal(done.normalized.timeContext.tradingHorizon.market,'US')
  const partial = service.createRequest({question:'AAPL',horizonTradingDays:5,watch:false,mode:'strict',strict:{timezone:'Asia/Shanghai'}})
  await service.idle()
  const strictDone = service.getRequest(partial.requestId)
  assert.equal(strictDone.run.status,'completed',JSON.stringify(strictDone.run.error))
  assert.equal(strictDone.normalized.timezone,'Asia/Shanghai')
  assert.equal(strictDone.normalized.targetAt, partial.tradingHorizon.targetAt)
})

test('HTTP exposes the horizon capability and returns a durable 20-session snapshot without accepting a client deadline', async t => {
  const service = await fixture(t)
  const server = createServer((req,res)=>{ void handleCourseApi(service,req,res) })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))})
  const base = `http://127.0.0.1:${server.address().port}/api/v1/course`
  assert.deepEqual((await (await fetch(`${base}/config`)).json()).tradingDayHorizons,{options:[1,3,5,20],default:5,defaultMarket:'HK'})
  const response=await fetch(`${base}/requests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:'腾讯控股',horizonTradingDays:20,watch:false})})
  assert.equal(response.status,202)
  const request=await response.json(); service.stop(request.requestId)
  assert.equal(request.tradingHorizon.market,'HK')
  assert.equal(request.tradingHorizon.targetSessionDate,'2026-12-18')
  assert(request.tradingHorizon.assumptions.some(text=>text.includes('默认港股')))
  const invalid=await fetch(`${base}/requests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:'腾讯控股',horizonTradingDays:5,tradingHorizon:{targetAt:'2099-01-01'}})})
  assert.equal(invalid.status,400)
})
