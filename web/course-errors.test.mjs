import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseErrorPresentation, courseRequestFailure, courseRequestAction, courseRequestCanStop } from './course-errors.mjs'

const failed = { runId: 'run', requestId: 'q', status: 'failed', phase: 'finished', summary: '模型服务请求未成功。', error: { code: 'MODEL_BALANCE_REQUIRED', message: '模型账户余额不足。', actionRequired: true, retryable: false } }
const request = { requestId: 'q', status: 'failed', predictionId: null, activeRunId: null, runs: [failed], latestRun: failed, watch: { status: 'paused_provider', pauseReason: failed.error, nextDueAt: null } }

test('safe billing, authentication and access codes identify the cause without any vendor raw text', () => {
  for (const [code, title] of [['MODEL_BALANCE_REQUIRED', '本轮模型账户额度不足'], ['SOURCE_BALANCE_REQUIRED', '本轮资料服务额度不足'], ['MODEL_AUTH_FAILED', '模型服务鉴权失败'], ['SOURCE_AUTH_FAILED', '资料服务鉴权失败'], ['MODEL_ACCESS_DENIED', '模型服务拒绝访问'], ['SOURCE_ACCESS_DENIED', '资料服务拒绝访问']]) {
    const view = courseErrorPresentation({ code, message: 'unsafe vendor body must not appear', rawBody: 'secret', retryable: false })
    assert.equal(view.title, title)
    assert.equal(view.requiresAction, true)
    assert.equal(view.automaticRetry, false)
    assert.equal(JSON.stringify(view).includes('unsafe'), false)
    assert.equal(JSON.stringify(view).includes('secret'), false)
  }
})
test('rate limiting, timeout and network failures stay distinct and remain manual recovery', () => {
  const rate = courseErrorPresentation({ code: 'MODEL_RATE_LIMITED', retryAfterMs: 1500 })
  assert.equal(rate.title, '模型请求受到限流')
  assert.match(rate.waitHint, /2 秒/)
  for (const code of ['MODEL_RATE_LIMITED', 'MODEL_SERVICE_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_NETWORK']) assert.equal(courseErrorPresentation({ code }).automaticRetry, false)
  assert.equal(courseErrorPresentation({ code: 'MODEL_HTTP', message: '模型服务请求未成功。' }).requiresAction, false)
})
test('failed prepare can be retried without a prediction, changing neither the question nor stored failure', () => {
  const action = courseRequestAction(request)
  assert.equal(action.enabled, true)
  assert.equal(action.label, '重试本次调查')
  assert.equal(action.automaticRetry, false)
  assert.equal(request.predictionId, null)
  assert.equal(request.latestRun.status, 'failed')
  assert.equal(courseRequestFailure(request).title, '本轮模型账户额度不足')
})
test('a new active recovery run suppresses old billing messages and prevents duplicate POSTs', () => {
  const active = { ...failed, runId: 'new', status: 'running', phase: 'prepare', summary: '', error: null }
  const data = { ...request, activeRunId: 'new', status: 'queued', runs: [failed, active], latestRun: active }
  assert.equal(courseRequestFailure(data), null)
  assert.equal(courseRequestAction(data).enabled, false)
})
test('successful recovery ignores stale request errors and the historical pause reason', () => {
  const completed = { ...failed, runId: 'new', status: 'completed', summary: '已发布新判断', error: null }
  const data = { ...request, predictionId: 'p', status: 'failed', error: failed.error, runs: [failed, completed], latestRun: completed, watch: { status: 'active', pauseReason: failed.error } }
  assert.equal(courseRequestFailure(data), null)
  assert.equal(courseRequestAction(data).kind, 'check')
})
test('stopped, resolved and expired tasks cannot be restarted; paused-provider recovery stays manual', () => {
  assert.equal(courseRequestAction({ ...request, status: 'stopped' }).enabled, false)
  assert.equal(courseRequestAction({ ...request, result: { outcome: 1 } }).enabled, false)
  assert.equal(courseRequestAction({ ...request, normalized: { forecastClosesAt: '2026-11-18T00:00:00Z' } }, { now: Date.parse('2026-11-19T00:00:00Z') }).enabled, false)
  assert.equal(courseRequestAction({ ...request, predictionId: 'p' }).kind, 'retry')
})
test('ordinary ready tasks retain the existing check action and unfinished drafts do not create calls', () => {
  assert.equal(courseRequestAction({ requestId: 'q', predictionId: 'p', runs: [] }).label, '检查一次新资料')
  assert.equal(courseRequestAction({ requestId: 'q', runs: [] }).enabled, false)
})
test('failed requests with an active or paused watcher remain stoppable without changing retry eligibility', () => {
  for (const watchStatus of ['active', 'paused_provider']) {
    const data = { ...request, watch: { status: watchStatus } }
    assert.equal(courseRequestCanStop(data), true)
    assert.equal(courseRequestAction(data).enabled, true)
    assert.equal(courseRequestAction(data).kind, 'retry')
  }
  assert.equal(courseRequestCanStop(request, { busy: true }), false)
  assert.equal(courseRequestCanStop({ ...request, status: 'stopped' }), false)
  assert.equal(courseRequestCanStop({ ...request, status: 'closed' }), false)
  assert.equal(courseRequestCanStop({}), false)
})


test('removed failed, paused-watch and published records are read-only for both actions', () => {
  const completed = { ...failed, status: 'completed', error: null }
  const scenarios = [
    { ...request, watch: { status: 'active' } },
    { ...request, predictionId: 'p', status: 'watching', runs: [completed], latestRun: completed, watch: { status: 'paused_provider', pauseReason: failed.error } },
    { requestId: 'q', predictionId: 'p', status: 'watching', runs: [completed], latestRun: completed, forecast: { probabilityYes: 0.7 }, watch: { status: 'active' } },
  ]
  for (const record of scenarios) {
    assert.equal(courseRequestAction(record).enabled, true, 'the fixture permits a manual action before removal')
    assert.equal(courseRequestCanStop(record), true)
    for (const marker of [{ deleted: true }, { deletedAt: '2026-11-23T10:00:00Z' }]) {
      const removed = { ...record, ...marker }
      const before = structuredClone(removed)
      const action = courseRequestAction(removed)
      assert.equal(action.enabled, false)
      assert.equal(action.reason, '这项预测记录已从历史列表移除，仅供查看。')
      assert.equal(action.automaticRetry, false)
      assert.equal(courseRequestCanStop(removed), false)
      assert.deepEqual(removed, before, 'read-only action checks do not alter saved history')
    }
  }
})
