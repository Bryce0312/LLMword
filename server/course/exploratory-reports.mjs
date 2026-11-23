import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

export const EXPLORATORY_DELIVERY_POLICY = 'exploratory-estimate-v1'
export const isExploratoryForecast = (run, request = {}) => run?.budget?.deliveryPolicy === EXPLORATORY_DELIVERY_POLICY &&
  request.mode === 'preset' && (request.purpose || 'forecast') === 'forecast' && !request.resolutionPolicy

const hasText = value => typeof value === 'string' && Boolean(value.trim())
const validProbability = value => Number.isFinite(value) && value >= 0 && value <= 1
const months = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|HKT|UTC|GMT|EST|EDT|AM|PM)\b/giu

function dateLabelOnly(text) {
  const match = text.match(/^(?:last\s+updated|updated|published|更新(?:日期|時間|时间)?|發佈(?:日期|時間)?|发布(?:日期|时间)?)\s*[:：為为]?\s*(.+)$/iu)
  return Boolean(match && !match[1].replace(months, '').replace(/[\d\s年月日:/.,+\-TZ()]/gu, ''))
}

// This catches obvious access/legal boilerplate, not semantic entailment. A
// focus miss alone is not a rejection: a useful price/news excerpt can miss it.
function accessOnlyExcerpt(quote) {
  const lines = String(quote || '').normalize('NFKC').split(/\n|。|(?<=[.!?])\s+(?=[A-Z])/u).map(line => line.trim()).filter(Boolean)
  return !lines.some(line => line.length >= 8 && !dateLabelOnly(line) &&
    !/免[責责][聲声]明|版[權权]所有|all rights reserved|\bdisclaimer\b|terms of (?:use|service)|privacy (?:policy|notice)|使用[條条]款|隱私[權权]|隐私政策|(?:uses?|accept|our use of|agree to.*|consent.*)\s+cookies?|cookies?\s+(?:to|policy|preferences)|驗證碼|验证码|\bcaptcha\b|access denied|403 forbidden|404 not found|page not found|網頁無法|网页无法/iu.test(line) &&
    !/^(?:information|market data|quotes?|prices?|資料|数据|資訊|报价|報價).{0,100}(?:delayed|延[遲迟])/iu.test(line))
}

function sourceLimitationClaim(text) {
  // A failed page extraction is a source limitation, not a company event. Keep
  // this narrow: "公司未发布财报" is an entity fact, not an extraction failure.
  return /(?:页面|網頁|网页|正文|片段|抓取結果|抓取结果|读取结果).{0,100}(?:仅|只)(?:返回|包含|提供|有).{0,30}(?:简介|簡介|免责声明|免責聲明|页脚|頁腳)/u.test(text) ||
    /(?:页面|網頁|网页|正文|片段|抓取結果|抓取结果|读取结果).{0,100}(?:未|没有|無法|无法)(?:含|給出|给出|返回|取得|提供|读取).{0,40}(?:价格|價格|报价|報價|前收|行情|正文|可引用)/u.test(text) ||
    /(?:page|fetched\s+(?:body|excerpt)).{0,80}(?:only\s+(?:returned?|provided?)\s+(?:a\s+)?(?:company\s+)?(?:profile|footer)|(?:did\s+not|does\s+not|failed\s+to)\s+(?:return|provide).{0,30}(?:price|quote|body))/iu.test(text)
}

