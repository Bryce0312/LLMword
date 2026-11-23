import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyRecordDeleteVisible, historyRecordCanDelete, createHistoryDeletionAction, applyHistoryDeletion, historyDeletionError } from './history-deletion.mjs'
import { mergeDeletedHistoryMetadata, mergeRoomHistory } from './room-shell-navigation.mjs'

const at = '2026-11-23T04:00:00Z'
const deletedAt = '2026-11-23T05:00:00Z'
const record = (extra = {}) => ({ requestId: 'request/one', question: '用户股票题目', predictionId: 'prediction-one', status: 'completed', updatedAt: at, latestRunId: 'run-one', latestRun: { runId: 'run-one', status: 'completed' }, runs: [{ runId: 'run-one', status: 'completed' }], activeRunId: null, watch: { status: 'off' }, forecast: { probabilityYes: .5 }, ...extra })
const receipt = (value = record()) => ({ requestId: value.requestId, deleted: true, deletedAt, ...(value.predictionId ? { predictionId: value.predictionId } : {}) })

test('only judged, insufficient and failed course statuses expose deletion; active watches remain visible but disabled', () => {
  assert.equal(historyRecordDeleteVisible(record()), true); assert.equal(historyRecordCanDelete(record()), true)
  for (const status of ['failed', 'insufficient']) {
    const value = record({ status, latestRun: { runId: 'run-one', status }, runs: [{ runId: 'run-one', status }], forecast: null })
    assert.equal(historyRecordDeleteVisible(value), true); assert.equal(historyRecordCanDelete(value), true)
  }
  for (const status of ['queued', 'running', 'researching', 'cancelled']) assert.equal(historyRecordDeleteVisible(record({ latestRun: { runId: 'run-one', status } })), false)
  for (const extra of [{ purpose: 'research', researchReport: { summary: '保存研报' } }, { status: 'stopped' }, { deleted: true }, { deletedAt }]) assert.equal(historyRecordDeleteVisible(record(extra)), false)
  for (const extra of [{ activeRunId: 'other-live-run' }, { watch: { status: 'active', nextDueAt: null } }, { watch: true }, { watch: { status: 'unknown' } }, { watch: { nextDueAt: deletedAt } }, { watch: { status: null, nextDueAt: deletedAt } }, { watch: { status: '', nextDueAt: null } }, { runs: [{ runId: 'older', status: 'running' }] }, { updatedAt: undefined }, { latestRunId: '', latestRun: null }]) {
    const value = record(extra); assert.equal(historyRecordDeleteVisible(value), true); assert.equal(historyRecordCanDelete(value), false)
  }
  assert.equal(historyRecordCanDelete(record({ watch: { status: 'paused_provider' } })), true)
  assert.equal(historyRecordCanDelete(record({ watch: { status: 'completed', nextDueAt: null } })), true)
})

test('failed Tencent and Alibaba records with legacy idle watch metadata can be deleted only after explicit confirmation', async () => {
  const oldWatch = { requestId: 'legacy-request', watchId: 'legacy-watch', known: {}, checks: 0, candidateKnown: {}, updatedAt: at }
  for (const [question, watch] of [['腾讯', oldWatch], ['阿里', { ...oldWatch, status: null, nextDueAt: null }]]) {
    const value = record({ question, status: 'failed', forecast: null, activeRunId: null, latestRun: { runId: 'run-one', status: 'failed' }, runs: [{ runId: 'run-one', status: 'failed' }, { runId: 'older-run', status: 'failed' }], watch })
    assert.equal(historyRecordCanDelete(value), true, question)
    let approve; const requests = []
    const action = createHistoryDeletionAction(value, {
      confirm: message => { assert(message.includes(question)); return new Promise(resolve => { approve = resolve }) },
      request: async (url, options) => { requests.push({ url, options }); return receipt(value) },
    })
    const pending = action()
    assert.equal(requests.length, 0, 'an idle legacy watch never bypasses confirmation')
    approve(true)
    assert.deepEqual(await pending, receipt(value))
    assert.deepEqual(requests, [{ url: '/course/requests/request%2Fone', options: { method: 'DELETE', body: { confirmed: true, expectedUpdatedAt: at, expectedLatestRunId: 'run-one' } } }])
    assert.equal(historyRecordCanDelete({ ...value, activeRunId: 'active-run' }), false)
    assert.equal(historyRecordCanDelete({ ...value, runs: [...value.runs, { runId: 'running-run', status: 'running' }] }), false)
  }
})

test('cancel, rejected or non-boolean async confirmation cannot send DELETE, and pending dialogs are guarded', async () => {
  for (const confirm of [async () => false, async () => undefined, async () => 'true', async () => { throw new Error('closed') }]) {
    let requests = 0
    const action = createHistoryDeletionAction(record(), { confirm, request: async () => { requests++; throw new Error('must not send') } })
    assert.deepEqual(await action(), { deleted: false, cancelled: true }); assert.equal(requests, 0)
  }
  let decide; let requests = 0
  const action = createHistoryDeletionAction(record(), { confirm: () => new Promise(resolve => { decide = resolve }), request: async () => { requests++; return receipt() } })
  const pending = action(); assert.deepEqual(await action(), { deleted: false, busy: true }); assert.equal(requests, 0)
  decide(false); assert.deepEqual(await pending, { deleted: false, cancelled: true }); assert.equal(requests, 0)
})

