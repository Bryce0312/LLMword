/** Deterministic public-report assembly. No provider, networking or new factual inference. */
export function assembleResearchCandidate(assignments, evidence) {
  const valid = new Map(evidence.filter((item) => item.text?.trim()).map((item) => [item.evidenceId, item]))
  const reports = assignments.filter((item) => item.status === 'completed' && item.report?.status === 'complete' && item.report.evidenceIds?.some((id) => valid.get(id)?.readBy?.includes(item.assignmentId)))
  const findings = [], decisionNotes = [], seen = new Set()
  for (const item of reports) {
    const own = (ids = []) => [...new Set(ids)].filter((id) => item.report.evidenceIds.includes(id) && valid.get(id)?.readBy?.includes(item.assignmentId))
    const claims = [...(item.report.support || []), ...(item.report.counterevidence || [])]
    const usable = claims.filter((claim) => claim.claim?.trim() && own(claim.evidenceIds).length)
    if (!usable.length && item.report.summary?.trim()) usable.push({ claim: item.report.summary, evidenceIds: own(item.report.evidenceIds) })
    for (const claim of usable) if (!seen.has(claim.claim) && findings.length < 10) {
      seen.add(claim.claim); findings.push({ claim: `${item.name || item.roleId}报告：${claim.claim}`, evidenceIds: own(claim.evidenceIds) })
    }
    decisionNotes.push({ assignmentId: item.assignmentId, disposition: 'qualified', reason: '程序整理已有研究员报告，主Agent最终裁决未完成，保留核验限制。', evidenceIds: own(item.report.evidenceIds) })
  }
  return { summary: `研究员资料整理版：汇集${reports.length}份已有报告；主Agent最终裁决未完成。`, findings, decisionNotes,
    limitations: ['主Agent汇总输出被截断。本结果由程序整理已有公开报告，不代表主Agent已完成最终裁决或独立复核。',
      '未追加模型或联网调用；研究员主张及来源仍需结合原文审阅，不据此推断股价或因果。',
      ...[...new Set(reports.flatMap((item) => item.report.missingEvidence || []))].slice(0, 8)] }
}
