/** Display metadata only. Selection and work always come from the saved run. */
export const COURSE_ROLE_LABELS = Object.freeze({
  supervisor: '主 Agent', official: '官方资料研究员', timeline: '新闻时间线研究员',
  industry: '行业与专业研究员', people: '人物与组织研究员', statistics: '统计与指标研究员',
  market: '预测市场研究员', social: '社群与舆情研究员', analogy: '历史类比研究员',
  graph: '关系图研究员', verification: '反证与核验研究员',
})
export const normalizeCourseRole = (id) => id === 'main' ? 'supervisor' : typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id) ? id : null
export const courseAssignments = (run) => Array.isArray(run?.assignments) ? run.assignments : Object.values(run?.assignments ?? {})
export const courseObjective = (value) => String(value ?? '').split('固定问题与规则：')[0].trim()
export const courseRoleName = (id, name) => name || COURSE_ROLE_LABELS[normalizeCourseRole(id)] || id || '研究员'

export function courseTeam(run) {
  const assigned = courseAssignments(run)
  const selectedEvent = [...(run?.events ?? [])].reverse().find((e) => e.type === 'team.selected')
  const selected = Array.isArray(run?.team) ? run.team : selectedEvent?.payload?.team ?? []
  const roster = new Map([['supervisor', { roleId: 'supervisor', name: '主 Agent', objective: '', reason: '' }]])
  for (const member of selected) {
    const roleId = normalizeCourseRole(member.roleId ?? member.agentSpecId)
    if (!roleId) continue
    roster.set(roleId, { roleId, name: courseRoleName(roleId, member.name), objective: courseObjective(member.objective), reason: member.reason ?? '', status: 'pending' })
  }
  for (const assignment of assigned) {
    const roleId = normalizeCourseRole(assignment.roleId ?? assignment.role ?? assignment.agentSpecId)
    if (!roleId) continue
    const prior = roster.get(roleId) ?? { roleId, name: courseRoleName(roleId, assignment.name), reason: assignment.reason ?? '' }
    roster.set(roleId, { ...prior, name: assignment.name || prior.name,
      objective: courseObjective(assignment.objective) || prior.objective || '',
      reason: prior.reason || assignment.reason || '',
      followUpReason: assignment.followUp ? assignment.reason ?? '' : '',
      assignmentId: assignment.assignmentId,
      status: assignment.report?.status ?? assignment.status ?? 'pending',
    })
  }
  return [...roster.values()]
}

export function courseTeamSignature(team) {
  return JSON.stringify(team.map(({ roleId, name, objective, reason, followUpReason, assignmentId }) => ({ roleId, name, objective, reason, followUpReason, assignmentId })))
}
