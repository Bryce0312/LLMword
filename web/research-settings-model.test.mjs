import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PREDICTION_TOKEN_BUDGET, PREDICTION_TOKEN_BUDGET_PRESETS, predictionBudgetPayload, createPredictionBudgetEditor, receivePredictionBudget, researchPricingPresentation } from './research-settings-model.mjs'

test('prediction budget accepts positive integer custom amounts and represents unlimited explicitly', () => {
  assert.equal(DEFAULT_PREDICTION_TOKEN_BUDGET, 1000000)
  assert.deepEqual(PREDICTION_TOKEN_BUDGET_PRESETS, [100000, 300000, 500000, 1000000])
  for (const amount of [...PREDICTION_TOKEN_BUDGET_PRESETS, 250001]) assert.deepEqual(predictionBudgetPayload('limited', String(amount)), { predictionBudget: { mode: 'limited', maxTotalTokens: amount } })
  for (const amount of ['', '0', '-1', '1.5', '1e6', 'NaN', 'Infinity', '01', '9007199254740992']) assert.throws(() => predictionBudgetPayload('limited', amount), { code: 'INVALID_PREDICTION_BUDGET' })
  assert.throws(() => predictionBudgetPayload('other', '1000000'), { code: 'INVALID_PREDICTION_BUDGET' })
  assert.deepEqual(predictionBudgetPayload('unlimited', 'last finite input does not matter'), { predictionBudget: { mode: 'unlimited', maxTotalTokens: null } })
})

test('delayed settings reads preserve edited mode and amount while tracking the saved baseline', () => {
  const initial = createPredictionBudgetEditor()
  assert.equal(initial.limitText, '1000000')
  const saved = receivePredictionBudget(initial, { predictionBudget: { mode: 'limited', maxTotalTokens: 300000 } })
  assert.equal(saved.limitText, '300000')
  const edited = { ...saved, mode: 'unlimited', limitText: '750001', dirty: true }
  const late = receivePredictionBudget(edited, { predictionBudget: { mode: 'limited', maxTotalTokens: 500000 } })
  assert.equal(late.mode, 'unlimited')
  assert.equal(late.limitText, '750001')
  assert.equal(late.dirty, true)
  assert.equal(late.saved.maxTotalTokens, 500000)
  const committed = receivePredictionBudget(late, { predictionBudget: { mode: 'unlimited', maxTotalTokens: null } }, { committed: true })
  assert.equal(committed.dirty, false)
  assert.equal(committed.limitText, '750001', 'the last finite amount remains available when switching back')
  assert.deepEqual(committed.saved, { mode: 'unlimited', maxTotalTokens: null })
  assert.equal(edited.limitText, '750001', 'receiving data does not mutate an existing editor snapshot')
})

test('malformed saved budgets fail visibly instead of replacing state with a guessed default', () => {
  for (const predictionBudget of [null, {}, { mode: 'limited', maxTotalTokens: null }, { mode: 'limited', maxTotalTokens: '1000000' }, { mode: 'limited', maxTotalTokens: 0 }, { mode: 'unlimited', maxTotalTokens: 1000000 }]) assert.throws(() => receivePredictionBudget(createPredictionBudgetEditor(), { predictionBudget }))
})

const tieredConnection = () => ({ model: 'deepseek-flash', connection: 'connected', pricing: {
  status: 'available', model: 'deepseek-flash', currency: 'USD', unitTokens: 1000000,
  ratePeriod: 'tiered', ratePeriodLabel: '分时计价', inputCacheHit: null, inputCacheMiss: null, output: null,
  rateTiers: { offPeak: { inputCacheHit: 0.01, inputCacheMiss: 0.1, output: 0.2 }, peak: { inputCacheHit: 0.02, inputCacheMiss: 0.3, output: 0.4 } },
  schedule: '以供应商公开的峰谷时段为准', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', checkedAt: '2026-11-22T08:00:00Z',
} })

test('public pricing presents both time tiers without implying a single currently effective rate', () => {
  const view = researchPricingPresentation(tieredConnection())
  assert.equal(view.status, 'available')
  assert.equal(view.unit, 'USD / 1,000,000 tokens')
  assert.deepEqual(view.rows, [{ label: '谷档', values: '0.01 / 0.1 / 0.2' }, { label: '峰档', values: '0.02 / 0.3 / 0.4' }])
  assert.equal(view.periodLabel, '分时计价')
  assert.equal(view.checkedAt, '2026-11-22T08:00:00Z')
  assert.match(view.sourceUrl, /^https:/)
  assert.match(view.schedule, /供应商/)
})

test('campus, unknown, loading, mismatched, and incomplete prices never become invented free or official rates', () => {
  assert.equal(researchPricingPresentation().message, '连接模型后更新价格')
  assert.equal(researchPricingPresentation(null).message, '连接模型后更新价格')
  const campus = researchPricingPresentation({ model: 'DeepSeek-V4-Flash', connection: 'connected', pricing: { status: 'unavailable', model: 'DeepSeek-V4-Flash', reason: '校园收费未公开', inputCacheHit: null, inputCacheMiss: null, output: null } })
  assert.equal(campus.status, 'unavailable')
  assert.equal(campus.message, '校园收费未公开')
  assert.deepEqual(campus.rows, [])
  assert.equal(researchPricingPresentation({ model: 'a', pricing: { status: 'loading' } }).status, 'loading')
  const mismatch = tieredConnection(); mismatch.model = 'custom-model'
  assert.equal(researchPricingPresentation(mismatch).status, 'unavailable')
  const incomplete = tieredConnection(); delete incomplete.pricing.rateTiers.peak
  assert.equal(researchPricingPresentation(incomplete).status, 'unavailable')
  const invalid = tieredConnection(); invalid.pricing.rateTiers.peak.output = null
  assert.equal(researchPricingPresentation(invalid).status, 'unavailable')
})

test('non-tiered explicit rates may contain a verified zero and unsafe source URLs are not rendered', () => {
  const connection = { model: 'custom', pricing: { status: 'available', model: 'custom', currency: 'USD', unitTokens: 1000000, inputCacheHit: 0, inputCacheMiss: 1, output: 2, sourceUrl: 'javascript:doNotRun()', checkedAt: 'invalid' } }
  const view = researchPricingPresentation(connection)
  assert.equal(view.status, 'available')
  assert.equal(view.rows[0].values, '0 / 1 / 2')
  assert.equal(view.sourceUrl, null)
  assert.equal(view.checkedAt, null)
})
