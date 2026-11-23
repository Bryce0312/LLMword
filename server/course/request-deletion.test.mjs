import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseStore } from './course-store.mjs'
import { createCourseService } from './course-service.mjs'
import { BOUNDED_FORECAST_POLICY } from './bounded-forecast.mjs'
import { WARNING_POLICY } from './weather-warning.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { handleCourseApi } from '../course-http.mjs'

const NOW = '2026-11-23T03:00:00.000Z'
const guard = request => ({ confirmed: true, expectedUpdatedAt: request.updatedAt, expectedLatestRunId: request.latestRunId })
const input = { question: 'A preserved historical fixture', purpose: 'forecast', watch: false, modelMode: 'mock', sourceMode: 'replay', budget: { maxTotalTokens: 100000, strategy: BOUNDED_FORECAST_POLICY } }
async function folderFixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-request-deletion-'))
  return { folder, path: join(folder, 'course.sqlite') }
}
function ended(store, { status = 'failed', key, data = input } = {}) {
  const created = store.createRequest(data, key ? { idempotencyKey: key } : {})
  store.saveRun(created.latestRunId, { status, phase: 'review', message: 'Preserved final state' })
  return store.requireRequest(created.requestId)
}
function archiveRows(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Object.fromEntries(['course_requests', 'course_runs', 'course_assignments', 'course_events', 'course_evidence', 'course_forecasts', 'course_watches', 'course_results'].map(table => [table, db.prepare(`SELECT record_json FROM ${table} ORDER BY rowid`).all().map(row => row.record_json)]))
  } finally { db.close() }
}

test('deletion persists independently without rewriting sealed forecast, evidence, role snapshots or events', async t => {
  const { path, folder } = await folderFixture(t)
  let store = createCourseStore({ path, now: () => NOW })
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }) })
  const request = store.createRequest(input), runId = request.latestRunId
  const prediction = { predictionId: 'preserved_prediction', version: 1, type: 'binary', status: 'ready', validation: { ready: true },
    forecastClosesAt: '2026-11-24T03:00:00.000Z', targetAt: '2026-11-24T03:00:00.000Z', resolutionRuleVersion: 1, resolutionSource: { url: 'https://example.com/official' } }
  store.updateRequest(request.requestId, { predictionId: prediction.predictionId })
  store.saveRun(runId, { status: 'running', topicId: 'preserved_topic', predictionId: prediction.predictionId, predictionVersion: 1, state: { roleSpecs: [{ agentSpecId: 'official', specVersion: 7 }] } })
  const evidenceIds = []
  for (const roleId of ['official', 'verification']) {
    const assignmentId = 'assignment_' + roleId, evidenceId = 'evidence_' + roleId
    store.createAssignment(runId, { assignmentId, roleId, config: { specVersion: 7 } })
    store.recordEvidence(runId, { evidenceId, topicId: 'preserved_topic', predictionId: prediction.predictionId, title: 'Immutable source', text: 'Original independently read fixture text.',
      url: prediction.resolutionSource.url, contentHash: evidenceId, sourceMode: 'replay', publishedAt: '2026-11-22T02:00:00.000Z' }, assignmentId)
    store.saveAssignment(assignmentId, { status: 'completed', report: { status: 'complete', summary: 'Supported fixture estimate.', evidenceIds: [evidenceId], probability: .6 } })
    evidenceIds.push(evidenceId)
  }
  const forecast = store.publishForecast(runId, { probabilityYes: .6, summary: 'Preserved judgment.', evidenceIds }, prediction)
  store.saveRun(runId, { status: 'completed' })
  store.saveWatch(request.requestId, { status: 'off', nextDueAt: null })
  const current = store.requireRequest(request.requestId), before = archiveRows(path)
  const receipt = store.deleteRequest(current.requestId, guard(current))
  assert.deepEqual(receipt, { requestId: current.requestId, deleted: true, deletedAt: NOW, predictionId: prediction.predictionId })
  assert.deepEqual(archiveRows(path), before)
  assert.deepEqual(store.listRequests(), [])
  assert.deepEqual(store.listWatches(), [])
  assert.equal(store.getWatch(current.requestId).status, 'off', 'The archived watch is preserved')
  store.close(); store = createCourseStore({ path, now: () => '2026-11-24T03:00:00.000Z' })
  assert.deepEqual(store.deleteRequest(current.requestId, guard(current)), receipt, 'The exact receipt survives restart')
  assert.equal(store.getRequest(current.requestId).deleted, true)
  assert.equal(store.getRequest(current.requestId).deletedAt, NOW)
  assert.deepEqual(store.listDeletedRequestIds(), [current.requestId])
  assert.deepEqual(store.listDeletedPredictionIds(), [prediction.predictionId])
  assert.deepEqual(store.listForecasts({ requestId: current.requestId }), [forecast])
  assert.deepEqual(archiveRows(path), before)
})