test('strict true confirmation sends only the agreed optimistic guard to the encoded course URL', async () => {
  const value = record(); const calls = []
  const action = createHistoryDeletionAction(value, { confirm: async message => { assert.match(message, /用户股票题目/); assert.match(message, /从预测历史列表移除/); assert.match(message, /原始运行、判断和证据保留/); return true }, request: async (url, options) => { calls.push({ url, options }); return receipt(value) } })
  assert.equal((await action()).deleted, true)
  assert.deepEqual(calls, [{ url: '/course/requests/request%2Fone', options: { method: 'DELETE', body: { confirmed: true, expectedUpdatedAt: at, expectedLatestRunId: 'run-one' } } }])
})

test('losing the owner while a dialog is open cancels even if an old approval later resolves true', async () => {
  let active = true, decide; let requests = 0
  const action = createHistoryDeletionAction(record(), { isActive: () => active, confirm: () => new Promise(resolve => { decide = resolve }), request: async () => { requests++; return receipt() } })
  const pending = action(); active = false; decide(true)
  assert.deepEqual(await pending, { deleted: false, cancelled: true }); assert.equal(requests, 0)
})

test('changed guards or newly active work are rejected locally before any request after confirmation', async () => {
  for (const change of [value => ({ ...value, updatedAt: deletedAt }), value => ({ ...value, latestRunId: 'new-run' }), value => ({ ...value, watch: { status: 'active' } })]) {
    let current = record(), decide, requests = 0
    const action = createHistoryDeletionAction(current, { getRecord: () => current, confirm: () => new Promise(resolve => { decide = resolve }), request: async () => { requests++; return receipt() } })
    const pending = action(); current = change(current); decide(true)
    await assert.rejects(pending, error => ['REQUEST_DELETE_CONFLICT', 'REQUEST_IN_USE'].includes(error.code)); assert.equal(requests, 0)
  }
})

test('API errors and malformed receipts never remove cache records and a failed request remains retryable', async () => {
  const value = record(), cache = { courseRequests: [value], predictions: [{ predictionId: value.predictionId }] }
  let attempts = 0
  const action = createHistoryDeletionAction(value, { confirm: async () => true, request: async () => { if (++attempts === 1) throw Object.assign(new Error('PRIVATE_BODY'), { status: 404 }); return receipt(value) } })
  await assert.rejects(action(), { status: 404 }); assert.equal(cache.courseRequests[0], value); assert.equal(cache.predictions.length, 1)
  assert.equal((await action()).deleted, true)
  for (const invalid of [{}, { ...receipt(), requestId: 'another-record' }, { ...receipt(), deleted: false }, { ...receipt(), deletedAt: undefined }]) {
    const malformed = createHistoryDeletionAction(value, { confirm: async () => true, request: async () => invalid })
    await assert.rejects(malformed(), { code: 'REQUEST_DELETE_UNCONFIRMED' }); assert.equal(cache.courseRequests.length, 1)
  }
  assert.match(historyDeletionError({ status: 404 }), /重启当前服务/)
  assert(!historyDeletionError({ status: 500, message: 'SECRET_KEY_OR_BODY' }).includes('SECRET'))
})

test('confirmed deletion filters the record and its legacy counterpart and cannot be reversed by an older GET', () => {
  const value = record(), keep = record({ requestId: 'keep', predictionId: 'keep-prediction' })
  const cache = { courseRequests: [value, keep], predictions: [{ predictionId: value.predictionId }, { predictionId: 'keep-prediction' }] }
  applyHistoryDeletion(cache, receipt(value), value)
  assert.deepEqual(cache.courseRequests, [keep]); assert.deepEqual(cache.predictions, [{ predictionId: 'keep-prediction' }])
  assert(cache.deletedCourseRequestIds instanceof Set); assert(cache.deletedCoursePredictionIds instanceof Set)
  mergeDeletedHistoryMetadata(cache, { requests: [value, keep], deletedRequestIds: [], deletedPredictionIds: [] })
  cache.courseRequests = mergeRoomHistory([value, keep], cache.courseRequests, [value, keep], cache.deletedCourseRequestIds)
  assert.deepEqual(cache.courseRequests, [keep]); assert(cache.deletedCoursePredictionIds.has('prediction-one'))
})

test('failed history without a compiled prediction is protected by request tombstones across stale reads', () => {
  const failed = record({ requestId: 'failed-no-prediction', predictionId: undefined, forecast: null, status: 'failed', latestRun: { runId: 'run-one', status: 'failed' } })
  const cache = { courseRequests: [failed], predictions: [] }
  applyHistoryDeletion(cache, receipt(failed), failed)
  mergeDeletedHistoryMetadata(cache, { deletedRequestIds: [], deletedPredictionIds: [] })
  assert.deepEqual(mergeRoomHistory([failed], [], [failed], cache.deletedCourseRequestIds), [])
  assert.equal(cache.deletedCoursePredictionIds.size, 0)
})

test('server deletion metadata is monotonic and also filters deleted audit responses without trusting malformed metadata', () => {
  const a = record(), b = record({ requestId: 'second', predictionId: 'second-prediction' })
  const cache = { courseRequests: [a, b], predictions: [{ predictionId: a.predictionId }, { predictionId: b.predictionId }] }
  mergeDeletedHistoryMetadata(cache, { deletedRequestIds: [a.requestId], deletedPredictionIds: [a.predictionId] })
  mergeDeletedHistoryMetadata(cache, { deletedRequestIds: [], deletedPredictionIds: [], requests: [{ ...b, deleted: true, deletedAt }] })
  assert.deepEqual([...cache.deletedCourseRequestIds], [a.requestId, b.requestId]); assert.equal(cache.predictions.length, 0)
  mergeDeletedHistoryMetadata(cache, { deletedRequestIds: 'bad', deletedPredictionIds: 12, requests: [null] })
  assert.equal(cache.deletedCourseRequestIds.size, 2)
})
