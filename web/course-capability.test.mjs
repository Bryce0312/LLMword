import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessCourseCapability, probeCourseCapability, guardCourseSubmission, isMissingCourseApi } from './course-capability.mjs'

const config = { stage: 'course-vertical', supervisor: true, forecastPublishing: true, nativeToolProtocol: true, modelMode: 'live', sourceMode: 'live' }
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

test('old service 404 becomes a current-service restart explanation and never submits', async () => {
  const calls = []; let writes = 0
  const check = () => probeCourseCapability({ fetcher: async (url, options) => { calls.push({ url, options }); return response(404, { error: { code: 'NOT_FOUND', message: '找不到此运行 API。' } }) } })
  const payload = Object.freeze({ question: '已输入的问题', horizonHours: 48 })
  await assert.rejects(guardCourseSubmission(check, () => { writes++; return payload }), (error) => {
    assert.equal(error.capability.kind, 'restart-required')
    assert.match(error.message, /重启.*当前服务/)
    assert.match(error.message, /输入内容会保留/)
    assert.doesNotMatch(error.message, /找不到此运行/)
    return true
  })
  assert.equal(writes, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/course/config')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(payload, { question: '已输入的问题', horizonHours: 48 })
})

test('normal live and protocol-demo services are both accepted without contacting a model', async () => {
  for (const modelMode of ['live', 'mock']) {
    const current = { ...config, modelMode, sourceMode: modelMode === 'mock' ? 'replay' : 'live' }
    const check = () => probeCourseCapability({ fetcher: async () => response(200, current) })
    let writes = 0
    const result = await guardCourseSubmission(check, async () => { writes++; return { requestId: 'created-once' } })
    assert.equal(writes, 1)
    assert.equal(result.requestId, 'created-once')
  }
})

test('a present endpoint with only M1 research capabilities cannot enable automatic tracking', () => {
  const result = assessCourseCapability({ ok: true, status: 200, body: { stage: 'M1', research: true, supervisor: false, forecastPublishing: false } })
  assert.equal(result.available, false)
  assert.equal(result.kind, 'restart-required')
  assert.equal(assessCourseCapability({ ok: true, status: 200, body: {} }).available, false)
  assert.equal(assessCourseCapability({ ok: true, status: 200, body: { capabilities: config } }).available, true)
})

test('disabled service, access denial, transient failure and invalid JSON stay distinct', async () => {
  assert.equal(assessCourseCapability({ ok: false, status: 503, body: { error: { code: 'COURSE_DISABLED' } } }).kind, 'restart-required')
  assert.equal(assessCourseCapability({ ok: false, status: 403, body: {} }).kind, 'access-denied')
  assert.equal(assessCourseCapability({ ok: false, status: 503, body: { error: { code: 'COURSE_ERROR' } } }).kind, 'temporarily-unavailable')
  const invalid = await probeCourseCapability({ fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new Error('HTML response') } }) })
  assert.equal(invalid.kind, 'restart-required')
})

test('network interruption and timeout fail closed without guessing another origin', async () => {
  const interrupted = await probeCourseCapability({ fetcher: async () => { throw new TypeError('network down') } })
  assert.equal(interrupted.available, false)
  assert.equal(interrupted.kind, 'temporarily-unavailable')
  const timeout = await probeCourseCapability({ timeoutMs: 5, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) })
  assert.equal(timeout.available, false)
})

test('rechecking after restart can unlock the same submission without rewriting user input', async () => {
  const payload = Object.freeze({ question: '保持的问题', mode: 'strict', strict: Object.freeze({ resolutionRule: '保持的规则' }) })
  let online = false; let written
  const check = () => probeCourseCapability({ fetcher: async () => online ? response(200, config) : response(404, {}) })
  await assert.rejects(guardCourseSubmission(check, () => { written = payload }))
  assert.equal(written, undefined)
  online = true
  await guardCourseSubmission(check, () => { written = payload })
  assert.equal(written, payload)
  assert.equal(written.strict.resolutionRule, '保持的规则')
})

test('submission after a valid check preserves ordinary validation failures for the form', async () => {
  const validation = Object.assign(new Error('规则需要补充'), { code: 'INVALID_STRICT_CONTRACT', status: 400 })
  await assert.rejects(guardCourseSubmission(async () => ({ available: true }), async () => { throw validation }), (error) => error === validation)
  assert.equal(isMissingCourseApi(validation), false)
  assert.equal(isMissingCourseApi({ status: 404, code: 'NOT_FOUND' }), true)
})
