import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseRequestProgress, courseReasoningLabel } from './course-status.mjs'

const staleMessage = '无法把原题规范成可结算的二元题，请补充账号、窗口、来源。'
const previous = { runId: 'old', requestId: 'request', status: 'insufficient', phase: 'finished', summary: staleMessage }
const active = { runId: 'current', requestId: 'request', status: 'running', phase: 'prepare', summary: '', error: null }
const request = { requestId: 'request', status: 'queued', activeRunId: 'current', message: staleMessage, missingFields: ['account'], error: { message: '旧错误' }, run: active, latestRun: active, runs: [previous, active] }

test('actual retry running/prepare overrides queued request and never borrows old refusal or missing fields', () => {
  const result = courseRequestProgress(request)
  assert.equal(result.label, '正在整理问题与寻找来源')
  assert.equal(result.active, true)
  assert.equal(result.message, '')
  assert.equal(result.errorMessage, '')
  assert.equal(result.runId, 'current')
  assert.equal(request.message, staleMessage)
  assert.equal(previous.summary, staleMessage)
  assert.deepEqual(request.missingFields, ['account'])
})
test('queued and later working phases remain actual progress, with only current-run public messages', () => {
  for (const [status, phase, expected] of [['queued', 'prepare', '排队中'], ['running', 'workers', '研究员正在独立调查'], ['running', 'watch_check', '正在检查新资料']]) {
    const run = { ...active, status, phase, summary: '当前轮公开进展' }
    const result = courseRequestProgress({ ...request, runs: [previous, run], run, latestRun: run })
    assert.equal(result.label, expected)
    assert.equal(result.message, '当前轮公开进展')
  }
})
test('unknown active snapshot or another request cannot restore old errors as current progress', () => {
  const wrong = { ...active, requestId: 'other', summary: '别题发言', error: { message: '别题错误' } }
  const result = courseRequestProgress({ ...request, run: wrong, latestRun: wrong, runs: [previous, wrong] })
  assert.equal(result.label, '正在读取本轮进度')
  assert.equal(result.message, '')
  assert.equal(result.errorMessage, '')
})
test('finished insufficiency and new actual errors stay readable without changing historical records', () => {
  const failed = { ...active, status: 'failed', phase: 'finished', summary: '新轮未完成', error: { message: '当前模型超时' } }
  assert.equal(courseRequestProgress({ ...request, runs: [previous, failed], run: failed, latestRun: failed, activeRunId: null }).errorMessage, '当前模型超时')
  const result = courseRequestProgress({ ...request, activeRunId: null, run: previous, latestRun: previous, runs: [previous] })
  assert.equal(result.label, '本轮资料不足，暂未判断')
  assert.equal(result.message, staleMessage)
  assert.equal(courseRequestProgress({ status: 'needs_clarification', message: staleMessage }).errorMessage, staleMessage)
})
test('stopped request is not shown as active while cancellation finishes', () => {
  assert.deepEqual(courseRequestProgress({ ...request, status: 'stopped' }), { label: '跟踪已停止', message: '', errorMessage: '', active: false, runId: 'current' })
})
test('deep research/Pro label requires explicit public live reasoning metadata', () => {
  assert.equal(courseReasoningLabel({ modelMode: 'live', modelRef: 'deepseek-v4-pro' }), null)
  assert.equal(courseReasoningLabel({ modelMode: 'mock', modelRef: 'deepseek-v4-pro', reasoningSettings: { thinking: 'enabled' } }), null)
  assert.equal(courseReasoningLabel({ capabilities: { modelMode: 'live', modelRef: 'deepseek-v4-pro', reasoningSettings: { thinking: 'enabled' } } }), '深度研判 / Pro')
  assert.equal(courseReasoningLabel({ modelMode: 'live', modelRef: 'other', reasoningSettings: { thinking: 'enabled' } }), '深度研判')
})
