// Pure V1 event projection. It does not fetch, animate, own timers, or expose model messages.
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const ASSIGNMENT_TERMINAL = new Set(['complete', 'insufficient', 'blocked', 'failed', 'cancelled', 'unknown'])
const RUN_STATUS = {
  'run.started': 'running', 'run.waiting': 'waiting', 'run.finished': 'completed',
  'run.failed': 'failed', 'run.cancelled': 'cancelled',
}
const copy = (value) => structuredClone(value)
const isId = (value) => typeof value === 'string' && value.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(value)
const text = (value) => typeof value === 'string' ? value : ''
const ids = (value) => Array.isArray(value) ? value.filter(isId) : []
const summary = (payload) => text(payload.summary) || text(payload.message)
const key = (...parts) => JSON.stringify(parts)
const outcomeTone = (status) => ({ complete: 'success', ok: 'success', insufficient: 'insufficient', blocked: 'blocked', cancelled: 'cancelled' })[status] ?? 'error'
const answer = (state, effects = [], ignored = null) => ({ state, effects, ignored })

export function parseCursor(cursor) {
  if (typeof cursor !== 'string') return null
  const split = cursor.lastIndexOf(':')
  const epoch = cursor.slice(0, split)
  const digits = cursor.slice(split + 1)
  const seq = Number(digits)
  return split > 0 && /^\d+$/.test(digits) && Number.isSafeInteger(seq) ? { epoch, seq } : null
}

export function createProjectionState({ selectedRunId = null } = {}) {
  return {
    serverEpoch: null, cursor: null, highWaterSeq: -1, coveredThroughCursor: null,
    snapshotVersion: -1, needsSync: false, selectedRunId, roomGeneration: 0,
    seenEventIds: [], runs: {},
  }
}

function newRun(runId) {
  return {
    runId, topicId: null, predictionId: null, scope: null, trigger: null,
    status: 'queued', version: 0, lastSeq: -1, unread: 0,
    assignments: {}, tools: {}, records: [], presented: [], plan: '',
    graph: null, forecast: null, watch: null, resolution: null,
  }
}

function publicAssignment(raw = {}) {
  return {
    assignmentId: raw.assignmentId, agentInstanceId: raw.agentInstanceId ?? null,
    status: text(raw.status) || 'pending', label: text(raw.label) || text(raw.objective),
    resultId: raw.resultId ?? null, summary: summary(raw), evidenceIds: ids(raw.evidenceIds),
  }
}

function runFromSnapshot(raw) {
  const run = newRun(raw.runId)
  for (const field of ['topicId', 'predictionId', 'scope', 'trigger', 'status']) {
    if (typeof raw[field] === 'string') run[field] = raw[field]
  }
  run.version = Number.isSafeInteger(raw.version) ? raw.version : 0
  const assignments = [...(Array.isArray(raw.assignments) ? raw.assignments : []), ...(raw.assignment ? [raw.assignment] : [])]
  for (const entry of assignments) {
    if (isId(entry?.assignmentId)) run.assignments[entry.assignmentId] = publicAssignment(entry)
  }
  const report = raw.report
  if (report && isId(report.assignmentId ?? raw.assignment?.assignmentId)) {
    const assignmentId = report.assignmentId ?? raw.assignment.assignmentId
    const previous = run.assignments[assignmentId] ?? { assignmentId }
    run.assignments[assignmentId] = { ...previous, ...publicAssignment({ ...previous, ...report, assignmentId }) }
  }
  // A reset restores state, never a historic success bubble. A later echo is also suppressed.
  for (const assignment of Object.values(run.assignments)) {
    if (isId(assignment.resultId)) run.presented.push(key('result', assignment.assignmentId, assignment.resultId))
  }
  return run
}

/** Changing the selected room never replays historic speech or takes ownership of another run. */
export function selectRun(state, runId) {
  if (runId !== null && !isId(runId)) return answer(state, [], 'invalid-run-id')
  if (state.selectedRunId === runId) return answer(state)
  const next = copy(state)
  next.selectedRunId = runId
  next.roomGeneration += 1
  const effects = [{ type: 'room.reset', runId, generation: next.roomGeneration }]
  const run = next.runs[runId]
  if (run) {
    run.unread = 0
    effects.push({ type: 'room.restore', runId, generation: next.roomGeneration, run: copy(run) })
    effects.push({ type: 'unread', runId, count: 0 })
  } else if (runId !== null) effects.push({ type: 'run.snapshot.required', runIds: [runId] })
  return answer(next, effects)
}

