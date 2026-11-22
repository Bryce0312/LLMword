const btc = /比特币|\bBTC\b|bitcoin/i
const eth = /以太|\bETH\b|ethereum/i
const direction = /回升|上涨|涨|走高|高于|下跌|下滑|跌|回落|走低|下降|低于|\b(?:rise|rises|rising|recover|up|fall|falls|falling|drop|drops|decline|decrease|increase|increases|higher|lower|above|below|down)\b/i

export function marketPricePair(question = '') {
  if (!direction.test(question)) return null
  const hasBtc = btc.test(question)
  const hasEth = eth.test(question)
  if (hasBtc === hasEth) return null
  return hasBtc ? 'BTC-USD' : 'ETH-USD'
}

/** A market report may only claim a fixed spot baseline it actually read and cited. */
export function reviewMarketReport({ question, report, evidence = [], readerId, asOf, notBefore }) {
  const pair = marketPricePair(question)
  if (!pair || report.status === 'blocked') return report
  const quote = evidence.find((item) => item.marketQuote?.pair === pair &&
    Number.isFinite(item.marketQuote.value) && item.marketQuote.value > 0 &&
    Number.isFinite(Date.parse(item.marketQuote.observedAt)) &&
    (!asOf || Date.parse(item.marketQuote.observedAt) <= Date.parse(asOf)) &&
    (!notBefore || Date.parse(item.marketQuote.observedAt) >= Date.parse(notBefore)) &&
    item.marketQuote.currency === 'USD' &&
    item.readBy?.includes(readerId) && report.evidenceIds.includes(item.evidenceId))
  if (quote) return report
  const gap = `市场研究员未在本轮引用可核验的 ${pair} 现价快照；价格基准未确认。`
  return {
    ...report,
    status: 'insufficient',
    summary: gap,
    probability: null,
    missingEvidence: [...new Set([...(report.missingEvidence || []), gap])],
  }
}
