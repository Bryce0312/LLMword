import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { digest, domainFailure, identifier, json, validDate } from '../domain/contracts.mjs'
import { requiresWeatherObservation } from './course-context.mjs'
import { buildMemorySnapshot } from './memory-policy.mjs'

export const courseFailure = (code, message, status = 400) => Object.assign(domainFailure(code, message, status), { courseSafe: true })
const terminal = new Set(['completed', 'insufficient', 'failed', 'cancelled'])
const decode = (row) => row ? JSON.parse(row.record_json) : null
const id = (kind) => `${kind}_${randomUUID()}`
const tokenLimit = (run) => run.budget?.maxTotalTokens || 120000

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
        CREATE TABLE IF NOT EXISTS course_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_requests (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_assignments (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_receipts (run_id TEXT NOT NULL REFERENCES course_runs(id), call_key TEXT NOT NULL, input_hash TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(run_id,call_key)) STRICT;
        CREATE TABLE IF NOT EXISTS course_evidence (run_id TEXT NOT NULL REFERENCES course_runs(id), evidence_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(run_id,evidence_id)) STRICT;
        CREATE TABLE IF NOT EXISTS course_reads (run_id TEXT NOT NULL, evidence_id TEXT NOT NULL, reader_id TEXT NOT NULL, PRIMARY KEY(run_id,evidence_id,reader_id), FOREIGN KEY(run_id,evidence_id) REFERENCES course_evidence(run_id,evidence_id)) STRICT;
        CREATE TABLE IF NOT EXISTS course_relations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES course_runs(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_forecasts (id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES course_runs(id), input_hash TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_watches (request_id TEXT PRIMARY KEY REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_results (request_id TEXT PRIMARY KEY REFERENCES course_requests(id), record_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS course_operations (operation_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
      `)
      const version = db.prepare("SELECT value FROM course_metadata WHERE key='schemaVersion'").get()
      if (version && version.value !== '1') throw courseFailure('COURSE_SCHEMA', '课程数据库版本不受支持。', 500)
      db.prepare('INSERT OR IGNORE INTO course_metadata VALUES (?,?)').run('schemaVersion', '1')
      db.prepare('INSERT OR IGNORE INTO course_metadata VALUES (?,?)').run('epoch', randomUUID())
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
    const previous = db.prepare('SELECT record_json FROM course_runs WHERE request_id=? ORDER BY rowid DESC').all(requestId).map(decode)
    const busy = previous.find((run) => !terminal.has(run.status))
    if (busy) return busy
    const at = clock()
    const harnessVersion = configuration.harnessVersion || request.harnessVersion || 2
    const run = { runId: id('course_run'), requestId, status: 'queued', phase: request.normalized ? 'watch_check' : harnessVersion >= 3 ? 'intake' : 'prepare',
      trigger, topicId: request.topicId || null, predictionId: request.predictionId || null,
      predictionVersion: request.predictionVersion || null, modelMode: configuration.modelMode || request.modelMode, sourceMode: configuration.sourceMode || request.sourceMode,
      providerIdentity: configuration.providerIdentity || request.providerIdentity, modelRef: configuration.modelRef || request.modelRef || null, createdAt: at, updatedAt: at, state: {},
      harnessVersion, budget: configuration.budget || request.budget || null,
      usage: { modelRequests: 0, toolCalls: 0, totalTokens: 0, unknownUsage: false }, error: null }
    db.prepare('INSERT INTO course_runs VALUES (?,?,?)').run(run.runId, requestId, json(run))
    writeRequest({ ...request, activeRunId: run.runId, latestRunId: run.runId, status: 'queued', updatedAt: at })
    append(run, { type: 'run.queued', payload: { summary: trigger === 'watch' ? '后台任务唤醒本题检查。' : '已收到问题，主 Agent 开始调查。' } })
    return run
  }
  function evidenceFor(runId) {
    return db.prepare('SELECT record_json FROM course_evidence WHERE run_id=? ORDER BY evidence_id').all(runId).map(decode)
      .map((record) => ({ ...record, readBy: db.prepare('SELECT reader_id FROM course_reads WHERE run_id=? AND evidence_id=?').all(runId, record.evidenceId).map((row) => row.reader_id) }))
  }
  return {
    metadata: { schemaVersion: 1, serverEpoch: epoch }, clock, getRequest, requireRequest, getRun, requireRun,
    listRequests: () => db.prepare('SELECT record_json FROM course_requests ORDER BY rowid DESC').all().map(decode),
    listRuns: ({ requestId } = {}) => (requestId
      ? db.prepare('SELECT record_json FROM course_runs WHERE request_id=? ORDER BY rowid').all(requestId)
      : db.prepare('SELECT record_json FROM course_runs ORDER BY rowid').all()).map(decode),
    createRequest(input, { idempotencyKey } = {}) {
      return tx(() => {
        const hash = digest(input)
        if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120)) throw courseFailure('INVALID_IDEMPOTENCY_KEY', '幂等键格式无效。')
        const old = idempotencyKey && db.prepare('SELECT * FROM course_operations WHERE operation_key=?').get(idempotencyKey)
        if (old) {
          if (old.input_hash !== hash) throw courseFailure('IDEMPOTENCY_CONFLICT', '此幂等键已用于另一个问题。', 409)
          return requireRequest(decode(old).requestId)
        }
        const at = clock()
        const request = { ...input, requestId: id('course_request'), status: 'queued', createdAt: at, updatedAt: at, normalized: null }
        db.prepare('INSERT INTO course_requests VALUES (?,?)').run(request.requestId, json(request))
        const run = queue(request.requestId, 'manual')
        const result = { ...requireRequest(request.requestId), activeRunId: run.runId }
        if (idempotencyKey) db.prepare('INSERT INTO course_operations VALUES (?,?,?)').run(idempotencyKey, hash, json(result))
        return result
      })
    },
    queueRun: (requestId, trigger = 'manual', configuration = {}) => tx(() => queue(requestId, trigger, configuration)),
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
        if (kind === 'modelRequests' && run.usage.totalTokens >= tokenLimit(run)) throw courseFailure('COURSE_BUDGET', '本轮已达到总 token 预算。', 409)
        if ((run.usage[kind] || 0) >= limit) throw courseFailure('COURSE_BUDGET', '本轮调查已达到调用预算。', 409)
        run.usage[kind] = (run.usage[kind] || 0) + 1
        writeRun(run); return run.usage
      })
    },
    recordUsage(runId, totalTokens) {
      const usage = tx(() => {
        const run = active(runId)
        if (Number.isInteger(totalTokens) && totalTokens >= 0) run.usage.totalTokens += totalTokens
        else run.usage.unknownUsage = true
        writeRun(run)
        return run.usage
      })
      if (usage.totalTokens > tokenLimit(requireRun(runId))) throw courseFailure('COURSE_BUDGET', '本轮已达到总 token 预算。', 409)
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
        return old || record
      })
    },
    bindPrediction(runId, predictionId, predictionVersion) {
      return tx(() => {
        const run = active(runId)
        writeRun({ ...run, predictionId, predictionVersion })
        for (const item of evidenceFor(runId)) {
          const { readBy, ...record } = item
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
    publishForecast(runId, candidate, currentPrediction) {
      return tx(() => {
        const hash = digest(candidate)
        const old = db.prepare('SELECT * FROM course_forecasts WHERE run_id=?').get(runId)
        if (old) {
          if (old.input_hash !== hash) throw courseFailure('FORECAST_CONFLICT', '本轮已经封存另一份预测。', 409)
          return decode(old)
        }
        const run = active(runId)
        const request = requireRequest(run.requestId)
        const at = clock()
        if (run.usage.totalTokens > tokenLimit(run)) throw courseFailure('COURSE_BUDGET', '超出本轮预算后不能发布预测。', 409)
        if (currentPrediction?.predictionId !== run.predictionId || currentPrediction.version !== run.predictionVersion || currentPrediction.type !== 'binary') throw courseFailure('FORECAST_VERSION', '题目版本已经改变，不能发布旧契约判断。', 409)
        if (currentPrediction.status !== 'ready' || !currentPrediction.validation?.ready || !(Date.parse(currentPrediction.forecastClosesAt) > Date.parse(at))) throw courseFailure('FORECAST_CLOSED', '题目未就绪或已过停止发布时间。', 409)
        if (db.prepare('SELECT 1 FROM course_results WHERE request_id=?').get(run.requestId)) throw courseFailure('RESULT_KNOWN', '已登记结果，停止发布预测。', 409)
        if (!Number.isFinite(candidate.probabilityYes) || candidate.probabilityYes < 0 || candidate.probabilityYes > 1 || !candidate.summary?.trim()) throw courseFailure('INVALID_FORECAST', '二元概率或解释无效。')
        if (!Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) throw courseFailure('FORECAST_EVIDENCE', '预测须引用本轮实际读取的原文。')
        const available = evidenceFor(runId)
        const cited = candidate.evidenceIds.map((evidenceId) => available.find((item) => item.evidenceId === evidenceId))
        if (cited.some((item) => !item || !item.text?.trim() || !item.readBy.length || item.predictionId !== run.predictionId || Date.parse(item.obtainedAt) > Date.parse(at) || (item.publishedAt && Date.parse(item.publishedAt) > Date.parse(at)))) throw courseFailure('FORECAST_EVIDENCE', '引用不属于当前题目或未实际取得原文。', 409)
        if (!available.some((item) => item.url === currentPrediction.resolutionSource.url && item.readBy.length)) throw courseFailure('RESOLUTION_SOURCE_UNREAD', '指定结果来源尚未实际读取。', 409)
        const workers = db.prepare('SELECT record_json FROM course_assignments WHERE run_id=?').all(runId).map(decode)
        if (workers.filter((worker) => !worker.followUp && worker.status === 'completed' && worker.report?.status === 'complete').length < 2 || !cited.some((item) => item.readBy.some((reader) => reader !== 'main'))) throw courseFailure('REPORTS_INSUFFICIENT', '独立调查或已读证据不足。', 409)
        const value = { forecastId: id('course_forecast'), requestId: run.requestId, runId, predictionId: run.predictionId,
          predictionVersion: run.predictionVersion, probabilityYes: candidate.probabilityYes, probabilityNo: 1 - candidate.probabilityYes,
          summary: candidate.summary, evidenceIds: candidate.evidenceIds, evidenceAdequacy: candidate.evidenceAdequacy || 'limited',
          dissent: candidate.dissent || [], issuedAt: at, publishedAt: at, knowledgeCutoff: at, targetAt: currentPrediction.targetAt,
          resolutionRuleVersion: currentPrediction.resolutionRuleVersion, modelMode: run.modelMode, modelRef: run.modelRef || null, sourceMode: run.sourceMode,
          kind: request.normalized?.conditionalOnly ? 'conditional_estimate' : 'forecast',
          defaultAssumptions: request.normalized?.defaultAssumptions || [], currentReference: run.state?.latestReference || request.normalized?.currentReference || null,
          sourceLimitations: Array.isArray(candidate.sourceLimitations) ? candidate.sourceLimitations : (request.normalized?.sourceLimitations || []).map((item) => `准备阶段记录（可能已补齐）：${item}`), researchBasis: request.normalized?.researchBasis || null,
          timeContext: run.state?.timeContext || request.normalized?.timeContext || null,
          baseline: request.normalized?.baseline || request.normalized?.currentReference || null,
          scoringEligible: currentPrediction.scoringEligible !== false && !request.normalized?.baseline?.synthetic && !request.normalized?.conditionalOnly && run.modelMode === 'live' && run.sourceMode === 'live' && cited.every((item) => item.sourceMode === 'live' && !item.fixture),
          label: run.modelMode === 'mock' || run.sourceMode !== 'live' ? '协议模拟或回放资料结果，不是真实预测' : '模型事件概率估计' }
        db.prepare('INSERT INTO course_forecasts VALUES (?,?,?,?)').run(value.forecastId, runId, hash, json(value))
        append(run, { eventId: `${runId}_forecast`, type: 'forecast.published', payload: value })
        writeRequest({ ...request, latestForecastId: value.forecastId, updatedAt: at })
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
