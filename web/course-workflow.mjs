import { courseAssignments, courseRoleName, normalizeCourseRole } from './course-team.mjs'

const ended = (status) => ['completed', 'finished', 'insufficient', 'failed', 'cancelled'].includes(status)
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null
const latestAssignments = (run) => [...new Map(courseAssignments(run).map((a) => [normalizeCourseRole(a.roleId ?? a.agentSpecId ?? a.role), a])).values()]

export function coursePhaseLabel(run = {}) {
  const v3 = run.harnessVersion >= 3 && run.orchestration
  const cycle = v3 && positive(run.orchestration.cycle)
  const prefix = cycle ? `第 ${cycle} 个调查周期 · ` : ''
  const working = new Set(courseAssignments(run).filter(a => a.status === 'running').map(a => normalizeCourseRole(a.roleId ?? a.agentSpecId ?? a.role))).size
  const waiting = courseModelActivity(run).filter(a => a.roleId !== 'supervisor' && a.status === 'waiting').length
  const waitingText = waiting ? `（${waiting} 位等待模型返回）` : ''
  if (run.phase === 'workers') return prefix + (working ? `${working} 位子 Agent 正在独立调查；主 Agent 等待报告${waitingText}` : '研究员正在独立调查')
  if (run.phase === 'followup') return prefix + (working ? `${working} 位子 Agent 正在定向补查${waitingText}` : '正在针对分歧补查')
  if (run.phase === 'prepare') return v3 ? '主 Agent 根据子 Agent 的资料核定题目' : '正在整理问题与寻找来源'
  if (run.phase === 'review') return prefix + (v3 ? '汇报与质询，决定是否补查或总结' : '正在汇总与核对报告')
  return ({ intake: '主 Agent 整理题意并立即派工', plan: '正在按题选择研究员', triage: '正在比较新信息与安排复核', watch_check: '正在检查新资料' })[run.phase] ?? '调查中'
}

/** Persisted model events describe waiting; their summaries never become speech. */
export function courseModelActivity(run = {}) {
  const assignments = latestAssignments(run)
  const allowed = new Map(assignments.map(a => [normalizeCourseRole(a.roleId ?? a.agentSpecId ?? a.role), a]))
  allowed.set('supervisor', null)
  const activity = new Map()
  for (const event of [...(run.events ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (event.runId && event.runId !== run.runId) continue
    const p = event.payload ?? {}
    const match = assignments.find(a => a.assignmentId && a.assignmentId === p.assignmentId)
    const roleId = normalizeCourseRole(match?.roleId ?? match?.agentSpecId ?? p.roleId ?? p.agentSpecId)
    if (!allowed.has(roleId)) continue
    const current = allowed.get(roleId)
    if (current?.assignmentId && p.assignmentId && p.assignmentId !== current.assignmentId) continue
    if (event.type === 'assignment.started') { activity.delete(roleId); continue }
    if (event.type === 'assignment.completed') { activity.delete(roleId); continue }
    const status = ({ 'model.requested': 'waiting', 'model.completed': 'returned', 'model.failed': 'failed' })[event.type]
    if (!status || !p.modelRequestId) continue
    const previous = activity.get(roleId)
    if (status !== 'waiting' && previous?.modelRequestId && previous.modelRequestId !== p.modelRequestId) continue
    activity.set(roleId, { roleId, status, modelRequestId: p.modelRequestId, index: positive(p.index ?? p.modelRequestIndex), elapsedMs: count(p.elapsedMs) })
  }
  for (const [roleId, value] of activity) {
    const inactive = ended(run.status) || roleId !== 'supervisor' && allowed.get(roleId)?.status !== 'running'
    if (inactive && value.status === 'waiting') activity.set(roleId, { ...value, status: 'ended' })
  }
  return [...activity.values()]
}

const statusText = (assignment) => ({ queued: '等待执行', pending: '等待执行', running: '调查中', completed: '报告已提交', complete: '报告已提交', failed: '执行失败', cancelled: '已取消', insufficient: '资料不足', blocked: '存在缺口' })[assignment.report?.status ?? assignment.status] ?? '等待执行状态'
export function courseWorkflowView(run = {}) {
  const v3 = run.harnessVersion >= 3 && run.orchestration
  const o = v3 ? run.orchestration : null
  const modelActivity = new Map(courseModelActivity(run).map(a => [a.roleId, a]))
  const rows = latestAssignments(run).map(a => {
    const roleId = normalizeCourseRole(a.roleId ?? a.agentSpecId ?? a.role)
    const activity = modelActivity.get(roleId)
    const modelIndex = activity?.index
    const activityText = a.status === 'running' && !ended(run.status) && activity?.status === 'waiting' ? `等待模型返回${modelIndex ? ` · 第 ${modelIndex} 次判断` : ''}` : statusText(a)
    return { roleId, name: courseRoleName(roleId, a.name), assignmentId: a.assignmentId, cycle: positive(a.cycle), status: a.status,
      activityText, waiting: a.status === 'running' && !ended(run.status) && activity?.status === 'waiting',
      usage: { modelRequests: count(a.usage?.modelRequests), toolCalls: count(a.usage?.toolCalls), totalTokens: count(a.usage?.totalTokens) },
      budget: { maxModelRequests: positive(a.budget?.maxModelRequests), maxToolCalls: positive(a.budget?.maxToolCalls), maxTotalTokens: positive(a.budget?.maxTotalTokens) } }
  })
  const status = ended(run.status) ? ({ completed: '本轮已完成', finished: '本轮已结束', failed: '本轮未完成', insufficient: '本轮资料不足', cancelled: '本轮已取消' })[run.status] : run.status === 'queued' ? '排队中，尚未调用本轮模型' : coursePhaseLabel(run)
  return { version: v3 ? 3 : positive(run.harnessVersion), versionLabel: v3 ? '新版协作 · 先分工再取证' : run.harnessVersion === 2 ? '本轮使用旧版流程' : '执行版本未记录', status,
    cycle: o && positive(o.cycle), maxCycles: o && positive(o.maxCycles), followUpsUsed: o && count(o.followUpsUsed), maxFollowUps: o && count(o.maxFollowUps),
    investigationSteps: o && positive(o.investigationSteps), reportStep: o && positive(o.reportStep), rows,
    usage: { modelRequests: count(run.usage?.modelRequests), toolCalls: count(run.usage?.toolCalls), totalTokens: count(run.usage?.totalTokens), unknownUsage: Boolean(run.usage?.unknownUsage) },
    budget: { maxModelRequests: positive(run.budget?.maxModelRequests), maxToolCalls: positive(run.budget?.maxToolCalls), maxTotalTokens: positive(run.budget?.maxTotalTokens) },
    flow: v3 ? '整理与派工 → 独立调查 → 核定题目 → 汇报与质询 → 按争议补查 → 总结' : '原流程先由主 Agent 核对来源，再派工调查；本轮不会回写为新流程。' }
}

export function courseUsageText(used, limit, unit = '') {
  return used === null ? '未记录' : used.toLocaleString('zh-CN') + (limit === null ? '' : ' / ' + limit.toLocaleString('zh-CN')) + unit
}

export function courseModelStatusView(activity = {}) {
  const waiting = activity.status === 'waiting'
  const index = positive(activity.index) ? `第 ${activity.index} 次模型判断` : '模型请求'
  return { waiting, badgeText: waiting ? '等待模型' : '',
    text: waiting ? `${index} · 等待真实返回` : activity.status === 'failed' ? `${index} · 本次未完成` : activity.status === 'returned' ? `${index} · 已返回` : '' }
}