function assess(item, reportOrigin, evidence, { asOf, runId, unknownUsage }) {
  const report = item[reportOrigin]
  const identity = { assignmentId: item.assignmentId, roleId: item.roleId, reportOrigin }
  const gaps = [...(Array.isArray(report?.missingEvidence) ? report.missingEvidence.filter(hasText) : [])]
  const reject = (eligibleReason, detail) => ({ ...identity, eligibleReason, quality: 'unusable', gaps: detail ? [...gaps, detail] : gaps })
  if (!report) return reject('missing_model_report', '该任务没有模型报告。')
  if (unknownUsage || item.usage?.unknownUsage || item.checkpoint?.usage?.unknownUsage || report.delivery?.usageKnown === false) return reject('unknown_usage', '该任务用量未知，不能封存为有据模型估计。')
  if (!Number.isFinite(Date.parse(asOf))) return reject('invalid_cutoff', '缺少有效的本轮证据截止时刻。')
  const expectedRun = runId || item.runId || report.runId
  if (!hasText(expectedRun) || report.runId !== expectedRun || item.runId && item.runId !== expectedRun) return reject('foreign_run', '报告不属于本轮任务。')
  const taskUsage = item.usage || item.checkpoint?.usage
  const failedAuditedPartial = reportOrigin === 'partialReport' && item.status === 'failed' && taskUsage?.unknownUsage === false
  if (item.status !== 'completed' && !failedAuditedPartial || !['complete', 'insufficient'].includes(report.status)) return reject('blocked_or_unfinished', '受阻或尚未完成提交的任务不能当作模型估计。')
  if (!hasText(report.resultId) || report.assignmentId !== item.assignmentId || report.agentSpecId !== item.roleId || !hasText(item.roleId) || !hasText(item.assignmentId)) return reject('missing_worker_provenance', '缺少匹配的模型报告与研究员任务标识。')
  if (report.generatedBy || report.completionMode || report.delivery?.modelGenerated === false) return reject('program_receipt', '程序收尾回执不是模型实质报告。')
  if (reportOrigin === 'partialReport') {
    const audit = report.delivery
    if (audit?.mode !== 'validated-partial-model-report' || audit.modelGenerated !== true || audit.substantiveReportComplete !== false ||
      !['complete', 'insufficient'].includes(audit.originalStatus) || audit.originalProbabilityPreserved !== true ||
      !Number.isInteger(audit.rejectedCount) || audit.rejectedCount < 0) return reject('invalid_partial_audit', '部分模型报告缺少有效审计标记，或原报告明确受阻。')
  } else if (report.delivery?.mode) return reject('program_receipt', '程序交付回执不能替代正常模型报告。')
  if (failedAuditedPartial) gaps.push('该任务未完整完成；仅保留审计通过的模型主张与原概率，不代表任务已成功。')
  if (!validProbability(report.probability)) return reject('missing_model_probability', '模型没有提交0至1的有效概率，不补造概率。')
  const declared = new Set(report.evidenceIds || [])
  const ownSources = evidence.filter(source => source.runId === expectedRun && declared.has(source.evidenceId) &&
    hasText(source.text) && source.referenceable !== false && source.evidenceKind !== 'search_snippet' &&
    Number.isFinite(Date.parse(source.obtainedAt)) && Date.parse(source.obtainedAt) <= Date.parse(asOf) &&
    (!source.publishedAt || Number.isFinite(Date.parse(source.publishedAt)) && Date.parse(source.publishedAt) <= Date.parse(asOf)) &&
    source.readBy?.includes(item.assignmentId))
  const owned = new Set(ownSources.map(source => source.evidenceId))
  const sourceLimitations = [], validClaims = [], selected = { support: [], counterevidence: [] }
  for (const field of ['support', 'counterevidence']) for (const claim of report[field] || []) {
    if (!claim?.evidenceIds?.length || claim.evidenceIds.some(id => !owned.has(id))) return reject('unread_or_foreign_claim', '主张引用未由本人在同轮有效读取的正文。')
    let canonical
    try { [canonical] = validateGroundedClaims([claim], ownSources, { readerId: item.assignmentId, asOf }) }
    catch (error) { return reject('invalid_grounded_claim', error.message) }
    validClaims.push(canonical)
    if (!sourceLimitationClaim(canonical.claim) && claim.citations.some(citation => !accessOnlyExcerpt(citation.quote))) selected[field].push(canonical)
    else sourceLimitations.push(canonical)
  }
  const substantiveClaims = [...selected.support, ...selected.counterevidence]
  if (!substantiveClaims.length) return { ...reject('no_substantive_evidence', '仅有访问状态、免责声明、Cookie或更新时间等来源限制，不能支持实体事件的概率。'), sourceLimitations }
  const evidenceIds = [...new Set(substantiveClaims.flatMap(claim => claim.evidenceIds))]
  const quality = reportOrigin === 'partialReport' || report.status === 'insufficient' ? 'partial' : 'complete'
  return { ...structuredClone(item), report: { ...structuredClone(report), support: selected.support, counterevidence: selected.counterevidence, evidenceIds },
    reportOrigin, quality, eligibleReason: quality === 'partial' ? 'grounded_partial_model_estimate' : 'grounded_complete_model_estimate',
    gaps: [...gaps, ...(sourceLimitations.length ? ['仅涉及网页访问或法律声明的主张保留为来源限制，不计作实体依据。'] : [])],
    groundedClaims: validClaims, substantiveClaims, evidenceIds, sourceLimitations }
}

/** Select at most one real, grounded probability estimate per distinct role.
 * This returns evidence for a Main decision, never a probability or calibration
 * claim of its own. A caller must separately apply the explicit preset policy.
 */
export function selectExploratoryReports(assignments = [], evidence = [], options = {}) {
  const roles = new Map(), rejected = [], latestAttempt = new Map()
  for (const [index, item] of assignments.entries()) {
    latestAttempt.set(item.roleId, index)
    const origins = item.partialReport ? ['report', 'partialReport'] : ['report']
    for (const reportOrigin of origins) {
      const assessment = assess(item, reportOrigin, evidence, options)
      if (assessment.quality !== 'unusable') { roles.set(item.roleId, { assessment, index }); break }
      rejected.push(assessment)
    }
  }
  const usable = [...roles.values()].map(({ assessment, index }) => {
    if (latestAttempt.get(assessment.roleId) === index) return assessment
    return { ...assessment, latestAttemptRejected: true, gaps: [...assessment.gaps, '后续同职责任务没有可用模型估计，本次保留先前有据报告；并非后续核验已成功。'] }
  })
  return { usable, rejected, roleCount: usable.length,
    partialRoleCount: usable.filter(item => item.quality === 'partial').length,
    completeRoleCount: usable.filter(item => item.quality === 'complete').length,
    sourceLimitations: [...usable, ...rejected].flatMap(item => item.sourceLimitations || []),
    notice: '可用性仅核对模型产物、本人已读、引用与概率边界；原文匹配不等于语义正确，探索性估计仍需主Agent裁决、复核且不计分。' }
}
