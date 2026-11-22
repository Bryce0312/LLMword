import { randomUUID } from 'node:crypto'
import { buildTradingHorizon } from './trading-calendar.mjs'
import { DEFAULT_PREDICTION_BUDGET, validatePredictionBudget, validatePredictionSettings, totalTokenLimitReached, totalTokenLimitExceeded } from './prediction-budget.mjs'
import { validateDecisionNotes } from './collaboration.mjs'
import { assembleResearchCandidate } from './research-assembly.mjs'
import { unsentSummaryRequest } from './research-summary.mjs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { digest, domainFailure, identifier, json, validDate } from '../domain/contracts.mjs'
import { requiresWeatherObservation } from './course-context.mjs'
import { buildMemorySnapshot } from './memory-policy.mjs'
import { deriveForecastStatus } from './forecast-facts.mjs'
import { WARNING_URL, WARNING_POLICY, WARNING_RULE, parseWarnings } from './weather-warning.mjs'
import { PRICE_URL, PRICE_POLICY, PRICE_RULE, parsePriceSnapshot } from './market-resolution.mjs'
import { boundedForecastBudget, isBoundedForecast, effectiveRoleReports } from './bounded-forecast.mjs'
import { isExploratoryForecast, selectExploratoryReports } from './exploratory-reports.mjs'

export const courseFailure = (code, message, status = 400) => Object.assign(domainFailure(code, message, status), { courseSafe: true })
const terminal = new Set(['completed', 'insufficient', 'failed', 'cancelled'])
const decode = (row) => row ? JSON.parse(row.record_json) : null
const id = (kind) => `${kind}_${randomUUID()}`

