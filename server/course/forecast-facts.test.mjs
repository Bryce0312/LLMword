import test from 'node:test'
import assert from 'node:assert/strict'
import { buildForecastFacts, detectSummaryConflict, forecastStatusLabel, deriveForecastStatus } from './forecast-facts.mjs'

test('unverified baseline builds an unverified fact segment that never invents a number', () => {
  const facts = buildForecastFacts({ baseline: { kind: 'directional', value: null, verified: false }, kind: 'conditional_estimate', scoringEligible: false, evidenceAdequacy: 'limited', targetAt: '2026-11-19T15:59:59.999Z', timeContext: { targetAtLocalLabel: '2026-11-19 23:59 (Asia/Shanghai, UTC+08)' } })
  const baseline = facts.find((f) => f.key === 'baseline')
  assert.equal(baseline.status, 'unverified')
  assert.doesNotMatch(baseline.text, /\d/)
  assert.equal(facts.find((f) => f.key === 'kind').status, 'conditional')
  assert.equal(facts.find((f) => f.key === 'scoring').text, '不计分')
})

test('verified numeric baseline surfaces the concrete price in the fact segment', () => {
  const facts = buildForecastFacts({ baseline: { kind: 'price', pair: 'BTC-USD', value: 63091.745, unit: 'USD', verified: true }, kind: 'forecast', scoringEligible: true, evidenceAdequacy: 'adequate' })
  const baseline = facts.find((f) => f.key === 'baseline')
  assert.equal(baseline.status, 'verified')
  assert.match(baseline.text, /63091\.745/)
  assert.equal(facts.find((f) => f.key === 'scoring').text, '可计分')
})

test('conflict detector flags a numeric price assertion when the baseline is unverified', () => {
  const result = detectSummaryConflict('黄金现价 3000 美元，已核验固定基准。', { baselineVerified: false, baselineValue: null, scoringEligible: false })
  assert.equal(result.detected, true)
  assert(result.reasons.some((r) => r.includes('价格')))
})

test('conflict detector flags a scorable claim when the forecast is not scorable', () => {
  const result = detectSummaryConflict('本轮判断可计分。', { baselineVerified: true, baselineValue: 100, scoringEligible: false })
  assert.equal(result.detected, true)
  assert(result.reasons.some((r) => r.includes('计分')))
})

test('conflict detector stays quiet for a matching honest summary', () => {
  const result = detectSummaryConflict('BTC-USD 基准 63091.745 USD 已观测。', { baselineVerified: true, baselineValue: 63091.745, scoringEligible: true })
  assert.equal(result.detected, false)
})

test('status label composes the authoritative markers', () => {
  assert.equal(forecastStatusLabel({ kind: 'conditional_estimate', scoringEligible: false, baselineVerified: false }), '条件估计 · 基准未核验 · 不计分')
  assert.equal(forecastStatusLabel({ kind: 'forecast', scoringEligible: true, baselineVerified: true }), '概率预测 · 可计分')
})

test('deriveForecastStatus derives from a stored forecast record and preserves the raw summary', () => {
  const forecast = { summary: '黄金现价 3000 美元。', kind: 'conditional_estimate', scoringEligible: false, baseline: { kind: 'directional', value: null, verified: false }, evidenceAdequacy: 'limited', targetAt: '2026-11-19T15:59:59.999Z', timeContext: { targetAtLocalLabel: '2026-11-19 23:59 (Asia/Shanghai, UTC+08)' } }
  const derived = deriveForecastStatus(forecast)
  assert.equal(derived.baselineVerified, false)
  assert.equal(derived.conditionalOnly, true)
  assert.equal(derived.summaryConflict.detected, true)
  assert.equal(derived.statusLabel, '条件估计 · 基准未核验 · 不计分')
  assert.equal(derived.statusFacts.find((f) => f.key === 'baseline').status, 'unverified')
  assert.equal(forecast.summary, '黄金现价 3000 美元。')
})
