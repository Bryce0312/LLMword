import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const TRANSITIONS = {
  queued: new Set(['queued', 'running', 'waiting', 'failed']),
  running: new Set(['running', 'waiting', 'completed', 'failed']),
  waiting: new Set(['waiting', 'queued', 'running', 'completed', 'failed']),
}

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status, retryable: false })
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw failure('INVALID_STORE_INPUT', `${field} must be a nonempty string of at most 256 characters.`, 400)
  }
  return value
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('INVALID_STORE_INPUT', `${field} must be a JSON object.`, 400)
  }
  return value
}

function encode(value) {
  try {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Nonfinite number')
      return item
    })
    if (serialized === undefined) throw new Error('Undefined root')
    return serialized
  } catch {
    throw failure('INVALID_STORE_INPUT', 'Stored values must be serializable JSON with finite numbers.', 400)
  }
}

function fingerprint(value) {
  function sort(item) {
    if (Array.isArray(item)) return item.map(sort)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
  }
  return createHash('sha256').update(JSON.stringify(sort(JSON.parse(encode(value))))).digest('hex')
}

const decode = (value) => JSON.parse(value)

function checkedList(single, multiple, field) {
  if (multiple !== undefined && !Array.isArray(multiple)) {
    throw failure('INVALID_STORE_INPUT', `${field} must be an array.`, 400)
  }
  return [...(single === undefined ? [] : [single]), ...(multiple || [])]
}

/**
 * M0 store. Methods are synchronous so every transaction finishes before a
 * runtime can emit its returned events. External calls happen outside this API.
 * A store owns its file. Existing V0 JSON archives are never imported here.
 */
