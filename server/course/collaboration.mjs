import { PRICE_DIRECTION, isPriceDirection, directionFields } from '../../web/course-price-direction.mjs'

/** Public receipts only; model messages and checkpoints never enter this projection. */
export function validateDecisionNotes(notes, assignments, evidenceIds) {
  if (notes === undefined) return []
  if (!Array.isArray(notes) || notes.length > 12) throw new Error('裁决说明格式无效。')
  const seen = new Set()
  return notes.map((note) => {
    const assignment = assignments.find((item) => item.assignmentId === note?.assignmentId && item.report)
    if (!assignment || seen.has(note.assignmentId) || !['adopted', 'qualified', 'rejected'].includes(note.disposition) ||
      typeof note.reason !== 'string' || !note.reason.trim() || note.reason.length > 1000 ||
      !Array.isArray(note.evidenceIds) || new Set(note.evidenceIds).size !== note.evidenceIds.length ||
      note.evidenceIds.some((id) => !assignment.report.evidenceIds.includes(id) || !evidenceIds.includes(id)) ||
      (note.disposition === 'adopted' && (!note.evidenceIds.length || assignment.report.status !== 'complete'))) throw new Error('裁决须指向本轮报告及其已读证据；采纳须引用完整报告的证据。')
    seen.add(note.assignmentId)
    return { assignmentId: note.assignmentId, disposition: note.disposition, reason: note.reason.trim(), evidenceIds: [...note.evidenceIds] }
  })
}

export function buildCollaboration(run) {
  const evidence = (run.evidence || []).filter((item) => !item.runId || item.runId === run.runId)
  const available = new Map(evidence.map((item) => [item.evidenceId, item]))
  const refs = (ids = []) => [...new Set(ids)].filter((id) => available.has(id))
  const assignments = (run.assignments || []).filter((item) => !item.runId || item.runId === run.runId)
  const forecast = run.forecast?.runId === run.runId ? run.forecast : null
  const research = run.researchReport?.runId === run.runId ? run.researchReport : null
  const output = forecast || research
  const notes = output?.decisionNotes || []
  const reports = assignments.map((item) => {
    const report = item.report
    const decision = notes.find((note) => note.assignmentId === item.assignmentId)
    const claims = (items = []) => items.map((claim) => ({ claim: claim.claim, basis: claim.basis || null, citations: (claim.citations || []).filter(q => refs(claim.evidenceIds).includes(q.evidenceId)), evidenceIds: refs(claim.evidenceIds) })).filter((claim) => claim.evidenceIds.length)
    return { assignmentId: item.assignmentId, roleId: item.roleId, name: item.name, objective: item.objective, reason: item.reason,
      followUp: Boolean(item.followUp), cycle: item.cycle || 1, status: item.status, reportStatus: report?.status || null,
      summary: report?.summary || item.error?.message || '', probability: Number.isFinite(report?.probability) ? report.probability : null,
      evidenceIds: refs(report?.evidenceIds), support: claims(report?.support), counterevidence: claims(report?.counterevidence),
      missingEvidence: report?.missingEvidence || [], decision: decision ? { ...decision, evidenceIds: refs(decision.evidenceIds) } : null,
      review: item.review ? { objective: item.review.objective, reason: item.review.reason, evidenceIds: refs(item.review.evidenceIds),
        parentAssignmentIds: (item.review.parentAssignmentIds || []).filter((id) => assignments.some((a) => a.assignmentId === id)), requestedAt: item.review.requestedAt } : null }
  })
  const reviews = reports.filter((item) => item.followUp).map((item) => {
    const earlier = reports.filter((other) => other.roleId === item.roleId && other.cycle < item.cycle && other.reportStatus).at(-1)
    return { ...item, previousSummary: earlier?.summary || null, probabilityBefore: earlier?.probability ?? null, probabilityAfter: item.probability,
      newEvidenceIds: item.evidenceIds.filter((id) => !(earlier?.evidenceIds || []).includes(id)),
      responseStatus: item.reportStatus ? 'submitted' : item.status === 'failed' ? 'failed' : 'pending' }
  })
  const previous = run.memory?.previousForecast
  const comparable = previous && forecast && (!previous.predictionId || previous.predictionId === forecast.predictionId) && previous.predictionVersion === forecast.predictionVersion
  const delta = comparable && Number.isFinite(previous.probabilityYes) && Number.isFinite(forecast.probabilityYes) ? forecast.probabilityYes - previous.probabilityYes : null
  return { version: 1, runId: run.runId, modelMode: run.modelMode, sourceMode: run.sourceMode,
    team: reports.filter((item) => !item.followUp), reviews, reports,
    sources: evidence.map((item) => ({ evidenceId: item.evidenceId, title: item.title || item.evidenceId, url: item.url, publishedAt: item.publishedAt, obtainedAt: item.obtainedAt, marketQuote: item.marketQuote || null })),
    triage: run.triage ? { kind: run.triage.kind, reason: run.triage.reason, newEvidenceIds: refs(run.triage.newEvidenceIds) } : null,
    decision: output ? { kind: output.kind, groundingPolicy: output.groundingPolicy || null, reasoningClaims: forecast?.reasoningClaims || research?.findings || [], assemblyMode: output.assemblyMode, forecastId: forecast?.forecastId, reportId: research?.reportId, probabilityYes: forecast?.probabilityYes ?? null, previousProbabilityYes: comparable ? previous.probabilityYes : null,
      ...(isPriceDirection(forecast) ? { type: PRICE_DIRECTION, ...directionFields(forecast) } : {}),
      delta, summary: output.summary, evidenceIds: refs(output.evidenceIds), dissent: output.dissent || output.limitations || [], evidenceAdequacy: output.evidenceAdequacy,
      scoringEligible: output.scoringEligible, recordedNotes: notes.length, totalReports: reports.filter((item) => item.reportStatus).length } : null,
    conclusion: research ? research.assemblyMode === 'harness' ? '研究员资料整理版已保存；主Agent最终裁决未完成。' : '研报已封存；可逐项查看发现、补查与裁决。' : forecast ? reviews.length ? '已发布；可逐项查看补查答复与裁决。' : '已发布；本轮未进行定向补查。'
      : run.directionOutlook ? '本轮暂定走势已保存，概率留空。' : run.triage?.kind === 'no_change' ? '本次检查未发布新判断，保留上一判断。' : ['failed', 'insufficient', 'cancelled'].includes(run.status) ? '本轮未发布新判断，缺口与失败记录保留。' : '协作进行中，尚未发布判断。' }
}