/** Hydrate one HTTP public snapshot without advancing or resetting the SSE stream cursor. */
export function hydrateRun(state, raw) {
  if (!isId(raw?.runId)) return answer(state, [], 'invalid-run-snapshot')
  const previous = state.runs[raw.runId]
  if (previous && Number.isSafeInteger(raw.version) && raw.version < previous.version) return answer(state, [], 'stale-run-snapshot')
  if (previous && RUN_TERMINAL.has(previous.status) && raw.status !== previous.status) return answer(state, [], 'terminal-run-snapshot')
  const next = copy(state)
  const run = runFromSnapshot(raw)
  if (previous) {
    run.records = copy(previous.records)
    run.tools = copy(previous.tools)
    run.presented = [...new Set([...previous.presented, ...run.presented])]
    run.lastSeq = previous.lastSeq
    run.unread = raw.runId === state.selectedRunId ? 0 : previous.unread
    for (const [id, assignment] of Object.entries(previous.assignments)) {
      if (ASSIGNMENT_TERMINAL.has(assignment.status)) run.assignments[id] = copy(assignment)
    }
  }
  next.runs[raw.runId] = run
  return answer(next, raw.runId === state.selectedRunId ? [{ type: 'room.restore', runId: raw.runId, generation: state.roomGeneration, run: copy(run) }] : [])
}

function requireSync(state, reason) {
  if (state.needsSync) return answer(state, [], 'needs-sync')
  const next = copy(state)
  next.needsSync = true
  next.roomGeneration += 1
  return answer(next, [
    { type: 'room.reset', runId: next.selectedRunId, generation: next.roomGeneration },
    { type: 'resync.required', reason },
  ], reason)
}

function resetSnapshot(state, envelope) {
  const payload = envelope.payload ?? {}
  if (!payload.reset) return answer(state, [], 'sync-hint')
  const cursor = parseCursor(payload.coveredThroughCursor)
  if (!cursor || cursor.epoch !== envelope.serverEpoch || !Number.isSafeInteger(payload.snapshotVersion) || payload.snapshotVersion < 0 ||
      !Array.isArray(payload.runs) || (payload.activeRuns !== undefined && !Array.isArray(payload.activeRuns))) {
    return requireSync(state, 'invalid-snapshot')
  }
  const sameEpoch = state.serverEpoch === cursor.epoch
  if (sameEpoch && (cursor.seq < state.highWaterSeq || payload.snapshotVersion < state.snapshotVersion)) {
    return answer(state, [], 'stale-snapshot')
  }
  const next = createProjectionState({ selectedRunId: state.selectedRunId })
  next.serverEpoch = cursor.epoch
  next.cursor = next.coveredThroughCursor = payload.coveredThroughCursor
  next.highWaterSeq = cursor.seq
  next.snapshotVersion = payload.snapshotVersion
  next.roomGeneration = state.roomGeneration + 1
  for (const raw of payload.runs ?? []) {
    if (!isId(raw?.runId)) continue
    let run = runFromSnapshot(raw)
    const previous = state.runs[raw.runId]
    if (sameEpoch && previous) {
      // An authoritative reset from the same database cannot resurrect a terminal run.
      if (RUN_TERMINAL.has(previous.status) && previous.status !== run.status) run = copy(previous)
      run.unread = raw.runId === next.selectedRunId ? 0 : previous.unread
    }
    next.runs[run.runId] = run
  }
  const missing = []
  for (const entry of payload.activeRuns ?? []) {
    const runId = typeof entry === 'string' ? entry : entry?.runId
    if (!isId(runId) || next.runs[runId]) continue
    if (typeof entry === 'object') next.runs[runId] = runFromSnapshot(entry)
    else missing.push(runId)
  }
  const effects = [{ type: 'room.reset', runId: next.selectedRunId, generation: next.roomGeneration }]
  const run = next.runs[next.selectedRunId]
  if (run) effects.push({ type: 'room.restore', runId: run.runId, generation: next.roomGeneration, run: copy(run) })
  if (missing.length) effects.push({ type: 'run.snapshot.required', runIds: missing })
  return answer(next, effects)
}

