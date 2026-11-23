/** Deterministic forecast facts derived only from controlled fields, never model text.
 *  The free-form forecast.summary is model prose and may contradict the structured
 *  fields (baseline / kind / scoring). These helpers produce the authoritative fact
 *  segment, detect high-confidence contradictions, and a short status label that is
 *  reused by the store, the memory projection and the frontend. No IO, no model text. */

const clip = (text, max = 200) => (typeof text === 'string' ? text.slice(0, max) : '')

export function buildForecastFacts({ baseline = null, kind = 'forecast', scoringEligible = false, evidenceAdequacy = 'limited', targetAt = null, timeContext = null } = {}) {
  const facts = []
  const verifiedNumber = baseline?.verified === true && Number.isFinite(baseline?.value) && baseline.value > 0
  if (baseline?.synthetic) {
    facts.push({ key: 'baseline', label: '基准', text: '合成／模拟基准，不可计分', status: 'synthetic' })
  } else if (verifiedNumber) {
    const pair = clip(baseline.pair)
    const unit = clip(baseline.unit || baseline.currency)
    facts.push({ key: 'baseline', label: '基准', text: `${pair ? pair + ' ' : ''}${baseline.value}${unit ? ' ' + unit : ''}（系统观测）`, status: 'verified', value: baseline.value, pair, unit })
  } else {
    facts.push({ key: 'baseline', label: '基准', text: '未取得可核验数值基准', status: 'unverified' })
  }
  const conditional = kind === 'conditional_estimate'
  facts.push({ key: 'kind', label: '估计类型', text: conditional ? '条件估计' : '概率预测', status: conditional ? 'conditional' : 'forecast' })
  facts.push({ key: 'scoring', label: '计分', text: scoringEligible ? '可计分' : '不计分', status: scoringEligible ? 'eligible' : 'ineligible' })
  facts.push({ key: 'adequacy', label: '资料充分度', text: evidenceAdequacy === 'adequate' ? '充分' : '有限', status: evidenceAdequacy === 'adequate' ? 'adequate' : 'limited' })
  const target = clip(timeContext?.targetAtLocalLabel || targetAt)
  if (target) facts.push({ key: 'target', label: '固定到期', text: target, status: 'info' })
  return facts
}

// Conservative, high-confidence signals only. The authoritative protection is the
// fact segment itself; these patterns only annotate obvious contradictions, so false
// negatives are preferred over wrongly flagging an honest summary.
const NUMERIC_PRICE = [
  /现价\s*[:：]?\s*\d/, /报价\s*[:：]?\s*\d/, /价格\s*[:：]?\s*\d/, /基准价?\s*[:：]?\s*\d/,
  /\$\s*\d/, /￥\s*\d/, /\d+(?:\.\d+)?\s*(?:美元|元|USD|USDT|CNY)/i, /USD\s*\d/i,
]
const VERIFIED_CLAIM = [/已核验/, /已核实/, /已核对/, /官方确认/, /确认.*基准/, /基准.*确认/]
const SCORING_CLAIM = [/可计分/, /计入评分/]

export function detectSummaryConflict(summary = '', { baselineVerified = false, baselineValue = null, scoringEligible = false } = {}) {
  const reasons = []
  if (typeof summary !== 'string' || !summary.trim()) return { detected: false, reasons }
  const verifiedNumber = baselineVerified === true && Number.isFinite(baselineValue) && baselineValue > 0
  if (!verifiedNumber) {
    if (NUMERIC_PRICE.some((re) => re.test(summary))) reasons.push('基准未核验，但摘要出现具体价格断言')
    if (VERIFIED_CLAIM.some((re) => re.test(summary))) reasons.push('基准未核验，但摘要声称已核验或固定基准')
  }
  if (!scoringEligible && SCORING_CLAIM.some((re) => re.test(summary))) reasons.push('本题不计分，但摘要声称可计分')
  return { detected: reasons.length > 0, reasons }
}

export function forecastStatusLabel({ kind = 'forecast', scoringEligible = false, baselineVerified = false } = {}) {
  const parts = [kind === 'conditional_estimate' ? '条件估计' : '概率预测']
  if (baselineVerified === false) parts.push('基准未核验')
  parts.push(scoringEligible ? '可计分' : '不计分')
  return parts.join(' · ')
}

export function deriveForecastStatus(forecast = {}) {
  const baseline = forecast.baseline ?? null
  const baselineVerified = baseline?.verified === true && Number.isFinite(baseline?.value) && baseline.value > 0
  const kind = forecast.kind ?? 'forecast'
  const scoringEligible = forecast.scoringEligible === true
  const statusFacts = buildForecastFacts({ baseline, kind, scoringEligible, evidenceAdequacy: forecast.evidenceAdequacy, targetAt: forecast.targetAt, timeContext: forecast.timeContext })
  const summaryConflict = detectSummaryConflict(forecast.summary, { baselineVerified, baselineValue: baseline?.value ?? null, scoringEligible })
  const statusLabel = forecastStatusLabel({ kind, scoringEligible, baselineVerified })
  return { statusFacts, summaryConflict, baselineVerified, conditionalOnly: kind === 'conditional_estimate', statusLabel }
}
