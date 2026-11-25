const positive = value => Number.isSafeInteger(value) && value > 0

/** Describe the policy saved with this memory snapshot, never today's defaults. */
export function courseMemoryPolicyLines(memory) {
  const p = memory?.policy
  if (!p || typeof p !== 'object') return []
  const lines = []
  if (positive(p.shortTermDays) && positive(p.maxJudgments)) lines.push(`短期：同题近 ${p.shortTermDays} 天，最多 ${p.maxJudgments} 次实质研判${positive(p.maxReports) ? `、${p.maxReports} 份报告` : ''}。`)
  if (positive(p.longTermDays) && positive(p.maxRelations) && positive(p.maxEvidence)) lines.push(`长期：近 ${p.longTermDays} 天，最多 ${p.maxRelations} 条关系与 ${p.maxEvidence} 条旧证据索引。`)
  if (p.retrievalIsNotDeletion === true || p.retention === 'archive-kept-without-automatic-deletion') lines.push('这些是检索窗口，封存档案不会因此自动删除。')
  if (p.historicalEvidenceRequiresRefresh === true) lines.push('旧资料只作比较与检索线索；本轮引用前必须重新读取。')
  return lines
}