function publicRecord(event) {
  const p = event.payload
  return {
    eventId: event.eventId, seq: event.seq, type: event.type,
    assignmentId: p.assignmentId ?? null, agentInstanceId: p.agentInstanceId ?? null,
    resultId: p.resultId ?? null, status: text(p.status), summary: summary(p),
    evidenceIds: ids(p.evidenceIds),
  }
}

function addBubble(run, p, effects, status, kind = 'assignment') {
  const resultKey = isId(p.assignmentId) && isId(p.resultId) ? key('result', p.assignmentId, p.resultId) : null
  const messageKey = isId(p.messageId) ? key('message', p.messageId) : null
  if ((resultKey && run.presented.includes(resultKey)) || (messageKey && run.presented.includes(messageKey))) return
  if (resultKey) run.presented.push(resultKey)
  if (messageKey) run.presented.push(messageKey)
  if (!isId(p.agentInstanceId)) return
  effects.push({
    type: 'bubble', kind, agentInstanceId: p.agentInstanceId,
    assignmentId: p.assignmentId ?? null, resultId: p.resultId ?? null, messageId: p.messageId ?? null,
    status, tone: kind === 'meeting' ? 'neutral' : outcomeTone(status),
    success: kind !== 'meeting' && status === 'complete',
    label: text(p.label), message: summary(p), evidenceIds: ids(p.evidenceIds), minVisibleMs: 1700,
  })
}

function applyRunEvent(run, event, effects) {
  const p = event.payload
  if (RUN_TERMINAL.has(run.status) && event.type !== 'resolution.recorded') return
  if (Object.hasOwn(RUN_STATUS, event.type)) {
    run.status = RUN_STATUS[event.type]
    effects.push({ type: 'run.status', status: run.status, message: summary(p) })
    if (RUN_TERMINAL.has(run.status) || run.status === 'waiting') {
      for (const assignment of Object.values(run.assignments)) {
        if (!isId(assignment.agentInstanceId)) continue
        effects.push({ type: 'actor.stop', agentInstanceId: assignment.agentInstanceId, preserveBubble: run.status === 'completed' })
      }
    }
    return
  }
  if (event.type.startsWith('assignment.')) {
    if (!isId(p.assignmentId) || !isId(p.agentInstanceId)) return
    const old = run.assignments[p.assignmentId]
    if (old && ASSIGNMENT_TERMINAL.has(old.status)) return
    const status = ({ 'assignment.started': 'running', 'assignment.failed': 'failed', 'assignment.cancelled': 'cancelled' })[event.type]
      ?? (event.type === 'assignment.completed' ? text(p.status) || 'unknown' : null)
    if (!status) return
    const assignment = publicAssignment({ ...old, ...p, status })
    run.assignments[p.assignmentId] = assignment
    if (status === 'running') effects.push({ type: 'actor.work', agentInstanceId: p.agentInstanceId, assignmentId: p.assignmentId, preserveBubble: true })
    else {
      const stillWorking = Object.values(run.assignments).some((entry) => entry.agentInstanceId === p.agentInstanceId && entry.status === 'running')
      effects.push({ type: stillWorking ? 'actor.work' : 'actor.stop', agentInstanceId: p.agentInstanceId, assignmentId: p.assignmentId, preserveBubble: true })
      addBubble(run, p, effects, status)
    }
    return
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
    if (ASSIGNMENT_TERMINAL.has(run.assignments[p.assignmentId]?.status)) return
    const toolCallId = p.toolCallId ?? p.callId
    if (!isId(toolCallId)) return
    const previous = run.tools[toolCallId]
    if (previous && previous.status !== 'running') return
    const status = event.type === 'tool.started' ? 'running' : event.type === 'tool.failed' ? 'error' : text(p.status) || 'unknown'
    const tool = {
      toolCallId, toolId: p.toolId ?? null, assignmentId: p.assignmentId ?? null,
      agentInstanceId: p.agentInstanceId ?? null, status, summary: summary(p),
      evidenceIds: ids(p.evidenceIds), durationMs: Number.isFinite(p.durationMs) ? p.durationMs : null,
      argumentsSummary: text(p.argumentsSummary), success: status === 'ok',
    }
    run.tools[toolCallId] = tool
    effects.push({ type: 'tool', tool: copy(tool) })
    return
  }
  if (event.type === 'plan.updated') {
    run.plan = summary(p)
    effects.push({ type: 'plan', summary: run.plan })
  } else if (event.type === 'meeting.opened') {
    effects.push({ type: 'meeting', room: p.room === 'side-meeting' ? p.room : 'meeting', agentInstanceIds: ids(p.agentInstanceIds), summary: summary(p) })
  } else if (event.type === 'meeting.message') {
    addBubble(run, p, effects, 'complete', 'meeting')
  } else if (['graph.updated', 'watch.updated', 'resolution.recorded', 'forecast.published'].includes(event.type)) {
    const type = event.type.split('.')[0]
    // predictionVersion is the question contract, not a forecast publication revision.
    const version = p.version ?? p[`${type}Version`] ?? event.seq
    if (run[type] && (!Number.isSafeInteger(version) || version <= run[type].version)) return
    // These are public display fields, never raw checkpoints, prompts or reasoning_content.
    const data = { version: Number.isSafeInteger(version) ? version : 0 }
    for (const name of ['graphSnapshotId', 'forecastId', 'predictionVersion', 'resolutionId', 'status', 'summary', 'type', 'probabilityYes', 'targetAt', 'publishedAt', 'nextCheckAt']) {
      if (['string', 'number', 'boolean'].includes(typeof p[name]) || p[name] === null) data[name] = p[name]
    }
    if (Array.isArray(p.options)) data.options = p.options.map(({ optionId, label, probability }) => ({ optionId, label, probability }))
    data.evidenceIds = ids(p.evidenceIds)
    run[type] = data
    effects.push({ type, data: copy(data) })
  }
}