test('confirmation and both concurrency guards prevent stale dialogs or another record being deleted', t => {
  let at = NOW
  const store = createCourseStore({ path: ':memory:', now: () => at }); t.after(() => store.close())
  const first = ended(store), second = ended(store)
  for (const invalid of [null, {}, { ...guard(first), confirmed: false }, { ...guard(first), unexpected: true }, { confirmed: true, expectedUpdatedAt: NOW }]) {
    assert.throws(() => store.deleteRequest(first.requestId, invalid), { code: 'INVALID_REQUEST_DELETE', status: 400 })
  }
  assert.throws(() => store.deleteRequest(second.requestId, guard(first)), { code: 'REQUEST_DELETE_CONFLICT', status: 409 })
  const stale = guard(first)
  at = '2026-11-23T03:01:00.000Z'; store.updateRequest(first.requestId, { message: 'Changed since confirmation' })
  assert.throws(() => store.deleteRequest(first.requestId, stale), { code: 'REQUEST_DELETE_CONFLICT' })
  const priorRun = store.requireRequest(first.requestId)
  const next = store.queueRun(first.requestId); store.saveRun(next.runId, { status: 'failed' })
  assert.throws(() => store.deleteRequest(first.requestId, guard(priorRun)), { code: 'REQUEST_DELETE_CONFLICT' })
  const current = store.requireRequest(first.requestId), receipt = store.deleteRequest(first.requestId, guard(current))
  assert.deepEqual(store.deleteRequest(first.requestId, guard(current)), receipt)
  assert.throws(() => store.deleteRequest(first.requestId, stale), { code: 'REQUEST_DELETE_CONFLICT' })
  assert.equal(store.getRequest(second.requestId).deleted, undefined)
  assert.equal(store.listRequests().length, 1)
})

test('queued, running and active watching requests are rejected without cancellation or watch mutation', t => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW }); t.after(() => store.close())
  const queued = store.createRequest(input)
  assert.throws(() => store.deleteRequest(queued.requestId, guard(queued)), { code: 'REQUEST_IN_USE' })
  store.saveRun(queued.latestRunId, { status: 'running' })
  const running = store.requireRequest(queued.requestId)
  assert.throws(() => store.deleteRequest(running.requestId, guard(running)), { code: 'REQUEST_IN_USE' })
  assert.equal(store.getRun(queued.latestRunId).status, 'running')
  store.saveRun(queued.latestRunId, { status: 'failed' })
  const final = store.requireRequest(queued.requestId)
  const watch = store.saveWatch(final.requestId, { status: 'active', nextDueAt: null })
  assert.throws(() => store.deleteRequest(final.requestId, guard(final)), { code: 'REQUEST_IN_USE' })
  assert.deepEqual(store.getWatch(final.requestId), watch)
  store.saveWatch(final.requestId, { status: 'paused_provider', nextDueAt: null })
  assert.equal(store.deleteRequest(final.requestId, guard(final)).deleted, true)
})

