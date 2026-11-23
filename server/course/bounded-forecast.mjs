import { validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { compactToolReceipt } from '../runtime/model-budget.mjs'

/** Budget allocation and public aggregation for the bounded forecast policy. */
export const BOUNDED_FORECAST_POLICY = 'bounded-forecast-v1'
export const isBoundedForecast = (run) => run?.budget?.strategy === BOUNDED_FORECAST_POLICY

export function boundedForecastBudget(base, maxTotalTokens) {
  if (base.deliveryPolicy === 'exploratory-estimate-v1') {
    const envelope = Math.min(maxTotalTokens ?? 600000, 600000)
    const mainReserveTokens = Math.min(36000, Math.max(2048, Math.floor(envelope * .18)))
    const workerTokens = Math.max(1024, Math.min(90000, Math.floor((envelope - mainReserveTokens) * .18)))
    return { ...base, strategy: BOUNDED_FORECAST_POLICY, maxTotalTokens, maxModelRequests: 60, maxToolCalls: 48,
      mainRequests: 10, mainPhaseRequests: 3, maxTokens: Math.min(base.maxTokens, 8192), mainReserveTokens, maxFollowUps: 2,
      worker: { ...base.worker, maxModelRequests: 10, maxInvestigationRequests: 6, maxToolCalls: 8,
        maxTotalTokens: workerTokens, maxTokens: Math.min(base.worker.maxTokens, 8192),
        reserveReportTokens: Math.min(32000, Math.max(1024, Math.floor(workerTokens * .45))),
        inputAwareCloseout: true, reportRepairRequests: 2, reportOutputTokens: Math.min(base.worker.maxTokens, 8192) } }
  }
  const envelope = Math.min(maxTotalTokens ?? 300000, 300000)
  const mainReserveTokens = Math.min(24000, Math.max(2048, Math.floor(envelope * .18)))
  const workerTokens = Math.max(1024, Math.min(60000, Math.floor((envelope - mainReserveTokens) * .24)))
  return { ...base, strategy: BOUNDED_FORECAST_POLICY, maxTotalTokens, maxModelRequests: 30, maxToolCalls: 24,
    mainRequests: 6, maxTokens: Math.min(base.maxTokens, 8192), mainReserveTokens, maxFollowUps: 1,
    worker: { ...base.worker, maxModelRequests: 6, maxToolCalls: 4, maxTotalTokens: workerTokens,
      maxTokens: Math.min(base.worker.maxTokens, 8192), reserveReportTokens: Math.min(24000, Math.max(1024, Math.floor(workerTokens * .45))),
      inputAwareCloseout: true, reportRepairRequests: 1, reportOutputTokens: Math.min(base.worker.maxTokens, 8192) } }
}

/** Keep the coordinator focused on public reports, never worker private protocols. */
export function boundedMainMessages(messages, scorecard = []) {
  const latest = messages.findLast(m => m.role === 'user')
  let input = {}
  try { input = JSON.parse(latest?.content || '{}') } catch {
    try { input = JSON.parse(messages.find(m => m.role === 'user')?.content || '{}') } catch {}
  }
  const reports = (input.reports || []).map(r => ({ ...r, summary: r.summary?.slice(0, 450),
    support: (r.support || []).slice(0, 2), counterevidence: (r.counterevidence || []).slice(0, 1), missingEvidence: (r.missingEvidence || []).slice(0, 3) }))
  const context = { kind: 'course-main', phase: input.phase, question: input.question, purpose: input.purpose, mode: input.mode,
    groundingPolicy: input.groundingPolicy, strict: input.strict, timeContext: input.timeContext, targetAt: input.targetAt,
    defaultAssumptions: input.defaultAssumptions, normalized: input.normalized, draft: input.draft,
    roleCatalogue: (input.roleCatalogue || []).map(r => ({ roleId: r.roleId, name: r.name, focus: r.focus?.slice(0, 180) })),
    defaultRoleIds: input.defaultRoleIds, selectedRoleIds: input.selectedRoleIds, capabilityRequirements: input.capabilityRequirements,
    reports, scorecard, assignmentStatus: input.assignmentStatus, followUpsRemaining: input.followUpsRemaining, followUpDone: input.followUpDone,
    deliveryPolicy: input.deliveryPolicy, reportAdequacy: input.reportAdequacy,
    historicalMemory: input.historicalMemory, newEvidence: input.newEvidence, previousTeam: input.previousTeam, changeHints: input.changeHints,
    evidence: (input.evidence || []).map(e => ({ evidenceId: e.evidenceId, title: e.title, url: e.url, contentHash: e.contentHash })),
    instruction: (input.instruction || '') + '\n只做短规划或汇总，研究员已负责取证。先比较scorecard的各席Yes估计与其支持/反证；概率、证据充分度、来源独立性分开。不要要求取得未来结果；每个候选使用已读原文。纠错次数由本轮预算决定。' }
  const result = [messages[0], { role: 'user', content: JSON.stringify(context) }]
  // A correction retains an actual assistant tool call and its matching results.
  const lastAssistant = messages.findLastIndex(m => m.role === 'assistant')
  if (lastAssistant > 0) {
    const assistant = messages[lastAssistant]
    const calls = new Map((assistant.tool_calls || []).map(call => [call.id, call.function?.name]))
    result.push(assistant, ...messages.slice(lastAssistant + 1).filter(m => m.role === 'tool' && calls.has(m.tool_call_id)).map(m => {
      let receipt
      try { receipt = JSON.parse(m.content) } catch { return { ...m, content: m.content.slice(0, 1800) } }
      return { ...m, content: JSON.stringify(compactToolReceipt({ toolId: calls.get(m.tool_call_id), toolCallId: m.tool_call_id, result: receipt })) }
    }))
  }
  return result
}

/** Latest complete report per distinct role, including a successful replacement. */
export function effectiveRoleReports(assignments = []) {
  const roles = new Map()
  for (const item of assignments) if (item.roleId && item.assignmentId && item.status === 'completed' && item.report?.status === 'complete' &&
    !item.report.generatedBy && !item.report.completionMode && item.report.evidenceIds?.length) roles.set(item.roleId, item)
  return [...roles.values()]
}

export function reportScorecard(assignments = []) {
  return effectiveRoleReports(assignments).map(item => ({ roleId: item.roleId, assignmentId: item.assignmentId,
    probabilityYes: Number.isFinite(item.report.probability) && item.report.probability >= 0 && item.report.probability <= 1 ? item.report.probability : null,
    evidenceCount: item.report.evidenceIds.length, summary: item.report.summary.slice(0, 600),
    missingEvidence: (item.report.missingEvidence || []).slice(0, 3),
    interpretation: 'role-estimate-not-calibrated-accuracy; sources-may-overlap' }))
}

/** No model/network calls; only aggregate previously validated independent reports. */
export function assembleForecastCandidate(assignments, evidence, { outputLanguage } = {}) {
  const english = outputLanguage === 'en'
  const reports = effectiveRoleReports(assignments)
  const sources = new Map(evidence.filter(e => e.text?.trim()).map(e => [e.evidenceId, e]))
  const own = (item, ids) => [...new Set(ids || [])].filter(id => sources.get(id)?.readBy?.includes(item.assignmentId))
  const roleClaims = new Map()
  const usable = reports.filter(item => {
    const declared = new Set(own(item, item.report.evidenceIds))
    const claims = [...(item.report.support || []), ...(item.report.counterevidence || [])].flatMap(claim => {
      // Do not silently remove an unsupported source while retaining its claim.
      if (!claim?.evidenceIds?.length || claim.evidenceIds.some(id => !declared.has(id))) return []
      try { return validateGroundedClaims([claim], [...sources.values()], { readerId: item.assignmentId }) } catch { return [] }
    })
    roleClaims.set(item.assignmentId, claims)
    return claims.length > 0
  })
  const estimates = usable.filter(item => Number.isFinite(item.report.probability) && item.report.probability >= 0 && item.report.probability <= 1)
  if (usable.length < 2 || estimates.length < 2) return null
  const values = estimates.map(item => item.report.probability).sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  const probabilityYes = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  // Keep a real claim from each contributing estimate before adding detail. A
  // verbose first report must not hide the other roles behind the six-claim cap.
  const ordered = [...estimates, ...usable.filter(item => !estimates.includes(item))]
  const claims = ordered.flatMap(item => roleClaims.get(item.assignmentId).slice(0, 1)).slice(0, 6)
  for (const item of ordered) for (const claim of roleClaims.get(item.assignmentId).slice(1)) if (claims.length < 6) claims.push(claim)
  if (!claims.length) return null
  return { probabilityYes, evidenceAdequacy: 'limited', outcomeKnown: false, outcome: null,
    summary: english ? `Bounded report aggregation: ${estimates.length} researchers with distinct roles submitted evidence-backed estimates. Their unweighted median gives Yes ${Math.round(probabilityYes * 100)}%. The lead agent did not complete a valid final decision. This program only assembled validated reports; the estimate is uncalibrated and sources may overlap.` : `有界报告汇集：${estimates.length}个不同职责的研究员已提交带证据的概率估计，按候选概率中位数汇集为Yes ${Math.round(probabilityYes * 100)}%。主Agent未完成有效最终裁决，程序仅整理已核验报告；该估计未校准，来源可能重叠。`,
    evidenceIds: [...new Set(usable.flatMap(item => own(item, item.report.evidenceIds)))], reasoningClaims: claims,
    dissent: [...new Set(usable.flatMap(item => item.report.missingEvidence || []))].slice(0, 5),
    sourceLimitations: english ? ['The program assembled existing valid reports; the lead agent did not complete an independent final decision.', 'The aggregation uses an unweighted median. Multiple researchers or repeated sources are not statistically independent evidence.'] : ['程序汇集已有有效报告，不代表主Agent完成独立最终裁决。', '采用无权中位数，不能把多位研究员或重复来源当作统计独立证据。'],
    decisionNotes: usable.map(item => ({ assignmentId: item.assignmentId, disposition: 'qualified',
      reason: english ? 'Retains this role’s validated report and uncertainty. Only valid estimates enter the median; no facts or model calls were added.' : '保留该角色已核验报告及不确定性；仅对有效候选概率作中位数汇集，不追加事实或模型调用。', evidenceIds: own(item, item.report.evidenceIds) })),
    publicationMode: 'bounded-report-aggregation', aggregationMethod: 'unweighted-median', scorecard: reportScorecard(usable) }
}

export function partialForecastSummary(assignments, evidence, reason, { outputLanguage } = {}) {
  const english = outputLanguage === 'en'
  const completed = effectiveRoleReports(assignments)
  const known = completed.map(item => `${item.name || item.roleId}${english ? ': ' : '：'}${item.report.summary.slice(0, 250)}`)
  const gaps = [...new Set(assignments.flatMap(item => item.report?.missingEvidence || (item.error?.message ? [english ? 'A researcher could not finish; see the saved failure record.' : item.error.message] : [])))].slice(0, 5)
  return { kind: 'partial_research', generatedBy: 'harness', probabilityYes: null,
    summary: english ? known.length ? `This run has ended. Valid reports from ${completed.length} distinct roles were retained. ${known.join('; ')}` : 'This run has ended without enough valid independent reports. Read materials and failure records have been retained.' : known.length ? `本轮已结束，保留${completed.length}个不同职责的有效报告。${known.join('；')}` : '本轮已结束，尚无足够的有效独立报告；已读取材料与失败原因保留。',
    reason: english ? 'The run ended before a valid final assessment was completed; see the saved run record.' : reason, evidenceCount: evidence.length, roleScores: reportScorecard(assignments), gaps,
    notice: english ? 'Partial research material, not a published probability forecast. No probabilities were fabricated and no model calls were added.' : '阶段性资料整理，不是正式概率预测；没有补造概率或追加模型调用。' }
}