/** Events must already have passed the backend schema and V0 adapter. No I/O occurs here. */
export function projectEvent(state, envelope) {
  if (!envelope || envelope.schemaVersion !== 1 || !isId(envelope.serverEpoch)) return answer(state, [], 'invalid-envelope')
  if (envelope.type === 'sync') return resetSnapshot(state, envelope)
  if (!isId(envelope.eventId) || !Number.isSafeInteger(envelope.seq) || envelope.seq < 0 ||
      !['live', 'replay'].includes(envelope.scope) || typeof envelope.type !== 'string' ||
      !envelope.payload || typeof envelope.payload !== 'object') return answer(state, [], 'invalid-envelope')
  if (state.serverEpoch && state.serverEpoch !== envelope.serverEpoch) return requireSync(state, 'epoch-changed')
  if (state.needsSync) return answer(state, [], 'needs-sync')
  if (state.seenEventIds.includes(envelope.eventId)) return answer(state, [], 'duplicate-event')
  if (envelope.seq <= state.highWaterSeq) return answer(state, [], 'stale-seq')
  const next = copy(state)
  next.serverEpoch = envelope.serverEpoch
  next.highWaterSeq = envelope.seq
  next.cursor = `${envelope.serverEpoch}:${envelope.seq}`
  next.seenEventIds.push(envelope.eventId)
  if (next.seenEventIds.length > 2048) next.seenEventIds.shift()
  if (!isId(envelope.runId)) return answer(next, [], 'no-run')
  const run = next.runs[envelope.runId] ?? newRun(envelope.runId)
  next.runs[run.runId] = run
  for (const field of ['topicId', 'predictionId', 'scope', 'trigger']) {
    if (run[field] !== null && envelope[field] != null && run[field] !== envelope[field]) return requireSync(state, 'run-context-changed')
    if (envelope[field] != null) run[field] = envelope[field]
  }
  run.lastSeq = envelope.seq
  if (Number.isSafeInteger(envelope.payload.version)) run.version = Math.max(run.version, envelope.payload.version)
  run.records.push(publicRecord(envelope))
  if (run.records.length > 200) run.records.shift()
  const effects = []
  applyRunEvent(run, envelope, effects)
  if (next.selectedRunId !== run.runId) {
    if (!effects.length) return answer(next)
    run.unread += 1
    return answer(next, [{ type: 'unread', runId: run.runId, count: run.unread }])
  }
  if (['run.cancelled', 'run.failed'].includes(envelope.type) && effects.length) {
    next.roomGeneration += 1
    effects.unshift({ type: 'room.reset' })
  }
  return answer(next, effects.map((effect) => ({ ...effect, runId: run.runId, generation: next.roomGeneration, eventId: envelope.eventId })))
}
