import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pollPublicSources } from './sources.mjs'

const now = '2026-11-14T12:00:00Z'
const observedAt = '2026-11-14T12:00:00.000Z'
const conditionId = `0x${'a'.repeat(64)}`

const filingResponse = {
  filings: {
    recent: {
      form: ['8-K', '10-Q', '4', '10-K', '8-K'],
      accessionNumber: ['0001045810-26-000100', '0001045810-26-000099', '0001045810-26-000098', '0001045810-26-000001', '../unexpected'],
      filingDate: ['2026-11-13', '2026-11-14', '2026-11-13', '2026-01-15', '2026-11-13'],
      acceptanceDateTime: ['2026-11-13T19:03:00.000Z', '2026-11-14T13:00:00.000Z'],
      items: ['2.02,9.01,2.02'],
      primaryDocument: ['https://example.invalid/redirect'],
    },
  },
}

const market = {
  question: 'Will Nvidia be granted a license to export H200 chips to China?',
  slug: 'nvidia-exports-to-china',
  conditionId,
  active: true,
  closed: false,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.65","0.35"]',
  liquidityNum: '3300',
  bestBid: 0.62,
  bestAsk: 0.66,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-11-14 11:59:00+00',
  description: 'Resolves to Yes if the specified license is granted.',
}

test('polls fixed endpoints, publishes only vetted filings and contracts, and deduplicates results', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const endpoint = new URL(url)
    if (endpoint.hostname === 'data.sec.gov') {
      return endpoint.pathname.includes('CIK0001045810')
        ? Response.json(filingResponse)
        : Response.json(null, { status: 503 })
    }
    assert.equal(endpoint.hostname, 'gamma-api.polymarket.com')
    return Response.json({ events: [{
      slug: 'nvidia-exports-to-china',
      markets: [
        market,
        { ...market, closed: true, conditionId: `0x${'b'.repeat(64)}` },
        { ...market, question: 'Will Nvidia stock go up today?', conditionId: `0x${'c'.repeat(64)}` },
        { ...market, question: 'Will the US ban exports of potato chips?', conditionId: `0x${'d'.repeat(64)}` },
        { ...market, slug: '../untrusted', conditionId: `0x${'e'.repeat(64)}` },
        { ...market, endDate: '2026-11-13T12:00:00Z', conditionId: `0x${'f'.repeat(64)}` },
      ],
    }] })
  }
  const result = await pollPublicSources({ fetchImpl, now, secUserAgent: 'WorldLab tests tests@example.invalid' })

  assert.equal(calls.length, 6)
  assert(calls.every(({ options }) => options.redirect === 'error'))
  assert.equal(calls[0].options.headers['User-Agent'], 'WorldLab tests tests@example.invalid')
  assert.deepEqual(result.sources.map((source) => [source.id, source.status, source.itemCount]), [
    ['sec_edgar', 'live', 1], ['polymarket', 'live', 1],
  ])
  assert.match(result.sources[0].message, /1 项查询暂不可用/)
  assert.deepEqual(result.sources[0].coveredSymbols, ['NVDA'])
  assert.deepEqual(result.sources.map(({ complete }) => complete), [false, true])
  const [filing, contract] = result.items
  assert.equal(filing.url, 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000100/0001045810-26-000100-index.htm')
  assert.deepEqual(filing.filing, {
    form: '8-K', items: ['2.02', '9.01'], filingDate: '2026-11-13', acceptanceAt: '2026-11-13T19:03:00.000Z',
  })
  assert.deepEqual(contract.symbols, ['NVDA'])
  assert.equal(contract.url, 'https://polymarket.com/event/nvidia-exports-to-china')
  assert.equal(contract.publishedAt, null)
  assert.equal(contract.observedAt, observedAt)
  assert.equal(contract.market.yesPrice, 0.65)
  assert.equal(contract.market.quoteTimestamp, null)
  assert.equal(contract.market.recordUpdatedAt, '2026-11-14T11:59:00.000Z')
})

test('ranks export policy, skips earnings-call word markets, and limits repeated threshold contracts', async () => {
  const ladder = ['57', '58', '59'].map((threshold, index) => ({
    ...market,
    conditionId: `0x${String(index + 1).repeat(64)}`,
    question: `Will Nvidia revenue exceed $${threshold} billion?`,
    slug: `nvidia-revenue-${threshold}`,
    liquidityNum: 30_000 - index * 1_000,
  }))
  const fetchImpl = async (url) => {
    if (url.includes('data.sec.gov')) return Response.json(filingResponse)
    return Response.json({ events: [
      { slug: 'nvidia-revenue', markets: ladder },
      { slug: 'nvidia-earnings-call', markets: [
        { ...market, conditionId: `0x${'b'.repeat(64)}`, slug: 'say-openai', question: 'Will Nvidia say “OpenAI” on the earnings call?', liquidityNum: 300_000 },
        { ...market, conditionId: `0x${'c'.repeat(64)}`, slug: 'mention-export', question: 'Will Nvidia mention H200 exports during earnings?', liquidityNum: 300_000 },
      ] },
      { slug: 'amd-revenue', markets: [
        { ...market, conditionId: `0x${'d'.repeat(64)}`, slug: 'amd-revenue', question: 'Will AMD beat quarterly revenue expectations?', liquidityNum: 500 },
      ] },
      { slug: 'nvidia-exports-to-china', markets: [{ ...market, liquidityNum: 200 }] },
    ] })
  }

  const { items } = await pollPublicSources({ fetchImpl, now })
  const contracts = items.filter(({ kind }) => kind === 'prediction_market')
  assert.deepEqual(contracts.map(({ market }) => [market.slug, market.relevance]), [
    ['nvidia-exports-to-china', 'export_policy'],
    ['nvidia-revenue-57', 'company_operation'],
    ['amd-revenue', 'company_operation'],
    ['nvidia-revenue-58', 'company_operation'],
  ])
  assert.equal(new Set(contracts.map(({ id }) => id)).size, contracts.length)
})

test('separates timed-out SEC checks from a successful Polymarket search with no matches', async () => {
  const fetchImpl = (url, { signal }) => {
    if (url.includes('polymarket.com')) return Response.json({ events: null, pagination: { totalResults: 0 } })
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const { sources, items } = await pollPublicSources({ fetchImpl, now, timeoutMs: 15 })

  assert.deepEqual(items, [])
  assert.deepEqual(sources.map(({ status, lastSuccessAt }) => [status, lastSuccessAt]), [
    ['unavailable', null], ['no_match', observedAt],
  ])
  assert.deepEqual(sources[0].coveredSymbols, [])
})

test('records a successful empty SEC response as covered independently of the other issuer', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('CIK0001045810')) return Response.json({ filings: { recent: { form: [], accessionNumber: [], filingDate: [] } } })
    if (url.includes('data.sec.gov')) return Response.json(null, { status: 503 })
    return Response.json({ events: [] })
  }
  const { sources, items } = await pollPublicSources({ fetchImpl, now })

  assert.deepEqual(items, [])
  assert.deepEqual(sources[0].coveredSymbols, ['NVDA'])
  assert.equal(sources[0].status, 'unavailable')
  assert.equal(sources[0].lastSuccessAt, observedAt)
})
