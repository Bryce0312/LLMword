import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createStore } from './store.mjs'

async function database(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-sqlite-'))
  const path = join(folder, 'm0.sqlite')
  const opened = []
  t.after(async () => {
    opened.forEach((store) => store.close())
    await rm(folder, { recursive: true, force: true })
  })
  return {
    path,
    open() {
      const store = createStore({ path })
      opened.push(store)
      return store
    },
  }
}

function runInput(suffix = 'one') {
  return {
    runId: `run_${suffix}`, topicId: `topic_${suffix}`, predictionId: `prediction_${suffix}`,
    idempotencyKey: 'request-1', scope: 'replay', trigger: 'manual',
    config: { tools: ['read_evidence', 'calculate'], cutoff: '2026-11-18T08:00:00Z' },
    checkpoint: { position: 'initial', messages: [] },
  }
}

const receipt = (id = 'call_one') => ({
  toolCallId: id, toolId: 'read_evidence', assignmentId: 'assignment_one', agentInstanceId: 'worker_one',
  arguments: { evidenceId: 'ev_one' }, result: { status: 'ok', evidenceIds: ['ev_one'], data: { text: 'Fixture only' } },
})

test('a real SQLite database reopens runs, checkpoint, receipts and stable event watermarks', async (t) => {
  const fixture = await database(t)
  const first = fixture.open()
  const input = runInput()
  const run = first.createRun(input)
  input.config.tools.push('later_edit')
  assert.deepEqual(run.config.tools, ['read_evidence', 'calculate'])
  const committed = first.commitStep({
    runId: run.runId, expectedVersion: 1, idempotencyKey: 'step-1', status: 'running',
    checkpoint: { position: 'after_tool', messages: [{ role: 'tool', tool_call_id: 'call_one', content: 'Fixture only' }] },
    toolReceipt: receipt(),
    event: { type: 'tool.completed', payload: { toolCallId: 'call_one', assignmentId: 'assignment_one' } },
  })
  assert.equal(committed.run.version, 2)
  assert.equal(committed.events.length, 1)
  assert.equal(committed.events[0].seq, 2)
  assert.equal(committed.events[0].topicId, run.topicId)
  assert.equal(committed.events[0].predictionId, run.predictionId)
  const epoch = first.metadata.serverEpoch
  first.close()

  const reopened = fixture.open()
  assert.equal(reopened.metadata.serverEpoch, epoch)
  assert.equal(reopened.getRun(run.runId).checkpoint.position, 'after_tool')
  assert.equal(reopened.getToolReceipt(run.runId, 'call_one').result.data.text, 'Fixture only')
  const events = reopened.listEvents({ afterSeq: 1 })
  assert.deepEqual(events, committed.events)
  assert.deepEqual(reopened.listEvents({ afterSeq: 2 }), [])
  assert.equal(reopened.getSnapshot(run.runId).coveredThroughCursor, `${epoch}:2`)
  const next = reopened.commitStep({
    runId: run.runId, expectedVersion: 2, status: 'completed',
    checkpoint: { position: 'complete' }, event: { type: 'run.finished', payload: {} },
  })
  assert.equal(next.events[0].seq, 3)
})

test('a new process recovers the committed checkpoint after a writer exits without closing', async (t) => {
  const fixture = await database(t)
  const moduleUrl = new URL('./store.mjs', import.meta.url).href
  const script = `
    import { createStore } from ${JSON.stringify(moduleUrl)};
    const store = createStore({ path: ${JSON.stringify(fixture.path)} });
    const run = store.createRun(${JSON.stringify(runInput('restart'))});
    store.commitStep({
      runId: run.runId, status: 'waiting', idempotencyKey: 'restart-step',
      checkpoint: { position: 'await_model', requestCount: 2 },
      event: { type: 'run.waiting', payload: { reason: 'model_retry' } }
    });
    process.exit(0);
  `
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(writer.status, 0, writer.stderr)
  const recovered = fixture.open()
  assert.equal(recovered.getRun('run_restart').status, 'waiting')
  assert.deepEqual(recovered.getRun('run_restart').checkpoint, { position: 'await_model', requestCount: 2 })
  assert.equal(recovered.listEvents({ afterSeq: 1 })[0].type, 'run.waiting')
})

test('create and commit idempotency return stable IDs and reject changed requests', async (t) => {
  const fixture = await database(t)
  const store = fixture.open()
  const first = store.createRun(runInput())
  const repeated = store.createRun(runInput())
  assert.deepEqual(first, repeated)
  assert.equal(store.listEvents().length, 1)
  assert.throws(() => store.createRun({ ...runInput(), config: { changed: true } }),
    { code: 'IDEMPOTENCY_CONFLICT', status: 409 })
  const step = {
    runId: first.runId, expectedVersion: 1, status: 'running',
    checkpoint: { position: 'done' }, toolReceipt: receipt(),
    event: { type: 'tool.completed', payload: { summary: 'Saved' } },
  }
  const result = store.commitStep(step)
  const replayed = store.commitStep(step)
  assert.equal(replayed.duplicate, true)
  assert.deepEqual(replayed.events, result.events)
  assert.equal(store.getRun(first.runId).version, 2)
  assert.equal(store.listEvents().length, 2)
  assert.throws(() => store.commitStep({ ...step, checkpoint: { position: 'changed' } }),
    { code: 'IDEMPOTENCY_CONFLICT' })
  store.cancelRun(first.runId)
  assert.equal(store.commitStep(step).duplicate, true)
  assert.equal(store.getRun(first.runId).status, 'cancelled')
})

