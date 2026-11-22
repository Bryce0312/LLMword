export const PRICE_DIRECTION = 'price_direction'
export const priceDirections = [
  { outcome: 'up', key: 'probabilityUp', label: '上涨', color: '#38735d' },
  { outcome: 'flat', key: 'probabilityFlat', label: '持平', color: '#826228' },
  { outcome: 'down', key: 'probabilityDown', label: '下跌', color: '#a74e42' },
]

export function validDirectionProbabilities(value) {
  const probabilities = priceDirections.map(({ key }) => value?.[key])
  return probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1) &&
    Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) <= 1e-9
}

export const directionFields = value => Object.fromEntries(priceDirections.map(({ key }) => [key, value[key]]))
export const isPriceDirection = value => value?.type === PRICE_DIRECTION || value?.forecastType === PRICE_DIRECTION
export const directionLabel = outcome => priceDirections.find(item => item.outcome === outcome)?.label
export const formatProbability = value => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(value) : '—'
export const directionText = value => priceDirections.map(({ key, label }) => label + ' ' + formatProbability(value?.[key])).join(' · ')