/** Single-process course harness. SQLite owns committed state, never browser lifetime. */
export function createCourseStore({ path, now = () => new Date() } = {}) {
  if (typeof path !== 'string' || !path) throw courseFailure('COURSE_PATH', '课程运行时需要独立保存路径。')
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  let closed = false
  const clock = () => {
    const raw = now()
    const at = raw instanceof Date ? raw.toISOString() : raw
    if (!validDate(at)) throw courseFailure('COURSE_CLOCK', '课程运行时的时间无效。', 500)
    return at
  }
  const tx = (work) => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL')
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS course_settings (key TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_requests (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_assignments (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_receipts (run_id TEXT NOT NULL REFERENCES course_runs(id), call_key TEXT NOT NULL, input_hash TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(run_id,call_key)) STRICT;
        CREATE TABLE IF NOT EXISTS course_evidence (run_id TEXT NOT NULL REFERENCES course_runs(id), evidence_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(run_id,evidence_id)) STRICT;
        CREATE TABLE IF NOT EXISTS course_reads (run_id TEXT NOT NULL, evidence_id TEXT NOT NULL, reader_id TEXT NOT NULL, PRIMARY KEY(run_id,evidence_id,reader_id), FOREIGN KEY(run_id,evidence_id) REFERENCES course_evidence(run_id,evidence_id)) STRICT;
        CREATE TABLE IF NOT EXISTS course_read_observations (run_id TEXT NOT NULL, evidence_id TEXT NOT NULL, reader_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(run_id,evidence_id,reader_id,observed_at), FOREIGN KEY(run_id,evidence_id) REFERENCES course_evidence(run_id,evidence_id)) STRICT;
        CREATE TABLE IF NOT EXISTS course_relations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_forecasts (id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES course_runs(id), input_hash TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_research_reports (id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES course_runs(id), input_hash TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_watches (request_id TEXT PRIMARY KEY REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_results (request_id TEXT PRIMARY KEY REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_operations (operation_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
      `)
      const version = db.prepare("SELECT value FROM course_metadata WHERE key='schemaVersion'").get()
      if (version && version.value !== '1') throw courseFailure('COURSE_SCHEMA', '课程数据库版本不受支持。', 500)
      db.prepare('INSERT OR IGNORE INTO course_metadata VALUES (?,?)').run('schemaVersion', '1')
      db.prepare('INSERT OR IGNORE INTO course_metadata VALUES (?,?)').run('epoch', randomUUID())
      db.prepare('INSERT OR IGNORE INTO course_settings VALUES (?,?)').run('predictionBudget', json(DEFAULT_PREDICTION_BUDGET))
    })
  } catch (error) { db.close(); throw error }
  const epoch = db.prepare("SELECT value FROM course_metadata WHERE key='epoch'").get().value
  const getRequest = (requestId) => decode(db.prepare('SELECT record_json FROM course_requests WHERE id=?').get(identifier(requestId)))
  const getRun = (runId) => decode(db.prepare('SELECT record_json FROM course_runs WHERE id=?').get(identifier(runId)))
  const requireRequest = (requestId) => {
    const value = getRequest(requestId)
    if (!value) throw courseFailure('REQUEST_NOT_FOUND', '找不到这项跟踪请求。', 404)
    return value
  }
  const requireRun = (runId) => {
    const value = getRun(runId)
    if (!value) throw courseFailure('RUN_NOT_FOUND', '找不到这轮研究。', 404)
    return value
  }
  const active = (runId) => {
    const run = requireRun(runId)
    const request = requireRequest(run.requestId)
    if (terminal.has(run.status) || request.status === 'stopped') throw courseFailure('COURSE_CANCELLED', '研究已结束或停止。', 409)
    return run
  }
  const writeRequest = (value) => db.prepare('UPDATE course_requests SET record_json=? WHERE id=?').run(json(value), value.requestId)
  const writeRun = (value) => db.prepare('UPDATE course_runs SET record_json=? WHERE id=?').run(json(value), value.runId)
  function append(run, event) {
    const eventId = event.eventId || id('event')
    const old = db.prepare('SELECT record_json FROM course_events WHERE event_id=?').get(eventId)
    if (old) return decode(old)
    const value = { schemaVersion: 1, serverEpoch: epoch, eventId, requestId: run.requestId,
      runId: run.runId, topicId: run.topicId || null, predictionId: run.predictionId || null,
      scope: run.modelMode === 'mock' || run.sourceMode !== 'live' ? 'replay' : 'live', trigger: run.trigger,
      emittedAt: clock(), type: event.type, payload: event.payload || {} }
    const result = db.prepare('INSERT INTO course_events(event_id,run_id,record_json) VALUES (?,?,?)').run(eventId, run.runId, json(value))
    value.seq = Number(result.lastInsertRowid)
    db.prepare('UPDATE course_events SET record_json=? WHERE seq=?').run(json(value), value.seq)
    return value
  }
  function queue(requestId, trigger, configuration = {}) {
    const request = requireRequest(requestId)
    if (request.status === 'stopped') throw courseFailure('REQUEST_STOPPED', '这项跟踪已经停止。', 409)
    if (request.status === 'closed' || db.prepare('SELECT 1 FROM course_results WHERE request_id=?').get(requestId)) throw courseFailure('REQUEST_CLOSED', '本题已有结果，不能重新创建调查或改写预测。', 409)
    const previous = db.prepare('SELECT record_json FROM course_runs WHERE request_id=? ORDER BY rowid DESC').all(requestId).map(decode)
    const busy = previous.find((run) => !terminal.has(run.status))
    if (busy) return busy
    const at = clock()
    const harnessVersion = configuration.harnessVersion || request.harnessVersion || 2
    const run = { runId: id('course_run'), requestId, status: 'queued', phase: request.normalized ? 'watch_check' : harnessVersion >= 3 ? 'intake' : 'prepare',
      trigger, topicId: request.topicId || null, predictionId: request.predictionId || null,
      predictionVersion: request.predictionVersion || null, modelMode: configuration.modelMode || request.modelMode, sourceMode: configuration.sourceMode || request.sourceMode,
      providerIdentity: configuration.providerIdentity || request.providerIdentity, modelRef: configuration.modelRef || request.modelRef || null, createdAt: at, updatedAt: at, state: {},
      harnessVersion, budget: request.budget || configuration.budget || null,
      usage: { modelRequests: 0, toolCalls: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, unknownUsage: false }, error: null }
    db.prepare('INSERT INTO course_runs VALUES (?,?,?)').run(run.runId, requestId, json(run))
    writeRequest({ ...request, activeRunId: run.runId, latestRunId: run.runId, status: 'queued', updatedAt: at })
    append(run, { type: 'run.queued', payload: { summary: trigger === 'watch' ? '后台任务唤醒本题检查。' : '已收到问题，主 Agent 开始调查。' } })
    return run
  }
  function evidenceFor(runId) {
    return db.prepare('SELECT record_json FROM course_evidence WHERE run_id=? ORDER BY evidence_id').all(runId).map(decode)
      .map((record) => ({ ...record, readBy: db.prepare('SELECT reader_id FROM course_reads WHERE run_id=? AND evidence_id=?').all(runId, record.evidenceId).map((row) => row.reader_id), readObservations: db.prepare('SELECT reader_id,observed_at FROM course_read_observations WHERE run_id=? AND evidence_id=? ORDER BY observed_at,reader_id').all(runId, record.evidenceId).map(row => ({ readerId: row.reader_id, obtainedAt: row.observed_at })) }))
  }
  const getSettings = () => ({ predictionBudget: decode(db.prepare('SELECT record_json FROM course_settings WHERE key=?').get('predictionBudget')) })
  return {
    metadata: { schemaVersion: 1, serverEpoch: epoch }, clock, getRequest, requireRequest, getRun, requireRun,
    getSettings,
    updateSettings(input) {
      const value = validatePredictionSettings(input)
      return tx(() => {
        db.prepare('INSERT INTO course_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET record_json=excluded.record_json').run('predictionBudget', json(value.predictionBudget))
        return getSettings()
      })
    },
    listRequests: () => db.prepare('SELECT record_json FROM course_requests ORDER BY rowid DESC').all().map(decode),
    listRuns: ({ requestId } = {}) => (requestId
      ? db.prepare('SELECT record_json FROM course_runs WHERE request_id=? ORDER BY rowid').all(requestId)
      : db.prepare('SELECT record_json FROM course_runs ORDER BY rowid').all()).map(decode),
    createRequest(input, { idempotencyKey, predictionBudget } = {}) {
      return tx(() => {
        const hash = digest(input)
        if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120)) throw courseFailure('INVALID_IDEMPOTENCY_KEY', '幂等键格式无效。')
        const old = idempotencyKey && db.prepare('SELECT * FROM course_operations WHERE operation_key=?').get(idempotencyKey)
        if (old) {
          if (old.input_hash !== hash) throw courseFailure('IDEMPOTENCY_CONFLICT', '此幂等键已用于另一个问题。', 409)
          return requireRequest(decode(old).requestId)
        }
        const at = clock()
        const snapshot = predictionBudget && (input.purpose || 'forecast') === 'forecast' ? validatePredictionBudget(predictionBudget) : null
        const request = { ...input, ...(snapshot ? { budget: isBoundedForecast(input) ? boundedForecastBudget(input.budget, snapshot.maxTotalTokens) : { ...input.budget, maxTotalTokens: snapshot.maxTotalTokens } } : {}), requestId: id('course_request'), status: 'queued', createdAt: at, updatedAt: at, normalized: null }
        if (input.horizonTradingDays !== undefined && !input.strict?.targetAt) request.tradingHorizon = buildTradingHorizon({ question: input.question, market: input.market, tradingDays: input.horizonTradingDays, createdAt: at })
        db.prepare('INSERT INTO course_requests VALUES (?,?)').run(request.requestId, json(request))
        const run = queue(request.requestId, 'manual')
        const result = { ...requireRequest(request.requestId), activeRunId: run.runId }
        if (idempotencyKey) db.prepare('INSERT INTO course_operations VALUES (?,?,?)').run(idempotencyKey, hash, json(result))
        return result
      })
    },
    queueRun: (requestId, trigger = 'manual', configuration = {}) => tx(() => queue(requestId, trigger, configuration)),
    resumeResearchSummary(runId, { maxTokens } = {}) {
      return tx(() => {
        const run = requireRun(runId), request = requireRequest(run.requestId)
        const workers = db.prepare('SELECT record_json FROM course_assignments WHERE run_id=?').all(runId).map(decode)
        const unsent = unsentSummaryRequest(run, workers)
        const boundedForecast = request.resolutionPolicy?.version === WARNING_POLICY && Date.parse(request.normalized?.forecastClosesAt) > Date.parse(clock())
        const budgetSummary = boundedForecast && run.error?.code === 'COURSE_BUDGET' && !run.state.summaryResumeCount
        if (request.purpose !== 'research' && !boundedForecast || request.status === 'stopped' || run.status !== 'failed' || run.phase !== 'review' || (run.error?.code !== 'MODEL_INCOMPLETE' && !unsent && !budgetSummary) || run.usage.unknownUsage || !run.state.main || totalTokenLimitReached(run.budget, run.usage.totalTokens)) throw courseFailure('RESEARCH_RESUME_UNAVAILABLE', '此运行不能只续写汇总，请查看其失败原因。', 409)
        if (db.prepare('SELECT 1 FROM course_research_reports WHERE run_id=?').get(runId)) throw courseFailure('RESEARCH_CONFLICT', '研报已经封存。', 409)
        if (db.prepare('SELECT 1 FROM course_forecasts WHERE run_id=?').get(runId)) throw courseFailure('FORECAST_CONFLICT', '预测已经封存。', 409)
        if (new Set(workers.filter((item) => item.status === 'completed' && item.report?.evidenceIds?.length).map((item) => item.roleId)).size < 2) throw courseFailure('RESEARCH_RESUME_UNAVAILABLE', '已有有效报告不足，不能只续写汇总。', 409)
        const count = (run.state.summaryResumeCount || 0) + (unsent ? 0 : 1)
        if (count > (request.purpose === 'research' ? 2 : 1)) throw courseFailure('RESEARCH_RESUME_LIMIT', '本轮汇总续写次数已用完。', 409)
        run.state.summaryResumeCount = count
        if (unsent) run.state.summaryBudgetRetryCount = 1
        const outputLimit = Number.isInteger(maxTokens) ? boundedForecast ? Math.max(1024, Math.min(16384, maxTokens)) : Math.max(run.budget?.maxTokens || 0, Math.min(16384, maxTokens)) : run.budget?.maxTokens
        run.budget = { ...run.budget, maxTokens: outputLimit, mainRequests: (run.state.main.calls || 0) + 1 }
        Object.assign(run.state.main, { currentAttempt: 0, pending: null, retryNotBefore: null, lastRetry: null })
        Object.assign(run, { status: 'queued', error: null, message: '继续整理已有报告，不重新取证。', updatedAt: clock() })
        writeRun(run); writeRequest({ ...request, status: 'researching', error: null, updatedAt: clock() })
        append(run, { eventId: `${runId}_summary_resume_${count}${unsent ? '_unsent_retry' : ''}`, type: 'research.resume_requested', payload: { summary: run.message, attempt: count, unsentRetry: unsent, modelRequestsBefore: run.usage.modelRequests, maxTokens: outputLimit, policyVersion: 'research-summary-v2' } })
        return run
      })
    },
    updateRequest(requestId, patch) {
      return tx(() => {
        const request = requireRequest(requestId)
        if (request.status === 'stopped') throw courseFailure('REQUEST_STOPPED', '这项跟踪已经停止。', 409)
        const value = { ...request, ...patch, requestId, updatedAt: clock() }
        writeRequest(value); return value
      })
    },
    saveRun(runId, patch = {}, events = []) {
      return tx(() => {
        const run = active(runId)
        const value = { ...run, ...patch, runId, updatedAt: clock() }
        writeRun(value)
        for (const event of events) append(value, event)
        if (terminal.has(value.status)) {
          const request = requireRequest(run.requestId)
          writeRequest({ ...request, activeRunId: null, latestRunId: runId,
            status: value.status === 'completed' ? (request.watch === false ? 'completed' : 'watching') : value.status, message: patch.message || request.message || '', error: value.error, updatedAt: clock() })
        }
        return value
      })
    },
    event(runId, event) { return tx(() => append(active(runId), event)) },
    listEvents({ afterSeq = 0, runId, limit = 1000 } = {}) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw courseFailure('EVENT_CURSOR', '事件水位无效。')
      return (runId
        ? db.prepare('SELECT record_json FROM course_events WHERE seq>? AND run_id=? ORDER BY seq LIMIT ?').all(afterSeq, runId, limit)
        : db.prepare('SELECT record_json FROM course_events WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, limit)).map(decode)
    },
    createAssignment(runId, input) {
      return tx(() => {
        active(runId)
        const previous = decode(db.prepare('SELECT record_json FROM course_assignments WHERE id=?').get(input.assignmentId))
        if (previous) {
          if (previous.runId !== runId || digest(Object.fromEntries(Object.keys(input).map((key) => [key, previous[key]]))) !== digest(input)) throw courseFailure('ASSIGNMENT_CONFLICT', '调查任务编号已绑定另一轮或不同输入。', 409)
          return previous
        }
        const value = { ...input, runId, status: 'queued', checkpoint: null, report: null, createdAt: clock(), updatedAt: clock() }
        db.prepare('INSERT INTO course_assignments VALUES (?,?,?)').run(value.assignmentId, runId, json(value))
        return value
      })
    },
    listAssignments: (runId) => db.prepare('SELECT record_json FROM course_assignments WHERE run_id=? ORDER BY rowid').all(runId).map(decode),
    saveAssignment(assignmentId, patch, event) {
      return tx(() => {
        const previous = decode(db.prepare('SELECT record_json FROM course_assignments WHERE id=?').get(assignmentId))
        if (!previous) throw courseFailure('ASSIGNMENT_NOT_FOUND', '找不到调查任务。', 404)
        const run = active(previous.runId)
        const value = { ...previous, ...patch, assignmentId, updatedAt: clock() }
        db.prepare('UPDATE course_assignments SET record_json=? WHERE id=?').run(json(value), assignmentId)
        if (event) append(run, event)
        return value
      })
    },
    reserve(runId, kind, limit) {
      return tx(() => {
        const run = active(runId)
        if (kind === 'modelRequests' && totalTokenLimitReached(run.budget, run.usage.totalTokens)) throw courseFailure('COURSE_BUDGET', '本轮已达到总 token 预算。', 409)
        if ((run.usage[kind] || 0) >= limit) throw courseFailure('COURSE_BUDGET', '本轮调查已达到调用预算。', 409)
        run.usage[kind] = (run.usage[kind] || 0) + 1
        writeRun(run); return run.usage
      })
    },
    recordUsage(runId, totalTokens, details = null) {
      const usage = tx(() => {
        const run = active(runId)
        if (Number.isInteger(totalTokens) && totalTokens >= 0) run.usage.totalTokens += totalTokens
        else run.usage.unknownUsage = true
        if (details && typeof details === 'object') {
          for (const [source, target] of [['prompt_tokens', 'promptTokens'], ['completion_tokens', 'completionTokens'],
            ['prompt_cache_hit_tokens', 'cacheHitTokens'], ['prompt_cache_miss_tokens', 'cacheMissTokens']]) {
            if (Number.isSafeInteger(details[source]) && details[source] >= 0) run.usage[target] = (run.usage[target] || 0) + details[source]
          }
        }
        writeRun(run)
        return run.usage
      })
      if (totalTokenLimitExceeded(requireRun(runId).budget, usage.totalTokens)) throw courseFailure('COURSE_BUDGET', '本轮已达到总 token 预算。', 409)
      return usage
    },
    getReceipt(runId, callKey, input) {
      const row = db.prepare('SELECT * FROM course_receipts WHERE run_id=? AND call_key=?').get(runId, callKey)
      if (!row) return null
      if (row.input_hash !== digest(input)) throw courseFailure('TOOL_RECEIPT_CONFLICT', '已保存的工具调用参数不同。', 409)
      return decode(row)
    },
    saveReceipt(runId, callKey, input, result) {
      return tx(() => {
        active(runId)
        const old = db.prepare('SELECT * FROM course_receipts WHERE run_id=? AND call_key=?').get(runId, callKey)
        if (old) {
          if (old.input_hash !== digest(input)) throw courseFailure('TOOL_RECEIPT_CONFLICT', '工具回执冲突。', 409)
          return decode(old)
        }
        db.prepare('INSERT INTO course_receipts VALUES (?,?,?,?)').run(runId, callKey, digest(input), json(result))
        return result
      })
    },
    recordEvidence(runId, record, readerId) {
      return tx(() => {
        const run = active(runId)
        if (!record.text?.trim() || !record.url || record.topicId !== run.topicId || (record.predictionId && record.predictionId !== run.predictionId)) throw courseFailure('EVIDENCE_SCOPE', '原文不属于本轮题目。', 409)
        const old = decode(db.prepare('SELECT record_json FROM course_evidence WHERE run_id=? AND evidence_id=?').get(runId, record.evidenceId))
        if (old && old.contentHash !== record.contentHash) throw courseFailure('EVIDENCE_CONFLICT', '同一材料编号对应不同原文。', 409)
        if (!old) db.prepare('INSERT INTO course_evidence VALUES (?,?,?)').run(runId, record.evidenceId, json({ ...record, runId, obtainedAt: clock() }))
        db.prepare('INSERT OR IGNORE INTO course_reads VALUES (?,?,?)').run(runId, record.evidenceId, readerId)
        db.prepare('INSERT OR IGNORE INTO course_read_observations VALUES (?,?,?,?)').run(runId, record.evidenceId, readerId, clock())
        return old || record
      })
    },
    bindPrediction(runId, predictionId, predictionVersion) {
      return tx(() => {
        const run = active(runId)
        writeRun({ ...run, predictionId, predictionVersion })
        for (const item of evidenceFor(runId)) {
          const { readBy, readObservations, ...record } = item
          db.prepare('UPDATE course_evidence SET record_json=? WHERE run_id=? AND evidence_id=?').run(json({ ...record, predictionId, predictionVersion }), runId, item.evidenceId)
        }
        for (const relation of db.prepare('SELECT record_json FROM course_relations WHERE run_id=?').all(runId).map(decode)) {
          db.prepare('UPDATE course_relations SET record_json=? WHERE id=?').run(json({ ...relation, predictionId, predictionVersion }), relation.relationId)
        }
      })
    },
    evidenceFor,
    addRelations(runId, assignmentId, report) {
      return tx(() => {
        const run = active(runId)
        const read = new Set(evidenceFor(runId).filter((item) => item.readBy.includes(assignmentId)).map((item) => item.evidenceId))
        for (const [relation, claims] of [['supports', report.support || []], ['contradicts', report.counterevidence || []]]) {
          for (const claim of claims) for (const evidenceId of claim.evidenceIds) {
            if (!read.has(evidenceId)) throw courseFailure('UNREAD_CITATION', '关系必须来自该研究员实际读过的原文。', 409)
            const relationId = `relation_${digest([runId, assignmentId, relation, claim.claim, evidenceId]).slice(0, 32)}`
            const value = { relationId, runId, predictionId: run.predictionId, predictionVersion: run.predictionVersion,
              assignmentId, relation, claimId: `claim_${digest(claim.claim).slice(0, 24)}`, claim: claim.claim, evidenceId, createdAt: clock() }
            db.prepare('INSERT OR IGNORE INTO course_relations VALUES (?,?,?)').run(relationId, runId, json(value))
          }
        }
      })
    },
    listRelations: ({ requestId } = {}) => (requestId
      ? db.prepare('SELECT e.record_json FROM course_relations e JOIN course_runs r ON r.id=e.run_id WHERE r.request_id=? ORDER BY e.rowid').all(requestId)
      : db.prepare('SELECT record_json FROM course_relations ORDER BY rowid').all()).map(decode),
    listResearchReports: ({ requestId } = {}) => (requestId
      ? db.prepare('SELECT f.record_json FROM course_research_reports f JOIN course_runs r ON r.id=f.run_id WHERE r.request_id=? ORDER BY f.rowid').all(requestId)
      : db.prepare('SELECT record_json FROM course_research_reports ORDER BY rowid').all()).map(decode),
    publishResearch(runId, candidate, { assemble = false } = {}) {
      return tx(() => {
        const recovery = assemble ? requireRun(runId) : null
        if (assemble) {
          const request = requireRequest(recovery.requestId)
          if (request.purpose !== 'research' || request.status === 'stopped' || recovery.status !== 'failed' || recovery.phase !== 'review' || !['MODEL_INCOMPLETE', 'COURSE_BUDGET'].includes(recovery.error?.code) || !recovery.state.summaryResumeCount && recovery.error?.code !== 'MODEL_INCOMPLETE' || recovery.usage.unknownUsage) throw courseFailure('RESEARCH_ASSEMBLY_UNAVAILABLE', '仅汇总截断的研究任务可整理已有报告。', 409)
          const workers = db.prepare('SELECT record_json FROM course_assignments WHERE run_id=?').all(runId).map(decode)
          if (new Set(workers.filter((item) => item.status === 'completed' && item.report?.status === 'complete' && item.report.evidenceIds?.length).map((item) => item.roleId)).size < 2) throw courseFailure('REPORTS_INSUFFICIENT', '至少需要两个不同职责的完整报告。', 409)
          candidate = assembleResearchCandidate(workers, evidenceFor(runId))
          if (new Set(candidate.decisionNotes.map((note) => workers.find((item) => item.assignmentId === note.assignmentId)?.roleId)).size < 2) throw courseFailure('REPORTS_INSUFFICIENT', '有效已读报告不足。', 409)
        }
        const hash = digest(candidate)
        const old = db.prepare('SELECT * FROM course_research_reports WHERE run_id=?').get(runId)
        if (old) { if (old.input_hash !== hash) throw courseFailure('RESEARCH_CONFLICT', '本轮研报已封存。', 409); return decode(old) }
        const run = recovery || active(runId), request = requireRequest(run.requestId), at = clock()
        if (request.purpose !== 'research') throw courseFailure('RESEARCH_PURPOSE', '此任务不是研报任务。', 409)
        if (totalTokenLimitExceeded(run.budget, run.usage.totalTokens)) throw courseFailure('COURSE_BUDGET', '超出预算不能封存研报。', 409)
        const available = evidenceFor(runId).filter((item) => item.text?.trim() && item.readBy.some((reader) => reader !== 'main') && Date.parse(item.obtainedAt) <= Date.parse(at) && (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(at)))
        const ids = new Set(available.map((item) => item.evidenceId))
        if (!candidate.summary?.trim() || !candidate.findings?.length || candidate.findings.some((finding) => !finding.claim?.trim() || !finding.evidenceIds?.length || finding.evidenceIds.some((id) => !ids.has(id)))) throw courseFailure('RESEARCH_EVIDENCE', '研报须引用本轮研究员实际读取且时间有效的原文。', 409)
        let groundedFindings = candidate.findings
        if (request.groundingPolicy && !assemble) try { groundedFindings = validateGroundedClaims(candidate.findings, available, { asOf: at }) } catch (error) { throw courseFailure('CLAIM_GROUNDING', error.message, 409) }
        const workers = db.prepare('SELECT record_json FROM course_assignments WHERE run_id=?').all(runId).map(decode)
        if (new Set(workers.filter((item) => item.report && item.report.status !== 'blocked').map((item) => item.roleId)).size < 2) throw courseFailure('REPORTS_INSUFFICIENT', '研报至少需要两个不同职责的实际报告。', 409)
        let decisionNotes
        try { decisionNotes = validateDecisionNotes(candidate.decisionNotes, workers, [...ids]) } catch (error) { throw courseFailure('DECISION_EVIDENCE', error.message, 409) }
        const value = { reportId: id('course_research'), requestId: run.requestId, runId, topicId: run.topicId, summary: candidate.summary,
          findings: groundedFindings, limitations: candidate.limitations || [], decisionNotes, evidenceIds: [...new Set(candidate.findings.flatMap((item) => item.evidenceIds))],
          publishedAt: at, knowledgeCutoff: at, modelMode: run.modelMode, sourceMode: run.sourceMode, modelRef: run.modelRef, kind: 'research_report', scoringEligible: false,
          assemblyMode: assemble ? 'harness' : 'supervisor', groundingPolicy: request.groundingPolicy || null, ...(assemble ? { quality: 'limited', summaryFailure: run.error } : {}) }
        db.prepare('INSERT INTO course_research_reports VALUES (?,?,?,?)').run(value.reportId, runId, hash, json(value))
        append(run, { eventId: `${runId}_research_report`, type: 'research.published', payload: value })
        if (assemble) {
          writeRun({ ...run, status: 'completed', error: null, message: value.summary, updatedAt: at })
          writeRequest({ ...request, status: 'completed', activeRunId: null, error: null, message: value.summary, updatedAt: at })
          append(run, { type: 'research.assembled', payload: { assemblyMode: 'harness', summaryFailure: run.error, summary: value.summary } })
          append(run, { type: 'run.finished', payload: { status: 'completed', assemblyMode: 'harness', summary: value.summary } })
        }
        return value
      })
    },
    publishForecast(runId, candidate, currentPrediction, { recoverRecordedCandidate = false } = {}) {
      return tx(() => {
        const hash = digest(candidate)
        const old = db.prepare('SELECT * FROM course_forecasts WHERE run_id=?').get(runId)
        if (old) {
          if (old.input_hash !== hash) throw courseFailure('FORECAST_CONFLICT', '本轮已经封存另一份预测。', 409)
          return decode(old)
        }
        const run = recoverRecordedCandidate ? requireRun(runId) : active(runId)
        const request = requireRequest(run.requestId)
        if (recoverRecordedCandidate) {
          const proposal = run.state.main?.messages?.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []).findLast(call => call.function?.name === 'propose_forecast')
          let original; try { original = JSON.parse(proposal?.function.arguments) } catch {}
          if (request.resolutionPolicy?.version !== WARNING_POLICY || request.status === 'stopped' || run.status !== 'failed' || run.phase !== 'review' || run.error?.code !== 'MAIN_BUDGET' || run.usage.unknownUsage || !original || digest(original) !== digest(candidate)) throw courseFailure('CANDIDATE_RECOVERY_UNAVAILABLE', '只能重验已记录且未封存的原始模型候选，不能人工改写概率或绕过失败。', 409)
        }
        if (request.purpose === 'research') throw courseFailure('RESEARCH_PURPOSE', '研报任务不能发布预测概率。', 409)
        const at = clock()
        if (totalTokenLimitExceeded(run.budget, run.usage.totalTokens)) throw courseFailure('COURSE_BUDGET', '超出本轮预算后不能发布预测。', 409)
        if (isBoundedForecast(run) && run.usage.unknownUsage) throw courseFailure('COURSE_USAGE_UNKNOWN', '部分模型请求用量未知，不能将本轮封存为完整预测。', 409)
        if (currentPrediction?.predictionId !== run.predictionId || currentPrediction.version !== run.predictionVersion || currentPrediction.type !== 'binary') throw courseFailure('FORECAST_VERSION', '题目版本已经改变，不能发布旧契约判断。', 409)
        if (currentPrediction.status !== 'ready' || !currentPrediction.validation?.ready || !(Date.parse(currentPrediction.forecastClosesAt) > Date.parse(at))) throw courseFailure('FORECAST_CLOSED', '题目未就绪或已过停止发布时间。', 409)
        if (db.prepare('SELECT 1 FROM course_results WHERE request_id=?').get(run.requestId)) throw courseFailure('RESULT_KNOWN', '已登记结果，停止发布预测。', 409)
        if (!Number.isFinite(candidate.probabilityYes) || candidate.probabilityYes < 0 || candidate.probabilityYes > 1 || !candidate.summary?.trim()) throw courseFailure('INVALID_FORECAST', '二元概率或解释无效。')
        if (!Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) throw courseFailure('FORECAST_EVIDENCE', '预测须引用本轮实际读取的原文。')
        const available = evidenceFor(runId)
        const cited = candidate.evidenceIds.map((evidenceId) => available.find((item) => item.evidenceId === evidenceId))
        if (cited.some((item) => !item || !item.text?.trim() || !item.readBy.length || item.predictionId !== run.predictionId || Date.parse(item.obtainedAt) > Date.parse(at) || (item.publishedAt && Date.parse(item.publishedAt) > Date.parse(at)))) throw courseFailure('FORECAST_EVIDENCE', '引用不属于当前题目或未实际取得原文。', 409)
        if (!available.some((item) => item.url === currentPrediction.resolutionSource.url && item.readBy.length)) throw courseFailure('RESOLUTION_SOURCE_UNREAD', '指定结果来源尚未实际读取。', 409)
        let groundedReasoning = candidate.reasoningClaims || []
        if (request.groundingPolicy) try { groundedReasoning = validateGroundedClaims(candidate.reasoningClaims, cited, { asOf: at }) } catch (error) { throw courseFailure('CLAIM_GROUNDING', error.message, 409) }
        const workers = db.prepare('SELECT record_json FROM course_assignments WHERE run_id=? ORDER BY rowid').all(runId).map(decode)
        const exploratory = isExploratoryForecast(run, request)
        const reportAdequacy = exploratory ? selectExploratoryReports(workers, available, { asOf: at, runId, unknownUsage: run.usage.unknownUsage }) : null
        const decisionWorkers = exploratory ? workers.map(worker => {
          const usable = reportAdequacy.usable.find(item => item.assignmentId === worker.assignmentId)
          return usable ? { ...worker, report: usable.report } : worker
        }) : workers
        let decisionNotes
        try { decisionNotes = validateDecisionNotes(candidate.decisionNotes, decisionWorkers, available.filter((item) => item.text?.trim() && item.readBy.length && item.predictionId === run.predictionId && Date.parse(item.obtainedAt) <= Date.parse(at) && (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(at))).map((item) => item.evidenceId),
          exploratory ? { partialAssignmentIds: reportAdequacy.usable.filter(item => item.quality === 'partial').map(item => item.assignmentId) } : {}) }
        catch (error) { throw courseFailure('DECISION_EVIDENCE', error.message, 409) }
        const boundedReports = isBoundedForecast(run) ? effectiveRoleReports(workers) : null
        const reportCount = boundedReports ? boundedReports.length
          : workers.filter((worker) => !worker.followUp && worker.status === 'completed' && worker.report?.status === 'complete').length
        const acceptedReports = exploratory ? reportAdequacy.usable.filter(item => decisionNotes.some(note => note.assignmentId === item.assignmentId && ['adopted', 'qualified'].includes(note.disposition) && note.evidenceIds.some(id => item.evidenceIds.includes(id)))) : []
        if ((!exploratory && reportCount < 2 || exploratory && !acceptedReports.length) || !cited.some((item) => item.readBy.some((reader) => reader !== 'main'))) throw courseFailure('REPORTS_INSUFFICIENT', exploratory ? '尚无被主Agent采用的、本人已读且有实质引用与模型概率的报告；来源限制本身不能充作事件证据。' : '独立调查或已读证据不足。', 409)
        if (!exploratory && boundedReports && boundedReports.filter(worker => Number.isFinite(worker.report.probability) && worker.report.probability >= 0 && worker.report.probability <= 1).length < 2) throw courseFailure('REPORT_SCORES_INSUFFICIENT', '至少两种不同职责须提交有依据的0至1概率估计；主Agent不能用自己的概率替代缺失的研究员评分。', 409)
        if (exploratory && !groundedReasoning.some(claim => acceptedReports.some(report => report.substantiveClaims.some(original => digest(original) === digest(claim))))) throw courseFailure('CLAIM_GROUNDING', '初步估计也须沿用至少一条已采用研究员的实质原文依据，不能只引用资料缺失或免责声明。', 409)
        if (request.resolutionPolicy?.version === PRICE_POLICY) {
          const fresh = run.state.priceFinalSnapshot, latest = run.state.latestReference
          if (!fresh || latest?.evidenceId !== fresh.quoteEvidenceId || !available.some(source => source.evidenceId === fresh.quoteEvidenceId && source.readBy.includes('main')) || !Number.isFinite(Date.parse(latest.observedAt)) || Date.parse(latest.observedAt) > Date.parse(at) || Date.parse(at) - Date.parse(latest.observedAt) > 120000) throw courseFailure('PRICE_REVIEW_STALE', '汇总前最新行情缺失或已超过两分钟，须重新取得后再发布；初始基准不变。', 409)
          const team = workers.filter(worker => !worker.followUp)
          if (team.length !== 3 || !['market','statistics','verification'].every(role => team.some(worker => worker.roleId === role && worker.status === 'completed' && worker.report?.status === 'complete' && available.some(source => source.marketQuote?.pair === 'BTC-USDT' && source.readBy.includes(worker.assignmentId) && worker.report.evidenceIds.includes(source.evidenceId))))) throw courseFailure('PRICE_TEAM_INCOMPLETE', '固定价格验收需市场、统计、核验三席全部完成并各自引用本人已读现价，不能用两席替代。', 409)
          const statistician = team.find(worker => worker.roleId === 'statistics')
          if (!available.some(source => source.marketHistory?.pair === 'BTC-USDT' && source.readBy.includes(statistician.assignmentId) && statistician.report.evidenceIds.includes(source.evidenceId))) throw courseFailure('PRICE_HISTORY_REQUIRED', '统计席须引用本人实际读取的已关闭分钟桶，不能捏造历史样本。', 409)
          if (!decisionNotes || !team.every(worker => decisionNotes.some(note => note.assignmentId === worker.assignmentId))) throw courseFailure('DECISION_EVIDENCE', '价格验收须逐份交代三席报告的处理。', 409)
        }
        const value = { forecastId: id('course_forecast'), requestId: run.requestId, runId, predictionId: run.predictionId,
          predictionVersion: run.predictionVersion, probabilityYes: candidate.probabilityYes, probabilityNo: 1 - candidate.probabilityYes,
          summary: candidate.summary, decisionNotes, evidenceIds: candidate.evidenceIds, evidenceAdequacy: candidate.evidenceAdequacy || 'limited',
          dissent: candidate.dissent || [], issuedAt: at, publishedAt: at, knowledgeCutoff: at, targetAt: currentPrediction.targetAt,
          resolutionRuleVersion: currentPrediction.resolutionRuleVersion, modelMode: run.modelMode, modelRef: run.modelRef || null, sourceMode: run.sourceMode,
          kind: request.normalized?.conditionalOnly ? 'conditional_estimate' : 'forecast',
          defaultAssumptions: request.normalized?.defaultAssumptions || [], currentReference: run.state?.latestReference || request.normalized?.currentReference || null,
          sourceLimitations: Array.isArray(candidate.sourceLimitations) ? candidate.sourceLimitations : (request.normalized?.sourceLimitations || []).map((item) => `准备阶段记录（可能已补齐）：${item}`), researchBasis: request.normalized?.researchBasis || null,
          timeContext: run.state?.timeContext || request.normalized?.timeContext || null,
          baseline: request.normalized?.baseline || request.normalized?.currentReference || null,
          scoringEligible: currentPrediction.scoringEligible !== false && !request.normalized?.baseline?.synthetic && !request.normalized?.conditionalOnly && run.modelMode === 'live' && run.sourceMode === 'live' && cited.every((item) => item.sourceMode === 'live' && !item.fixture),
          label: run.modelMode === 'mock' || run.sourceMode !== 'live' ? '协议模拟或回放资料结果，不是真实预测' : '模型事件概率估计' }
        value.reasoningClaims = groundedReasoning; value.groundingPolicy = request.groundingPolicy || null
        for (const key of ['publicationMode', 'scorecard', 'aggregationMethod']) if (candidate[key] !== undefined && candidate[key] !== null) value[key] = candidate[key]
        if (value.publicationMode === 'bounded-report-aggregation') value.label = '程序汇集的研究员概率估计（主Agent未完成最终裁决）'
        if (recoverRecordedCandidate) value.publicationMode = 'revalidated-recorded-model-candidate'
        if (request.groundingPolicy || exploratory) {
          const verified = exploratory ? acceptedReports.some(item => item.roleId === 'verification' && item.quality === 'complete')
            : workers.some(worker => worker.roleId === 'verification' && worker.status === 'completed' && worker.report?.status === 'complete')
          value.reviewRequired = !verified || recoverRecordedCandidate
          value.reviewReasons = [!verified ? exploratory ? '核验席未提交并被实际采纳的完整实质原文核验报告；原始complete状态或来源提示不能替代有效核验。' : '核验席未完成有效报告，不能视为完整独立核验。' : null, recoverRecordedCandidate ? '原模型候选经过维护重验后封存，不能计为完整自动流程成功。' : null].filter(Boolean)
          if (exploratory && !verified) value.scoringEligible = false
        }
        if (value.publicationMode === 'bounded-report-aggregation') {
          value.scoringEligible = false
          value.reviewRequired = true
          value.reviewReasons = [...(value.reviewReasons || []), '主Agent未完成有效最终裁决；当前为程序汇集的研究员估计，须复核，不计为完整自动预测成功。']
        }
        if (exploratory) {
          const preliminary = acceptedReports.length < 2 || acceptedReports.some(item => item.quality !== 'complete')
          value.deliveryPolicy = run.budget.deliveryPolicy
          value.reportAdequacy = { eligibleRoleCount: reportAdequacy.roleCount, completeRoleCount: reportAdequacy.completeRoleCount,
            partialRoleCount: reportAdequacy.partialRoleCount, acceptedAssignmentIds: acceptedReports.map(item => item.assignmentId), preliminary }
          value.scorecard = reportAdequacy.usable.map(item => ({ assignmentId: item.assignmentId, roleId: item.roleId, probabilityYes: item.report.probability, quality: item.quality, reportOrigin: item.reportOrigin }))
          if (preliminary) {
            value.kind = 'conditional_estimate'; value.scoringEligible = false; value.reviewRequired = true
            if (value.publicationMode !== 'bounded-report-aggregation') value.publicationMode = 'model-provisional-estimate'
            value.label = '有公开依据的初步条件估计（资料有限，需复核）'
            value.evidenceAdequacy = 'limited'
            value.reviewReasons = [...(value.reviewReasons || []), '采用的研究报告数量或完整程度有限；保留模型估计，不能作为完整核验或可计分结果。']
          }
        }
        Object.assign(value, deriveForecastStatus(value))
        db.prepare('INSERT INTO course_forecasts VALUES (?,?,?,?)').run(value.forecastId, runId, hash, json(value))
        append(run, { eventId: `${runId}_forecast`, type: 'forecast.published', payload: value })
        writeRequest({ ...request, latestForecastId: value.forecastId, updatedAt: at })
        if (recoverRecordedCandidate) {
          const message = '引用中取得时间的元数据校验修复后，原模型候选重新通过发布守卫；没有追加模型请求。'
          writeRun({ ...run, status: 'completed', phase: 'finished', error: null, message, updatedAt: at })
          writeRequest({ ...request, status: 'completed', activeRunId: null, latestForecastId: value.forecastId, error: null, message, updatedAt: at })
          append(run, { type: 'forecast.revalidated', payload: { forecastId: value.forecastId, originalFailure: run.error, summary: message } })
          append(run, { type: 'run.finished', payload: { status: 'completed', summary: message } })
        }
        return value
      })
    },
    listForecasts: ({ requestId } = {}) => (requestId
      ? db.prepare('SELECT f.record_json FROM course_forecasts f JOIN course_runs r ON r.id=f.run_id WHERE r.request_id=? ORDER BY f.rowid').all(requestId)
      : db.prepare('SELECT record_json FROM course_forecasts ORDER BY rowid').all()).map(decode),
    buildMemory(requestId, { excludeRunId, predictionVersion, asOf = clock() } = {}) {
      const request = requireRequest(requestId)
      const runs = db.prepare('SELECT record_json FROM course_runs WHERE request_id=? ORDER BY rowid DESC').all(requestId).map(decode)
      const assignments = runs.flatMap((run) => db.prepare('SELECT record_json FROM course_assignments WHERE run_id=? ORDER BY rowid').all(run.runId).map(decode))
      const forecasts = db.prepare('SELECT f.record_json FROM course_forecasts f JOIN course_runs r ON r.id=f.run_id WHERE r.request_id=? ORDER BY f.rowid DESC').all(requestId).map(decode)
      const relations = db.prepare('SELECT e.record_json FROM course_relations e JOIN course_runs r ON r.id=e.run_id WHERE r.request_id=? ORDER BY e.rowid DESC').all(requestId).map(decode)
      return buildMemorySnapshot({ requestId, predictionVersion: predictionVersion ?? request.predictionVersion ?? null, excludeRunId, asOf,
        runs, assignments, forecasts, relations, evidence: runs.flatMap((run) => evidenceFor(run.runId)) })
    },
    getWatch: (requestId) => decode(db.prepare('SELECT record_json FROM course_watches WHERE request_id=?').get(requestId)),
    listWatches: () => db.prepare('SELECT record_json FROM course_watches ORDER BY rowid').all().map(decode),
    saveWatch(requestId, patch) {
      return tx(() => {
        const request = requireRequest(requestId)
        const previous = decode(db.prepare('SELECT record_json FROM course_watches WHERE request_id=?').get(requestId)) || { requestId, watchId: id('course_watch'), known: {}, checks: 0 }
        const value = { ...previous, ...patch, requestId, updatedAt: clock() }
        if (request.status === 'stopped') value.status = 'stopped'
        db.prepare('INSERT INTO course_watches VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET record_json=excluded.record_json').run(requestId, json(value))
        return value
      })
    },
    recordResult(requestId, result) {
      return tx(() => {
        const request = requireRequest(requestId)
        if (request.resolutionPolicy) throw courseFailure('STRUCTURED_RESULT_REQUIRED', '此固定契约只能通过结果核验入口读取来源，不能直接提交结果标签。', 409)
        if (requiresWeatherObservation(request)) throw courseFailure('WEATHER_OBSERVATION_REQUIRED', '预设天气题需要人工或后续结构化实况验证；当前通用网页不能登记降雨YES或NO结果。', 409)
        if (request.normalized?.conditionalOnly) throw courseFailure('CONDITIONAL_RESULT', '条件性估计缺少固定可核验基准，不能冒充已结算结果。', 409)
        if (request.normalized?.temporalPolicy === 'at_target' && Date.parse(clock()) < Date.parse(request.normalized.targetAt)) throw courseFailure('RESULT_NOT_AVAILABLE', '这是目标时点状态题；目标尚未到达，当前状态不能登记为未来结果。', 409)
        const available = new Set(db.prepare('SELECT e.record_json FROM course_evidence e JOIN course_runs r ON r.id=e.run_id WHERE r.request_id=?').all(requestId).map(decode).map((item) => item.evidenceId))
        if (![0, 1].includes(result.outcome) || !result.evidenceIds?.length || result.evidenceIds.some((item) => !available.has(item))) throw courseFailure('RESULT_EVIDENCE', '登记结果需要合法标签与本题原文。')
        const value = { ...result, requestId, predictionId: request.predictionId, knownAt: clock(), status: 'known' }
        const old = decode(db.prepare('SELECT record_json FROM course_results WHERE request_id=?').get(requestId))
        if (old) return old
        db.prepare('INSERT INTO course_results VALUES (?,?)').run(requestId, json(value))
        return value
      })
    },
    getResult: (requestId) => decode(db.prepare('SELECT record_json FROM course_results WHERE request_id=?').get(requestId)),
    recordPriceResult(requestId, source) {
      return tx(() => {
        const request = requireRequest(requestId), at = clock(), policy = request.resolutionPolicy
        const old = decode(db.prepare('SELECT record_json FROM course_results WHERE request_id=?').get(requestId))
        if (old) return old
        const contract = request.normalized, target = Date.parse(contract?.targetAt), observed = Date.parse(source.obtainedAt), base = contract?.baseline
        if (request.status === 'stopped' || request.activeRunId || policy?.version !== PRICE_POLICY || contract?.resolutionSource?.url !== PRICE_URL || contract.resolutionRule !== PRICE_RULE || contract.targetAt !== policy.targetAt || contract.temporalPolicy !== 'at_target') throw courseFailure('RESOLUTION_UNAVAILABLE', '此任务没有有效固定价格契约，或仍在调查/已经停止。', 409)
        if (!Number.isFinite(target) || Date.parse(at) < target) throw courseFailure('RESULT_NOT_AVAILABLE', '目标尚未到达，当前价格不能作为未来结果。', 409)
        if (!Number.isFinite(observed) || observed < target || observed > target + 300000 || Date.parse(at) > target + 300000 || observed > Date.parse(at) || Date.parse(at)-observed > 15000) throw courseFailure('RESOLUTION_WINDOW', '未在目标后5分钟观察窗口取得新报价，保持不可核验。', 409)
        if (source.sourceMode !== (request.modelMode === 'mock' ? 'replay' : 'live') || request.modelMode === 'live' && (source.fixture || base?.synthetic) || contract.conditionalOnly || base?.pair !== 'BTC-USDT' || !base.verified || !Number.isFinite(base.value) || base.value <= 0 || !Number.isFinite(Date.parse(base.observedAt)) || Date.parse(base.observedAt) < Date.parse(request.createdAt) || Date.parse(base.observedAt) >= target) throw courseFailure('RESULT_PROVENANCE', '报价、固定基准或来源模式不符，不能结算。', 409)
        let value; try { value = parsePriceSnapshot(source, { allowFixture: request.modelMode === 'mock' }) } catch { throw courseFailure('RESULT_EVIDENCE', '报价原文与结构化价格不符或无效，不能把来源失败判No。', 409) }
        const forecasts = db.prepare('SELECT f.record_json FROM course_forecasts f JOIN course_runs r ON r.id=f.run_id WHERE r.request_id=? ORDER BY f.rowid').all(requestId).map(decode)
          .filter(f => f.predictionVersion === request.predictionVersion && Date.parse(f.targetAt) === target && Date.parse(f.publishedAt) < target)
        if (!forecasts.length) throw courseFailure('FORECAST_REQUIRED', '没有目标前发布的预测，不能计算预测评分。', 409)
        if (forecasts.some(f => digest(f.baseline) !== digest(base))) throw courseFailure('PRICE_BASELINE_CONFLICT', '结果基准与封存预测不一致，不能重选基准。', 409)
        const outcome = value > base.value ? 1 : 0, evidenceId = id('resolution_evidence')
        const result = { requestId, predictionId: request.predictionId, predictionVersion: request.predictionVersion, outcome, knownAt: at, observedAt: source.obtainedAt,
          status: 'known', resolutionPolicy: PRICE_POLICY, rule: PRICE_RULE, baseline: base, observedValue: value, change: value-base.value, changePct:(value/base.value-1)*100,
          evidenceIds:[evidenceId], evidence:[{...source,evidenceId,purpose:'resolution'}],
          summary:`有界首次观察：BTC-USDT ${value} USDT，固定基准${base.value} USDT，${outcome ? '严格高于（Yes）' : '等于或低于（No）'}。`,
          scoringEligible: request.modelMode === 'live' && source.sourceMode === 'live' && forecasts.some(f=>f.scoringEligible),
          scores:forecasts.map(f=>({forecastId:f.forecastId,probabilityYes:f.probabilityYes,brier:(f.probabilityYes-outcome)**2,
            scoringEligible:Boolean(f.scoringEligible && source.sourceMode === 'live' && !source.fixture),label:f.scoringEligible && !source.fixture ? '单题Brier，不代表总体准确率' : '模拟协议分数，不计真实成绩'})) }
        db.prepare('INSERT INTO course_results VALUES (?,?)').run(requestId,json(result))
        writeRequest({...request,status:'closed',activeRunId:null,updatedAt:at})
        const watch=decode(db.prepare('SELECT record_json FROM course_watches WHERE request_id=?').get(requestId))
        if(watch)db.prepare('UPDATE course_watches SET record_json=? WHERE request_id=?').run(json({...watch,status:'closed',nextDueAt:null}),requestId)
        append(requireRun(forecasts.at(-1).runId),{eventId:`${requestId}_resolution`,type:'resolution.recorded',payload:{outcome,evidenceIds:[evidenceId],summary:result.summary,scores:result.scores}})
        return result
      })
    },
    recordWarningResult(requestId, source) {
      return tx(() => {
        const request = requireRequest(requestId), at = clock()
        const old = decode(db.prepare('SELECT record_json FROM course_results WHERE request_id=?').get(requestId))
        if (old) return old
        const policy = request.resolutionPolicy, target = Date.parse(request.normalized?.targetAt), observed = Date.parse(source.obtainedAt)
        if (request.status === 'stopped' || request.activeRunId || policy?.version !== WARNING_POLICY || request.normalized?.resolutionSource?.url !== WARNING_URL || request.normalized?.resolutionRule !== WARNING_RULE || request.normalized?.targetAt !== policy.targetAt) throw courseFailure('RESOLUTION_UNAVAILABLE', '此任务没有可核验的固定警告契约，或仍在调查/已经停止。', 409)
        if (!Number.isFinite(target) || Date.parse(at) < target) throw courseFailure('RESULT_NOT_AVAILABLE', '目标时点尚未到达，当前状态不能当作未来结果。', 409)
        if (!Number.isFinite(observed) || observed < target || observed > target + 300000 || Date.parse(at) > target + 300000 || Math.abs(Date.parse(at) - observed) > 15000) throw courseFailure('RESOLUTION_WINDOW', '未在目标后的5分钟观察窗口取得新快照，保持不可核验。', 409)
        if (source.url !== WARNING_URL || source.sourceMode !== (request.modelMode === 'mock' ? 'replay' : 'live') || request.modelMode === 'live' && source.fixture || request.normalized.conditionalOnly) throw courseFailure('RESULT_PROVENANCE', '结果来源模式、地址或预测资格不符。', 409)
        let parsed; try { parsed = parseWarnings(JSON.parse(source.rawJson || source.text), source.obtainedAt) } catch { throw courseFailure('RESULT_EVIDENCE', '警告快照不是有效完整JSON，不能把读取失败判为No。', 409) }
        const forecasts = db.prepare('SELECT f.record_json FROM course_forecasts f JOIN course_runs r ON r.id=f.run_id WHERE r.request_id=? ORDER BY f.rowid').all(requestId).map(decode)
          .filter((item) => item.predictionVersion === request.predictionVersion && Date.parse(item.targetAt) === target && Date.parse(item.publishedAt) < target)
        if (!forecasts.length) throw courseFailure('FORECAST_REQUIRED', '本题没有目标前发布的预测，不能登记预测评分。', 409)
        const outcome = parsed.redFireActive ? 1 : 0, evidenceId = id('resolution_evidence')
        const value = { requestId, predictionId: request.predictionId, predictionVersion: request.predictionVersion, outcome, knownAt: at, observedAt: source.obtainedAt,
          status: 'known', resolutionPolicy: WARNING_POLICY, rule: WARNING_RULE, evidenceIds: [evidenceId],
          evidence: [{ ...source, evidenceId, purpose: 'resolution', completeSnapshot: true }],
          summary: `有界首次观察：红色火灾危险警告${outcome ? '有效（Yes）' : '不在有效警告快照中（No）'}。`,
          scoringEligible: request.modelMode === 'live' && source.sourceMode === 'live' && forecasts.some(f => f.scoringEligible),
          scores: forecasts.map((f) => ({ forecastId: f.forecastId, probabilityYes: f.probabilityYes, brier: (f.probabilityYes - outcome) ** 2,
            scoringEligible: Boolean(f.scoringEligible && source.sourceMode === 'live' && !source.fixture), label: f.scoringEligible && !source.fixture ? '单题Brier，不代表总体准确率' : '模拟协议分数，不计真实成绩' })) }
        db.prepare('INSERT INTO course_results VALUES (?,?)').run(requestId, json(value))
        writeRequest({ ...request, status: 'closed', activeRunId: null, updatedAt: at })
        const watch = decode(db.prepare('SELECT record_json FROM course_watches WHERE request_id=?').get(requestId))
        if (watch) db.prepare('UPDATE course_watches SET record_json=? WHERE request_id=?').run(json({ ...watch, status: 'closed', nextDueAt: null }), requestId)
        const run = requireRun(forecasts.at(-1).runId)
        append(run, { eventId: `${requestId}_resolution`, type: 'resolution.recorded', payload: { outcome, evidenceIds: [evidenceId], summary: value.summary, scores: value.scores } })
        return value
      })
    },
    stop(requestId) {
      return tx(() => {
        const request = requireRequest(requestId)
        writeRequest({ ...request, status: 'stopped', activeRunId: null, updatedAt: clock() })
        for (const run of db.prepare('SELECT record_json FROM course_runs WHERE request_id=?').all(requestId).map(decode)) {
          if (!terminal.has(run.status)) {
            writeRun({ ...run, status: 'cancelled', updatedAt: clock() }); append(run, { type: 'run.finished', payload: { status: 'cancelled', summary: '用户已停止跟踪。' } })
            for (const assignment of db.prepare('SELECT record_json FROM course_assignments WHERE run_id=?').all(run.runId).map(decode)) {
              if (!['completed', 'failed'].includes(assignment.status)) db.prepare('UPDATE course_assignments SET record_json=? WHERE id=?').run(json({ ...assignment, status: 'cancelled', updatedAt: clock() }), assignment.assignmentId)
            }
          }
        }
        const watch = decode(db.prepare('SELECT record_json FROM course_watches WHERE request_id=?').get(requestId))
        if (watch) db.prepare('UPDATE course_watches SET record_json=? WHERE request_id=?').run(json({ ...watch, status: 'stopped', nextDueAt: null }), requestId)
        return requireRequest(requestId)
      })
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}