export function createStore({ path, now = () => new Date().toISOString() } = {}) {
  text(path, 'path')
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  let closed = false

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL')
    const currentVersion = db.prepare('PRAGMA user_version').get().user_version
    if (currentVersion > SCHEMA_VERSION) {
      throw failure('STORE_VERSION_UNSUPPORTED', 'This database uses a newer storage schema.', 500)
    }
    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          prediction_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('live', 'replay')),
          trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'watch')),
          status TEXT NOT NULL,
          version INTEGER NOT NULL,
          config_json TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL,
          create_key TEXT NOT NULL,
          create_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (prediction_id, create_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          emitted_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, seq);
        CREATE TABLE IF NOT EXISTS tool_receipts (
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          tool_call_id TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          receipt_hash TEXT NOT NULL,
          audit_only INTEGER NOT NULL CHECK (audit_only IN (0, 1)),
          recorded_at TEXT NOT NULL,
          PRIMARY KEY (run_id, tool_call_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS commits (
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          idempotency_key TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (run_id, idempotency_key)
        ) STRICT;
        PRAGMA user_version = 1;
      `)
      db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('serverEpoch', randomUUID())
    })
  } catch (error) {
    db.close()
    throw error
  }

  const metadata = Object.freeze({
    serverEpoch: db.prepare('SELECT value FROM metadata WHERE key = ?').get('serverEpoch').value,
    schemaVersion: SCHEMA_VERSION,
  })

  function timestamp() {
    const time = now()
    if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) {
      throw failure('INVALID_STORE_CLOCK', 'The store clock must return a valid ISO date string.', 500)
    }
    return time
  }

  function getRun(runId) {
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (!row) return null
    return {
      runId: row.run_id, topicId: row.topic_id, predictionId: row.prediction_id,
      scope: row.scope, trigger: row.trigger, status: row.status, version: row.version,
      config: decode(row.config_json), checkpoint: decode(row.checkpoint_json),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  function requireRun(runId) {
    const run = getRun(text(runId, 'runId'))
    if (!run) throw failure('RUN_NOT_FOUND', 'The requested run does not exist.', 404)
    return run
  }

  function appendEvent(run, input, emittedAt) {
    record(input, 'event')
    const type = text(input.type, 'event.type')
    const eventId = input.eventId === undefined ? `event_${randomUUID()}` : text(input.eventId, 'eventId')
    const payload = input.payload === undefined ? {} : record(input.payload, 'event.payload')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO events (event_id, run_id, type, payload_json, emitted_at) VALUES (?, ?, ?, ?, ?)
    `).run(eventId, run.runId, type, encode(payload), emittedAt)
    return {
      schemaVersion: 1, serverEpoch: metadata.serverEpoch, eventId, seq: Number(lastInsertRowid),
      emittedAt, topicId: run.topicId, predictionId: run.predictionId, runId: run.runId,
      scope: run.scope, trigger: run.trigger, type, payload: decode(encode(payload)),
    }
  }

  function receiptById(runId, toolCallId) {
    const row = db.prepare('SELECT * FROM tool_receipts WHERE run_id = ? AND tool_call_id = ?').get(runId, toolCallId)
    if (!row) return null
    return { ...decode(row.receipt_json), auditOnly: Boolean(row.audit_only), recordedAt: row.recorded_at }
  }

  function putReceipt(run, receipt, auditOnly, recordedAt) {
    record(receipt, 'toolReceipt')
    const toolCallId = text(receipt.toolCallId, 'toolReceipt.toolCallId')
    const toolId = text(receipt.toolId, 'toolReceipt.toolId')
    if (receipt.runId !== undefined && receipt.runId !== run.runId) {
      throw failure('TOOL_RECEIPT_SCOPE_MISMATCH', 'The tool receipt belongs to another run.')
    }
    const normalized = { ...receipt, runId: run.runId }
    delete normalized.auditOnly
    delete normalized.recordedAt
    const hash = fingerprint(normalized)
    const previous = db.prepare('SELECT receipt_hash FROM tool_receipts WHERE run_id = ? AND tool_call_id = ?').get(run.runId, toolCallId)
    if (previous) {
      if (previous.receipt_hash !== hash) {
        throw failure('TOOL_RECEIPT_CONFLICT', 'The tool call already has a different immutable receipt.')
      }
      return receiptById(run.runId, toolCallId)
    }
    db.prepare(`
      INSERT INTO tool_receipts
      (run_id, tool_call_id, tool_id, receipt_json, receipt_hash, audit_only, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(run.runId, toolCallId, toolId, encode(normalized), hash, auditOnly ? 1 : 0, recordedAt)
    return receiptById(run.runId, toolCallId)
  }

  function createRun(input) {
    record(input, 'run')
    const topicId = text(input.topicId, 'topicId')
    const predictionId = text(input.predictionId, 'predictionId')
    const { scope = 'live', trigger = 'manual', config = {}, checkpoint = null } = input
    if (!['live', 'replay'].includes(scope) || !['manual', 'watch'].includes(trigger)) {
      throw failure('INVALID_STORE_INPUT', 'Unsupported run scope or trigger.', 400)
    }
    const runId = input.runId === undefined ? `run_${randomUUID()}` : text(input.runId, 'runId')
    const key = input.idempotencyKey === undefined ? runId : text(input.idempotencyKey, 'idempotencyKey')
    const inputHash = fingerprint({ topicId, predictionId, scope, trigger, config, checkpoint,
      ...(input.runId === undefined ? {} : { runId }) })
    return transaction(() => {
      const existing = db.prepare('SELECT run_id, create_hash FROM runs WHERE prediction_id = ? AND create_key = ?').get(predictionId, key)
      if (existing) {
        if (existing.create_hash !== inputHash) throw failure('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for different run inputs.')
        return getRun(existing.run_id)
      }
      if (getRun(runId)) throw failure('RUN_CONFLICT', 'The run ID already exists.')
      const at = timestamp()
      db.prepare(`
        INSERT INTO runs (run_id, topic_id, prediction_id, scope, trigger, status,
          version, config_json, checkpoint_json, create_key, create_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?)
      `).run(runId, topicId, predictionId, scope, trigger, encode(config), encode(checkpoint), key, inputHash, at, at)
      const run = getRun(runId)
      appendEvent(run, { type: 'run.queued', payload: {} }, at)
      return run
    })
  }

  function commitStep(input) {
    record(input, 'step')
    const runId = text(input.runId, 'runId')
    const receipts = checkedList(input.toolReceipt, input.toolReceipts, 'toolReceipts')
    const events = checkedList(input.event, input.events, 'events')
    // A tool result has a natural replay identity even if the caller omits a key.
    const key = input.idempotencyKey === undefined
      ? receipts.length ? `tools:${receipts.map((receipt) => text(receipt.toolCallId, 'toolCallId')).join('|')}` : null
      : text(input.idempotencyKey, 'idempotencyKey')
    const inputHash = fingerprint({
      checkpoint: input.checkpoint, status: input.status, expectedVersion: input.expectedVersion, receipts, events,
    })
    return transaction(() => {
      if (key) {
        const previous = db.prepare('SELECT * FROM commits WHERE run_id = ? AND idempotency_key = ?').get(runId, key)
        if (previous) {
          if (previous.input_hash !== inputHash) throw failure('IDEMPOTENCY_CONFLICT', 'The step key was used for a different commit.')
          return { ...decode(previous.result_json), duplicate: true }
        }
      }
      const run = requireRun(runId)
      if (TERMINAL.has(run.status) || run.status === 'cancelling') {
        throw failure(run.status === 'cancelled' || run.status === 'cancelling' ? 'RUN_CANCELLED' : 'RUN_TERMINAL',
          'This run no longer accepts state commits.')
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw failure('VERSION_CONFLICT', 'The run version changed before this commit.')
      }
      const status = input.status ?? run.status
      if (!TRANSITIONS[run.status]?.has(status)) throw failure('INVALID_RUN_TRANSITION', 'Invalid run status transition.')
      const at = timestamp()
      const savedReceipts = receipts.map((receipt) => putReceipt(run, receipt, false, at))
      const savedEvents = events.map((event) => appendEvent(run, event, at))
      const checkpoint = input.checkpoint === undefined ? run.checkpoint : input.checkpoint
      db.prepare('UPDATE runs SET status = ?, version = version + 1, checkpoint_json = ?, updated_at = ? WHERE run_id = ?')
        .run(status, encode(checkpoint), at, runId)
      const result = { run: getRun(runId), events: savedEvents, toolReceipts: savedReceipts, duplicate: false }
      if (key) {
        db.prepare('INSERT INTO commits (run_id, idempotency_key, input_hash, result_json) VALUES (?, ?, ?, ?)')
          .run(runId, key, inputHash, encode(result))
      }
      return result
    })
  }

  function cancelRun(runId) {
    return transaction(() => {
      const run = requireRun(runId)
      if (TERMINAL.has(run.status)) return run
      const at = timestamp()
      db.prepare("UPDATE runs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE run_id = ?").run(at, runId)
      appendEvent(run, { type: 'run.cancelled', payload: { reason: 'requested' } }, at)
      return getRun(runId)
    })
  }

  function listRuns({ status, predictionId } = {}) {
    const filters = []
    const values = []
    if (status !== undefined) { filters.push('status = ?'); values.push(status) }
    if (predictionId !== undefined) { filters.push('prediction_id = ?'); values.push(predictionId) }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
    return db.prepare(`SELECT run_id FROM runs${where} ORDER BY created_at, run_id`).all(...values).map((row) => getRun(row.run_id))
  }

  function listEvents({ afterSeq = 0, runId, limit = 200 } = {}) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw failure('INVALID_EVENT_CURSOR', 'Event cursor or page limit is invalid.', 400)
    }
    const filter = runId === undefined ? '' : ' AND e.run_id = ?'
    const params = runId === undefined ? [afterSeq, limit] : [afterSeq, runId, limit]
    return db.prepare(`
      SELECT e.*, r.topic_id, r.prediction_id, r.scope, r.trigger FROM events e
      JOIN runs r ON r.run_id = e.run_id WHERE e.seq > ?${filter} ORDER BY e.seq LIMIT ?
    `).all(...params).map((row) => ({
      schemaVersion: 1, serverEpoch: metadata.serverEpoch, eventId: row.event_id, seq: row.seq,
      emittedAt: row.emitted_at, topicId: row.topic_id, predictionId: row.prediction_id,
      runId: row.run_id, scope: row.scope, trigger: row.trigger, type: row.type, payload: decode(row.payload_json),
    }))
  }

  return {
    metadata, createRun, getRun, listRuns, commitStep, cancelRun, listEvents,
    getToolReceipt: receiptById,
    recordLateToolReceipt({ runId, toolReceipt }) {
      return transaction(() => {
        const run = requireRun(runId)
        if (!TERMINAL.has(run.status) && run.status !== 'cancelling') {
          throw failure('RUN_ACTIVE', 'Active tool results must be committed with their checkpoint and event.')
        }
        return putReceipt(run, toolReceipt, true, timestamp())
      })
    },
    getSnapshot(runId) {
      return transaction(() => ({
        run: requireRun(runId),
        coveredThroughCursor: `${metadata.serverEpoch}:${db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq}`,
      }))
    },
    close() {
      if (!closed) { db.close(); closed = true }
    },
  }
}
