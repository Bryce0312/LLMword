import { courseAssignments, courseTeam, courseTeamSignature, normalizeCourseRole } from './course-team.mjs'
import { courseModelActivity, coursePhaseLabel } from './course-workflow.mjs'
const ended = (status) => ['completed', 'finished', 'insufficient', 'failed', 'cancelled'].includes(status)
const clone = (value) => structuredClone(value)
export function createCourseProjection({ requestId = null } = {}) { return { requestId, runId: null, generation: 0, highWater: -1, seen: [], presented: [], status: null, assignments: [], teamSignature: null } }
function roleOf(p, assignments, team) {
  const assignment = assignments.find((a) => a.assignmentId === p.assignmentId || (p.agentInstanceId && a.agentInstanceId === p.agentInstanceId))
  const allowed = new Set(team.map((a) => a.roleId))
  return [assignment?.roleId, assignment?.role, assignment?.agentSpecId, p.roleId, p.role, p.agentSpecId, p.senderRole].map(normalizeCourseRole).find((id) => allowed.has(id)) ?? null
}
/** HTTP snapshots are authoritative public state; first-load history never becomes new speech. */
export function projectCourseSnapshot(previous, run, { fresh = false } = {}) {
  if (!run?.runId) return { state: previous, effects: [] }
  if (previous.requestId && run.requestId !== previous.requestId) return { state: previous, effects: [], ignored: 'request-mismatch' }
  const changed = previous.runId !== run.runId
  const state = changed ? { ...createCourseProjection({ requestId: previous.requestId ?? run.requestId ?? null }), runId: run.runId, generation: previous.generation + 1 } : clone(previous)
  const assignments = courseAssignments(run)
  const team = courseTeam(run)
  const events = [...(run.events ?? [])].filter((e) => Number.isSafeInteger(e.seq) && e.eventId).sort((a, b) => a.seq - b.seq)
  const outcome = { triage: clone(run.triage ?? null), summary: run.summary ?? '', hasForecast: Boolean(run.forecast?.forecastId), assignmentCount: assignments.length }
  const effects = changed ? [{ type: 'reset' }] : []
  const teamSignature = courseTeamSignature(team)
  if (state.teamSignature !== teamSignature) { effects.push({ type: 'team', team: clone(team) }); state.teamSignature = teamSignature }
  const baseline = changed && (!fresh || ended(run.status))
  if (baseline) {
    state.assignments = clone(assignments)
    state.status = run.status
    state.seen = events.map((e) => e.eventId)
    state.highWater = Math.max(-1, ...events.map((e) => e.seq))
    effects.push({ type: 'restore', assignments: clone(assignments), modelActivity: courseModelActivity(run), status: run.status, ...outcome })
  } else {
    for (const event of events) {
      if (event.seq <= state.highWater || state.seen.includes(event.eventId)) continue
      state.highWater = event.seq; state.seen.push(event.eventId)
      if (ended(state.status)) continue
      const p = event.payload ?? {}; const roleId = roleOf(p, assignments, team)
      const summary = p.summary ?? p.message ?? p.report?.summary ?? ''
      if (event.type === 'assignment.started' && roleId) effects.push({ type: 'work', roleId, assignmentId: p.assignmentId, summary: p.objective ?? summary })
      if (event.type === 'assignment.completed' && roleId) {
        effects.push({ type: 'stop', roleId, assignmentId: p.assignmentId })
        const resultId = p.resultId ?? p.report?.resultId ?? event.eventId
        const id = JSON.stringify([p.assignmentId, resultId])
        if (!state.presented.includes(id)) {
          state.presented.push(id)
          if (summary) effects.push({ type: 'speech', roleId, assignmentId: p.assignmentId, resultId, status: p.status ?? p.report?.status ?? 'unknown', summary, evidenceIds: p.evidenceIds ?? p.report?.evidenceIds ?? [] })
        }
      }
      if (['tool.started', 'tool.completed', 'tool.failed'].includes(event.type) && roleId) effects.push({ type: 'tool', roleId, toolId: p.toolId, status: event.type === 'tool.started' ? 'running' : p.status ?? 'error', summary })
      if (['model.requested', 'model.completed', 'model.failed'].includes(event.type) && roleId && p.modelRequestId) {
        const member = team.find(a => a.roleId === roleId)
        if (!member?.assignmentId || !p.assignmentId || p.assignmentId === member.assignmentId) effects.push({ type: 'model', roleId, assignmentId: p.assignmentId,
          modelRequestId: p.modelRequestId,
          status: event.type === 'model.requested' ? 'waiting' : event.type === 'model.completed' ? 'returned' : 'failed',
          index: Number.isSafeInteger(p.index ?? p.modelRequestIndex) ? p.index ?? p.modelRequestIndex : null, elapsedMs: Number.isSafeInteger(p.elapsedMs) ? p.elapsedMs : null })
      }
      if (['meeting.started', 'meeting.opened'].includes(event.type)) effects.push({ type: 'meeting', summary, participants: (p.roleIds ?? p.participants ?? team.map((a) => a.roleId)).map((member) => normalizeCourseRole(typeof member === 'string' ? member : member.roleId)).filter((id) => team.some((a) => a.roleId === id)) })
      if (['meeting.message', 'communication.sent'].includes(event.type) && roleId && summary) {
        const id = p.resultId && p.assignmentId ? JSON.stringify([p.assignmentId, p.resultId]) : p.messageId ?? event.eventId
        if (!state.presented.includes(id)) { state.presented.push(id); effects.push({ type: 'speech', roleId, status: 'message', summary, evidenceIds: p.evidenceIds ?? [] }) }
      }
      if (event.type === 'forecast.published') effects.push({ type: 'phase', summary: '本轮判断已提交' })
      if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) {
        state.status = event.type === 'run.finished' ? (ended(run.status) ? run.status : ended(p.status) ? p.status : 'completed') : event.type.split('.')[1]
        effects.push({ type: 'end', status: state.status, ...outcome, summary: outcome.summary || summary })
      }
    }
    state.assignments = clone(assignments)
    if (!ended(state.status)) state.status = run.status
  }
  const usageSignature = JSON.stringify(assignments.map(a => [a.assignmentId, a.usage, a.budget, a.cycle, a.status]))
  if (state.usageSignature !== usageSignature) { effects.push({ type: 'usage', assignments: clone(assignments), status: run.status }); state.usageSignature = usageSignature }
  const phaseLabel = run.phase && !ended(run.status) ? coursePhaseLabel(run) : null
  const activityChanged = effects.some(effect => ['model', 'tool', 'work', 'meeting', 'speech'].includes(effect.type))
  if (phaseLabel && (state.phaseLabel !== phaseLabel || activityChanged)) { effects.push({ type: 'phase', summary: phaseLabel }); state.phaseLabel = phaseLabel }
  state.seen = state.seen.slice(-2000)
  return { state, effects: effects.map((e) => ({ ...e, runId: state.runId, generation: state.generation })) }
}