test('failed commits roll back their receipts, checkpoint, run version and events together', async (t) => {
  const fixture = await database(t)
  const store = fixture.open()
  const run = store.createRun(runInput())
  const eventId = store.listEvents()[0].eventId
  assert.throws(() => store.commitStep({
    runId: run.runId, status: 'running', checkpoint: { position: 'must_rollback' },
    toolReceipt: receipt(), events: [
      { type: 'tool.completed', payload: {} },
      { eventId, type: 'run.started', payload: {} },
    ],
  }))
  assert.deepEqual(store.getRun(run.runId), run)
  assert.equal(store.getToolReceipt(run.runId, 'call_one'), null)
  assert.equal(store.listEvents().length, 1)
  const next = store.commitStep({ runId: run.runId, event: { type: 'run.started', payload: {} }, status: 'running' })
  assert.equal(next.events[0].seq, 2)
})

test('cancellation blocks late business commits while audit-only receipts remain recoverable', async (t) => {
  const fixture = await database(t)
  const first = fixture.open()
  const run = first.createRun(runInput())
  first.commitStep({ runId: run.runId, status: 'running', checkpoint: { position: 'tool_in_flight' } })
  const otherConnection = fixture.open()
  const cancelled = otherConnection.cancelRun(run.runId)
  assert.equal(cancelled.status, 'cancelled')
  assert.throws(() => first.commitStep({
    runId: run.runId, status: 'completed', checkpoint: { position: 'late_publish' },
    event: { type: 'forecast.published', payload: {} }, toolReceipt: receipt(),
  }), { code: 'RUN_CANCELLED' })
  const after = first.getRun(run.runId)
  assert.equal(after.checkpoint.position, 'tool_in_flight')
  assert.equal(first.getToolReceipt(run.runId, 'call_one'), null)
  const audit = first.recordLateToolReceipt({ runId: run.runId, toolReceipt: receipt() })
  assert.equal(audit.auditOnly, true)
  assert.equal(first.getRun(run.runId).version, cancelled.version)
  const watermark = first.getSnapshot(run.runId).coveredThroughCursor
  assert.deepEqual(otherConnection.cancelRun(run.runId), cancelled)
  assert.equal(first.getSnapshot(run.runId).coveredThroughCursor, watermark)
  assert.deepEqual(first.recordLateToolReceipt({ runId: run.runId, toolReceipt: receipt() }), audit)
})

test('version conflicts and tool receipt identity cannot cross run boundaries', async (t) => {
  const fixture = await database(t)
  const store = fixture.open()
  const a = store.createRun(runInput('a'))
  const b = store.createRun(runInput('b'))
  store.commitStep({ runId: a.runId, status: 'running', toolReceipt: receipt() })
  assert.equal(store.getToolReceipt(b.runId, 'call_one'), null)
  assert.throws(() => store.commitStep({ runId: a.runId, expectedVersion: 1, checkpoint: {} }),
    { code: 'VERSION_CONFLICT' })
  assert.throws(() => store.commitStep({
    runId: b.runId, toolReceipt: { ...receipt(), runId: a.runId },
  }), { code: 'TOOL_RECEIPT_SCOPE_MISMATCH' })
  store.commitStep({ runId: b.runId, toolReceipt: receipt(), event: { type: 'tool.completed', payload: {} } })
  assert.equal(store.getToolReceipt(b.runId, 'call_one').runId, b.runId)
  assert.equal(store.listEvents({ runId: a.runId }).length, 1)
  assert.equal(store.listEvents({ runId: b.runId }).length, 2)
  assert.equal(store.listRuns({ predictionId: b.predictionId }).length, 1)
  assert.throws(() => store.listEvents({ afterSeq: -1 }), { code: 'INVALID_EVENT_CURSOR' })
})

test('completed and failed runs reject state changes and checkpoint mutations do not leak', async (t) => {
  const fixture = await database(t)
  const store = fixture.open()
  for (const status of ['completed', 'failed']) {
    const run = store.createRun(runInput(status))
    store.commitStep({ runId: run.runId, status: 'running', checkpoint: { kept: true } })
    store.commitStep({ runId: run.runId, status })
    assert.throws(() => store.commitStep({ runId: run.runId, checkpoint: { kept: false } }),
      { code: 'RUN_TERMINAL' })
    const read = store.getRun(run.runId)
    read.checkpoint.kept = false
    assert.equal(store.getRun(run.runId).checkpoint.kept, true)
  }
})
