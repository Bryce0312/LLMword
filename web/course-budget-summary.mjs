/** Summarize only public material saved in this run. Used by the service and older snapshots. */
export function assembleBudgetSummary(assignments, evidence, cutoff, reason, { recovered = false } = {}) {
  const at = Date.parse(cutoff)
  const sources = evidence.filter(item => item.text?.trim() && item.readBy?.length &&
    Date.parse(item.obtainedAt) <= at && (!item.publishedAt || Date.parse(item.publishedAt) <= at))
  const byId = new Map(sources.map(item => [item.evidenceId, item]))
  const reports = assignments.filter(item => item.status === 'completed' && ['complete', 'insufficient'].includes(item.report?.status) &&
    item.report.summary?.trim() && item.report.generatedBy !== 'harness-budget-receipt')
    .map(({ assignmentId, roleId, name, report }) => ({
      assignmentId, name: name || roleId, status: report.status, summary: report.summary,
      evidenceIds: (report.evidenceIds || []).filter(id => byId.get(id)?.readBy.includes(assignmentId)),
      missingEvidence: report.missingEvidence || [],
    }))
  const reported = new Set(reports.map(report => report.assignmentId))
  const stage = recovered ? '本轮触及 token 预算' : '本轮因 token 预算提前收尾'
  return {
    reason, summary: `${stage}，已整理 ${reports.length} 份研究员报告和 ${sources.length} 份已读原文。`,
    reports, evidenceIds: sources.map(item => item.evidenceId),
    unfinished: assignments.filter(item => !reported.has(item.assignmentId)).map(({ roleId, name, objective }) => ({ name: name || roleId, objective })),
    ...(recovered ? { recovered: true } : {}),
  }
}

export function recoverCourseBudgetRun(run, purpose) {
  const limit = run?.budget?.maxTotalTokens
  if (purpose === 'research' || run?.status !== 'failed' || run.budgetSummary || run.error?.code !== 'COURSE_BUDGET' ||
    !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(run.usage?.totalTokens) || run.usage.totalTokens < limit) return run
  const budgetSummary = assembleBudgetSummary(run.assignments ?? [], run.evidence ?? [], run.updatedAt,
    run.error.message || '本轮已达到总 token 预算。', { recovered: true })
  return { ...run, budgetSummary, summary: budgetSummary.summary }
}

export function recoverCourseBudgetRequest(data) {
  const recover = run => recoverCourseBudgetRun(run, data.purpose)
  return { ...data, latestRun: recover(data.latestRun), run: recover(data.run), runs: data.runs?.map(recover) }
}
