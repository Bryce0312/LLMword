import assert from 'node:assert/strict'
import test from 'node:test'
import { identifyTradingMarket, tradingMarketTimezone, buildTradingHorizon } from './trading-calendar.mjs'

test('the original NVIDIA name-only question selects a disclosed US calendar hint before its horizon is frozen', () => {
  for (const question of ['英伟达股票走势', '英伟达', '请帮我分析英伟达股票未来三天会不会涨？', 'NVIDIA', 'nvidia stock trend', 'NVIDIA Corporation']) {
    const selected = identifyTradingMarket(question)
    assert.equal(selected.market, 'US', question)
    assert.equal(selected.selection, 'name-hint', question)
    assert(selected.assumptions.some(text => text.includes('只是日历线索') && text.includes('仍需研究员核验')), question)
    assert.equal(tradingMarketTimezone(question), 'America/New_York', question)
  }
  const horizon = buildTradingHorizon({ question: '英伟达股票走势', tradingDays: 3, createdAt: '2026-11-22T08:33:20.743Z' })
  assert.equal(horizon.market, 'US')
  assert.equal(horizon.marketSelection, 'name-hint')
  assert.equal(horizon.timezone, 'America/New_York')
  assert.equal(horizon.targetAt, '2026-11-25T21:00:00.000Z')
  assert.deepEqual(horizon.sessions.map(session => session.date), ['2026-11-23', '2026-11-24', '2026-11-25'])
})

test('explicit market selections and existing code-conflict rules are not overwritten by the NVIDIA hint', () => {
  for (const question of ['英伟达股票走势', 'NVIDIA']) {
    const selected = identifyTradingMarket(question, 'HK')
    assert.equal(selected.market, 'HK')
    assert.equal(selected.selection, 'retry-context')
    assert(selected.assumptions.some(text => text.includes('不是上市地已经核验')))
  }
  assert.equal(identifyTradingMarket('英伟达相关港股').market, 'HK')
  assert.equal(identifyTradingMarket('英伟达A股概念股').market, 'CN')
  assert.equal(identifyTradingMarket('NVDA').selection, 'identified')
  assert.throws(() => identifyTradingMarket('NVDA', 'HK'), { code: 'TRADING_MARKET_CONFLICT' })
  assert.throws(() => identifyTradingMarket('NVDA 9988.HK'), { code: 'TRADING_MARKET_CONFLICT' })
})

test('ambiguous listings and multi-company questions do not acquire the narrow US name hint', () => {
  for (const question of ['阿里巴巴', '腾讯控股', '台积电', '英伟达与阿里巴巴股票比较', 'NVIDIA 与腾讯比较', '英伟达相关概念基金']) {
    const selected = identifyTradingMarket(question)
    assert.equal(selected.market, 'HK', question)
    assert.equal(selected.selection, 'default', question)
  }
})