test('deleted requests cannot be queued, resumed, updated, resolved, stopped or recreated by the original idempotency key', t => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW }); t.after(() => store.close())
  const request = ended(store, { key: 'original-request' })
  store.deleteRequest(request.requestId, guard(request))
  for (const action of [
    () => store.queueRun(request.requestId, 'manual'), () => store.queueRun(request.requestId, 'watch'),
    () => store.resumeResearchSummary(request.latestRunId), () => store.updateRequest(request.requestId, { deleted: false }),
    () => store.saveWatch(request.requestId, { status: 'active' }), () => store.stop(request.requestId),
    () => store.recordResult(request.requestId, {}), () => store.recordPriceResult(request.requestId, {}),
    () => store.recordWarningResult(request.requestId, {}), () => store.publishResearch(request.latestRunId, null, { assemble: true }),
    () => store.publishForecast(request.latestRunId, {}, {}, { recoverRecordedCandidate: true }),
    () => store.createRequest(input, { idempotencyKey: 'original-request' }),
  ]) assert.throws(action, { code: 'REQUEST_DELETED', status: 409 })
  assert.equal(store.listRuns({ requestId: request.requestId }).length, 1)
})

async function serviceFixture(t, { warningReader } = {}) {
  const { folder, path } = await folderFixture(t)
  const seed = createCourseStore({ path, now: () => NOW })
  const request = ended(seed); seed.close()
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  let modelCalls = 0
  const service = createCourseService({ path, workbench, sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW }),
    provider: { model: 'offline-test', async complete() { modelCalls++; throw new Error('No model should run in deletion tests') } }, now: () => NOW, warningReader })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { service, request, path, get modelCalls() { return modelCalls } }
}

test('HTTP deletion hides the request, reports persistent suppression IDs, preserves direct audit GET and blocks all continuations', { timeout: 4000 }, async t => {
  const f = await serviceFixture(t), { service, request } = f
  const server = createServer((req, res) => { void handleCourseApi(service, req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/v1/course`
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, value: await response.json() }
  }
  const path = '/requests/' + request.requestId
  assert.equal((await call(path, 'DELETE', {})).value.error.code, 'INVALID_REQUEST_DELETE')
  const removed = await call(path, 'DELETE', guard(request)); assert.equal(removed.status, 200)
  assert.deepEqual((await call(path, 'DELETE', guard(request))).value, removed.value)
  const listed = (await call('/requests')).value
  assert.deepEqual(listed.requests, [])
  assert.deepEqual(listed.deletedRequestIds, [request.requestId])
  assert.deepEqual(listed.deletedPredictionIds, [])
  const audit = (await call(path)).value
  assert.equal(audit.deleted, true); assert.equal(audit.runs[0].runId, request.latestRunId)
  assert.equal((await call('/runs/' + request.latestRunId)).status, 200)
  for (const action of [path + '/check', path + '/resolve', path + '/stop', '/runs/' + request.latestRunId + '/resume-summary', '/runs/' + request.latestRunId + '/assemble-report']) {
    const response = await call(action, 'POST', {})
    assert.equal(response.status, 409, action); assert.equal(response.value.error.code, 'REQUEST_DELETED', action)
  }
  service.resume(); await service.idle()
  assert.equal(f.modelCalls, 0)
  assert.equal(service.getRequest(request.requestId).runs.length, 1)
})

test('an in-flight result reader blocks deletion until it settles, then deleted resolve never calls the reader again', { timeout: 4000 }, async t => {
  let enter, release, reads = 0
  const entered = new Promise(resolve => { enter = resolve }), held = new Promise(resolve => { release = resolve })
  const f = await serviceFixture(t, { warningReader: async () => { reads++; enter(); await held; throw new Error('Fixture source unavailable') } })
  const seed = createCourseStore({ path: f.path, now: () => NOW })
  seed.updateRequest(f.request.requestId, { resolutionPolicy: { version: WARNING_POLICY }, normalized: { targetAt: '2026-11-23T02:59:30.000Z' } }); seed.close()
  const request = f.service.getRequest(f.request.requestId)
  const resolving = f.service.resolve(request.requestId)
  await entered
  assert.throws(() => f.service.deleteRequest(request.requestId, guard(request)), { code: 'REQUEST_IN_USE' })
  release(); await assert.rejects(resolving, { code: 'RESULT_SOURCE_UNAVAILABLE' })
  assert.equal(f.service.deleteRequest(request.requestId, guard(request)).deleted, true)
  await assert.rejects(f.service.resolve(request.requestId), { code: 'REQUEST_DELETED' })
  assert.equal(reads, 1); assert.equal(f.modelCalls, 0)
})
