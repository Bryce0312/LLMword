import test from 'node:test'
import assert from 'node:assert/strict'
import { marketPricePair, reviewMarketReport } from './market-report.mjs'

const report = () => ({ status: 'complete', summary: '看到了公开价格材料。', evidenceIds: ['quote_btc'],
  support: [], counterevidence: [], missingEvidence: [], probability: 0.6, nextSuggestion: '' })
const quote = (pair, readerId = 'market_1', evidenceId = 'quote_btc') => ({ evidenceId,
  readBy: [readerId], marketQuote: { pair, value: 100, currency: 'USD', observedAt: '2026-11-20T00:00:00.000Z' } })

test('market report keeps a cited matching quote from the same worker', () => {
  const original = report()
  assert.equal(reviewMarketReport({ question: '比特币会涨吗', report: original, evidence: [quote('BTC-USD')], readerId: 'market_1' }), original)
})

test('a wrong-asset or another worker quote cannot certify the market report', () => {
  for (const evidence of [[quote('ETH-USD')], [quote('BTC-USD', 'statistics_1')], []]) {
    const checked = reviewMarketReport({ question: '比特币会跌吗', report: report(), evidence, readerId: 'market_1' })
    assert.equal(checked.status, 'insufficient')
    assert.equal(checked.probability, null)
    assert.match(checked.missingEvidence[0], /BTC-USD/)
    assert.match(checked.summary, /基准未确认/)
  }
})

test('an uncited quote is not a verified market baseline', () => {
  const original = report()
  original.evidenceIds = ['other_source']
  const checked = reviewMarketReport({ question: 'BTC price up?', report: original, evidence: [quote('BTC-USD')], readerId: 'market_1' })
  assert.equal(checked.status, 'insufficient')
})

test('market quotes must have USD units and observation time within this investigation', () => {
  for (const changed of [{ currency: 'EUR' }, { value: 0 }, { observedAt: 'invalid' }, { observedAt: '2026-11-21T00:00:00Z' }, { observedAt: '2026-11-19T00:00:00Z' }]) {
    const source = quote('BTC-USD'); Object.assign(source.marketQuote, changed)
    const checked = reviewMarketReport({ question: 'BTC会跌吗', report: report(), evidence: [source], readerId: 'market_1', asOf: '2026-11-20T01:00:00Z', notBefore: '2026-11-20T00:00:00Z' })
    assert.equal(checked.status, 'insufficient'); assert.equal(checked.probability, null)
  }
})

test('non-directional and unsupported or ambiguous assets keep their existing report', () => {
  assert.equal(marketPricePair('以太坊会下跌吗'), 'ETH-USD')
  assert.equal(marketPricePair('ETH未来价格是否高于现在？'), 'ETH-USD')
  assert.equal(marketPricePair('Will BTC increase?'), 'BTC-USD')
  assert.equal(marketPricePair('黄金会跌吗'), null)
  assert.equal(marketPricePair('BTC和ETH哪个涨得快'), null)
  for (const question of ['黄金会跌吗', '比特币会上交易所吗', 'BTC和ETH哪个涨得快']) {
    const original = report()
    assert.equal(reviewMarketReport({ question, report: original, evidence: [], readerId: 'market_1' }), original)
  }
})
