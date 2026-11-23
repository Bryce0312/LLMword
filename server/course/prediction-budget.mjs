import { domainFailure } from '../domain/contracts.mjs'

export const DEFAULT_PREDICTION_BUDGET = Object.freeze({ mode: 'limited', maxTotalTokens: 1000000 })
export const PREDICTION_BUDGET_PRESETS = Object.freeze([100000, 300000, 500000, 1000000])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => domainFailure('INVALID_PREDICTION_BUDGET', '预测预算须为正安全整数，或选择不限总 token；不支持其他设置字段。', 400)

export function validatePredictionBudget(value) {
  if (!object(value) || Object.keys(value).some(key => !['mode', 'maxTotalTokens'].includes(key))) throw invalid()
  if (value.mode === 'unlimited' && (value.maxTotalTokens === null || value.maxTotalTokens === undefined)) return { mode: 'unlimited', maxTotalTokens: null }
  if (value.mode === 'limited' && Number.isSafeInteger(value.maxTotalTokens) && value.maxTotalTokens > 0) return { mode: 'limited', maxTotalTokens: value.maxTotalTokens }
  throw invalid()
}
export function validatePredictionSettings(value) {
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'predictionBudget')) throw invalid()
  return { predictionBudget: validatePredictionBudget(value.predictionBudget) }
}

/** Missing legacy limits keep their historical fallback; explicit null always means unlimited. */
export function totalTokenLimit(budget) { return budget?.maxTotalTokens === null ? null : budget?.maxTotalTokens ?? 120000 }
export function remainingTotalTokens(budget, used) { const limit = totalTokenLimit(budget); return limit === null ? null : Math.max(0, limit - used) }
export function totalTokenLimitReached(budget, used) { const limit = totalTokenLimit(budget); return limit !== null && used >= limit }
export function totalTokenLimitExceeded(budget, used) { const limit = totalTokenLimit(budget); return limit !== null && used > limit }
export function boundedOutputTokens(budget, used) {
  const remaining = remainingTotalTokens(budget, used)
  return remaining === null ? budget.maxTokens : Math.max(1, Math.min(budget.maxTokens, remaining))
}
