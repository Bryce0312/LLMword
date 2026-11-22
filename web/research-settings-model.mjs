export const DEFAULT_PREDICTION_TOKEN_BUDGET = 1000000
export const PREDICTION_TOKEN_BUDGET_PRESETS = Object.freeze([100000, 300000, 500000, 1000000])

const invalidBudget = () => Object.assign(new Error('请输入正整数 token 预算，例如 1000000。'), { code: 'INVALID_PREDICTION_BUDGET' })

export function predictionBudgetPayload(mode, text) {
  if (mode === 'unlimited') return { predictionBudget: { mode, maxTotalTokens: null } }
  const raw = String(text ?? '').trim()
  const amount = Number(raw)
  if (mode !== 'limited' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(amount) || amount <= 0) throw invalidBudget()
  return { predictionBudget: { mode, maxTotalTokens: amount } }
}

export function createPredictionBudgetEditor() {
  return { mode: 'limited', limitText: String(DEFAULT_PREDICTION_TOKEN_BUDGET), dirty: false, saved: null }
}

/** A delayed read updates the saved baseline without replacing an in-progress edit. */
export function receivePredictionBudget(editor, value, { committed = false } = {}) {
  const budget = value?.predictionBudget
  if (!budget || !['limited', 'unlimited'].includes(budget.mode) || (budget.mode === 'unlimited' ? budget.maxTotalTokens !== null : !Number.isSafeInteger(budget.maxTotalTokens) || budget.maxTotalTokens <= 0)) throw new Error('服务返回的预算配置不完整，请重新读取。')
  const saved = { mode: budget.mode, maxTotalTokens: budget.maxTotalTokens }
  if (editor.dirty && !committed) return { ...editor, saved }
  return { ...editor, mode: saved.mode, limitText: saved.mode === 'limited' ? String(saved.maxTotalTokens) : editor.limitText, dirty: false, saved }
}

const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validRates = (value) => value && ['inputCacheHit', 'inputCacheMiss', 'output'].every(key => validRate(value[key]))
const rateValues = (value) => [value.inputCacheHit, value.inputCacheMiss, value.output].map(amount => amount.toLocaleString('zh-CN', { maximumFractionDigits: 8 })).join(' / ')

/** Prices come only from the current connection; an unknown charge is never zero. */
export function researchPricingPresentation(connection = {}) {
  connection = connection && typeof connection === 'object' ? connection : {}
  const pricing = connection.pricing
  const model = typeof connection.model === 'string' && connection.model ? connection.model : typeof pricing?.model === 'string' ? pricing.model : ''
  const base = { model, status: 'unavailable', rows: [], sourceUrl: null, checkedAt: null, schedule: null }
  if (!pricing) return { ...base, message: connection.connection === 'connected' ? '当前模型价格未公开' : '连接模型后更新价格' }
  if (pricing.status === 'loading') return { ...base, status: 'loading', message: '正在更新当前模型价格…' }
  if (pricing.status !== 'available') return { ...base, message: typeof pricing.reason === 'string' && pricing.reason ? pricing.reason : '当前模型价格未公开' }
  if (!model || pricing.model !== model || !Number.isSafeInteger(pricing.unitTokens) || pricing.unitTokens <= 0 || typeof pricing.currency !== 'string' || !pricing.currency) return { ...base, message: '当前模型价格未公开' }
  let rows
  if (pricing.ratePeriod === 'tiered') {
    if (!validRates(pricing.rateTiers?.offPeak) || !validRates(pricing.rateTiers?.peak)) return { ...base, message: '分时价格资料不完整，暂不展示单价' }
    rows = [{ label: '谷档', values: rateValues(pricing.rateTiers.offPeak) }, { label: '峰档', values: rateValues(pricing.rateTiers.peak) }]
  } else {
    if (!validRates(pricing)) return { ...base, message: '当前模型价格未公开' }
    rows = [{ label: '单价', values: rateValues(pricing) }]
  }
  return { ...base, status: 'available', message: '', rows,
    unit: pricing.currency + ' / ' + pricing.unitTokens.toLocaleString('zh-CN') + ' tokens',
    periodLabel: pricing.ratePeriodLabel || '', schedule: typeof pricing.schedule === 'string' ? pricing.schedule : null,
    sourceUrl: typeof pricing.sourceUrl === 'string' && /^https?:\/\//i.test(pricing.sourceUrl) ? pricing.sourceUrl : null,
    checkedAt: Number.isFinite(Date.parse(pricing.checkedAt)) ? pricing.checkedAt : null }
}