/** A completed check is not a new forecast or a submitted worker report. */
export function courseRoomOutcome({ status, triage, hasForecast = false, assignmentCount = 0 } = {}) {
  const completed = ['completed', 'finished'].includes(status)
  const noChange = completed && triage?.kind === 'no_change' && !hasForecast && assignmentCount === 0
  if (noChange) return { phase: '检查完成，保留原判断', supervisorState: 'checked', supervisorObjective: '检查新资料，保留原判断', teamNote: '本次没有新变化，未召集研究员' }
  if (completed) return { phase: hasForecast ? '本轮判断已保存' : '检查完成，未发布新判断', supervisorState: hasForecast ? 'published' : 'checked', ...(assignmentCount === 0 ? { teamNote: '本轮未召集研究员，未发布新判断' } : {}) }
  return { phase: status === 'insufficient' ? '本轮资料不足，暂未判断' : status === 'failed' ? '本轮调查未完成' : status === 'cancelled' ? '本轮已停止' : '恢复本轮真实状态', supervisorState: status }
}

/** Only actual immutable publications for one fixed target are eligible chart points. */
export function courseForecastPoints(records, { predictionId, predictionVersion, targetAt, now = Date.now() } = {}) {
  const seen = new Set()
  return [...(records ?? [])].map((f) => ({ ...f, publishedAt: f.publishedAt ?? f.issuedAt })).filter((f) => {
    if (!f.forecastId || seen.has(f.forecastId)) return false
    if (!f.predictionId || !Number.isInteger(f.predictionVersion) || f.predictionVersion < 1 || !Number.isFinite(Date.parse(f.targetAt))) return false
    if (!Number.isFinite(f.probabilityYes) || f.probabilityYes < 0 || f.probabilityYes > 1) return false
    const at = Date.parse(f.publishedAt)
    if (!Number.isFinite(at) || at > now) return false
    if (predictionId && f.predictionId !== predictionId) return false
    if (predictionVersion && f.predictionVersion !== predictionVersion) return false
    if (targetAt && Date.parse(f.targetAt) !== Date.parse(targetAt)) return false
    seen.add(f.forecastId); return true
  }).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
}
