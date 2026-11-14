export const PUBLIC_SOURCE_IDS = Object.freeze(['sec_edgar', 'polymarket'])

const issuers = [
  { symbol: 'NVDA', name: 'NVIDIA', cik: '0001045810' },
  { symbol: 'AMD', name: 'AMD', cik: '0000002488' },
]
const filingForms = {
  '8-K': '临时公告',
  '10-Q': '季度报告',
  '10-K': '年度报告',
}
const marketQueries = ['Nvidia', 'AMD', 'chip exports', 'H200']
const filingLookbackMs = 45 * 24 * 60 * 60 * 1000

function dateTime(value) {
  if (typeof value !== 'string') return null
  const iso = value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null
  const timestamp = Date.parse(iso)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function seenDate(value, observedAt) {
  const timestamp = dateTime(value)
  return timestamp && timestamp <= observedAt ? timestamp : null
}

function plainText(value, length) {
  return typeof value === 'string'
    ? value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, length)
    : ''
}

function getNumber(value, max = Infinity) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null
}

async function requestJson(url, { fetchImpl, signal, timeoutMs }, headers = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    if (controller.signal.aborted) throw controller.signal.reason
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json', ...headers },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function readFilings(issuer, options) {
  const endpoint = `https://data.sec.gov/submissions/CIK${issuer.cik}.json`
  const payload = await requestJson(endpoint, options, { 'User-Agent': options.secUserAgent })
  const recent = payload?.filings?.recent
  if (!Array.isArray(recent?.form) || !Array.isArray(recent?.accessionNumber) || !Array.isArray(recent?.filingDate)) {
    throw new Error('Invalid submissions payload')
  }

  const observedAt = options.clock()
  const oldestDate = new Date(Date.parse(observedAt) - filingLookbackMs).toISOString().slice(0, 10)
  const items = []
  for (const [index, form] of recent.form.entries()) {
    const baseForm = typeof form === 'string' ? form.replace(/\/A$/, '') : ''
    const filingDate = recent.filingDate[index]
    const accession = recent.accessionNumber[index]
    if (!Object.hasOwn(filingForms, baseForm) || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) continue
    if (filingDate < oldestDate || filingDate > observedAt.slice(0, 10)) continue
    const publishedAt = dateTime(recent.acceptanceDateTime?.[index])
    if (publishedAt && publishedAt > observedAt) continue
    const cik = String(Number(issuer.cik))
    const directory = accession.replaceAll('-', '')
    const itemCodes = typeof recent.items?.[index] === 'string' ? recent.items[index].match(/\b\d\.\d{2}\b/g) : null
    items.push({
      id: `sec:${issuer.symbol}:${accession}`,
      sourceId: 'sec_edgar',
      kind: 'filing',
      title: `${issuer.name} 提交 ${form}（${filingForms[baseForm]}）`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${directory}/${accession}-index.htm`,
      publishedAt,
      observedAt,
      filingDate,
      symbols: [issuer.symbol],
      summary: `EDGAR 申报日期 ${filingDate}。申报索引可用于核对公告正文和附件。`,
      filing: { form, items: [...new Set(itemCodes ?? [])], filingDate, acceptanceAt: publishedAt },
    })
  }
  return items.sort((a, b) => (b.publishedAt ?? b.filingDate).localeCompare(a.publishedAt ?? a.filingDate)).slice(0, 4)
}

function marketRelevance(title) {
  if (/\b(?:say(?:s|ing)?|said|mention(?:s|ed|ing)?|utter(?:s|ed|ing)?|(?:key)?words?|phrases?)\b/i.test(title)) return null
  if (/\bearnings call\b/i.test(title) && /\b(?:discuss\w*|speak\w*|spoke|talk\w*|refer\w*)\b/i.test(title)) return null
  const isChip = /\b(?:semiconductors?|gpus?|h20|h200|mi308|(?:ai|advanced|computer|computing|export) chips?|chips? (?:exports?|licenses?))\b/i.test(title)
  const isExport = /\b(?:export\w*|(?:sales?|sell\w*|ship\w*)\b.{0,36}\bto china)\b/i.test(title)
  const isTradePolicy = /\b(?:tariffs?|licen[cs]\w*|restrict\w*|ban(?:s|ned|ning)?|sanctions?)\b/i.test(title)
  const isRelevantJurisdiction = /\b(?:china|chinese|u\.?s\.?|united states|american)\b/i.test(title)
  const companies = []
  if (/\b(?:nvidia|nvda|h20|h200)\b/i.test(title)) companies.push('NVDA')
  if (/\b(?:amd|advanced micro devices|mi308)\b/i.test(title)) companies.push('AMD')
  if ((isExport || isTradePolicy && (isChip || isRelevantJurisdiction)) && (companies.length || isChip && isRelevantJurisdiction)) {
    return { symbols: companies.length ? companies : ['NVDA', 'AMD'], relevance: 'export_policy' }
  }
  const isCompanyEvent = /\b(?:earnings|revenues?|guidance|profits?|net income|eps|shipments?|production|orders?)\b/i.test(title)
  return companies.length && isCompanyEvent ? { symbols: companies, relevance: 'company_operation' } : null
}

function marketList(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeMarket(market, eventSlug, observedAt) {
  if (market?.active !== true || market.closed !== false || market.archived === true || market.acceptingOrders === false) return null
  const endDate = dateTime(market.endDate)
  if (endDate && endDate < observedAt) return null
  const title = plainText(market.question, 220)
  const match = marketRelevance(title)
  const slug = market.slug
  const conditionId = market.conditionId
  if (!match || !/^[a-z0-9][a-z0-9-]{0,180}$/.test(slug) || !/^0x[\da-f]{64}$/i.test(conditionId)) return null

  const outcomes = marketList(market.outcomes).map((label) => plainText(label, 20).toLowerCase())
  const yesIndex = outcomes.indexOf('yes')
  if (outcomes.length !== 2 || yesIndex < 0 || !outcomes.includes('no')) return null
  const yesPrice = getNumber(marketList(market.outcomePrices)[yesIndex], 1)
  const bid = yesIndex === 0 ? getNumber(market.bestBid, 1) : null
  const ask = yesIndex === 0 ? getNumber(market.bestAsk, 1) : null
  return {
    id: `polymarket:${conditionId.toLowerCase()}`,
    sourceId: 'polymarket',
    kind: 'prediction_market',
    title,
    url: `https://polymarket.com/event/${eventSlug}${slug === eventSlug ? '' : `/${slug}`}`,
    publishedAt: seenDate(market.publishedAt ?? market.published_at, observedAt),
    observedAt,
    symbols: match.symbols,
    summary: '按合约题目匹配的预测市场线索。查看合约规则、报价与流动性后再判断相关性。',
    market: {
      slug,
      eventSlug,
      conditionId,
      relevance: match.relevance,
      yesPrice,
      liquidity: getNumber(market.liquidityClob) ?? getNumber(market.liquidityNum) ?? getNumber(market.liquidity),
      bid,
      ask,
      quoteKind: 'gamma_outcome_price',
      quoteTimestamp: null,
      recordUpdatedAt: seenDate(market.updatedAt, observedAt),
      resolutionRules: plainText(market.description, 500),
      endDate,
    },
  }
}

async function searchMarkets(query, options) {
  const params = new URLSearchParams({ q: query, limit_per_type: '10', search_tags: 'false', search_profiles: 'false' })
  const payload = await requestJson(`https://gamma-api.polymarket.com/public-search?${params}`, options)
  if (!Array.isArray(payload?.events) && !(payload?.events == null && [0, '0'].includes(payload?.pagination?.totalResults))) {
    throw new Error('Invalid market search payload')
  }

  const observedAt = options.clock()
  return (payload.events ?? []).slice(0, 10).flatMap((event) => {
    if (event?.closed === true || event?.archived === true || !/^[a-z0-9][a-z0-9-]{0,180}$/.test(event?.slug) || !Array.isArray(event?.markets)) return []
    return event.markets.map((market) => normalizeMarket(market, event.slug, observedAt)).filter(Boolean)
  })
}

function representativeMarkets(items) {
  const priority = { export_policy: 0, company_operation: 1 }
  const ordered = items.sort((a, b) => priority[a.market.relevance] - priority[b.market.relevance]
    || (b.market.liquidity ?? 0) - (a.market.liquidity ?? 0)
    || a.id.localeCompare(b.id))
  const counts = new Map()
  const distinct = []
  const extra = []
  for (const item of ordered) {
    const slug = item.market.eventSlug
    const count = counts.get(slug) ?? 0
    if (count === 0) distinct.push(item)
    if (count === 1) extra.push(item)
    counts.set(slug, count + 1)
  }
  return [...distinct, ...extra].slice(0, 8)
}

async function sourceResult(id, requests, options) {
  const attempts = await Promise.allSettled(requests.map(({ promise }) => promise))
  const covered = requests.filter((_, index) => attempts[index].status === 'fulfilled')
  const failures = requests.length - covered.length
  const checkedAt = options.clock()
  const itemsById = new Map()
  for (const attempt of attempts) {
    if (attempt.status !== 'fulfilled') continue
    for (const item of attempt.value) {
      const existing = itemsById.get(item.id)
      if (!existing || existing.observedAt <= item.observedAt) itemsById.set(item.id, item)
    }
  }
  const items = [...itemsById.values()]
  const selected = id === 'polymarket' ? representativeMarkets(items) : items.slice(0, 8)
  const status = selected.length ? 'live' : failures ? 'unavailable' : 'no_match'
  const empty = id === 'sec_edgar' ? '近 45 天暂无匹配的公司申报。' : '本轮定向查询未找到仍开放的相关合约。'
  const message = status === 'live'
    ? `已读取 ${selected.length} 条。${failures ? `另有 ${failures} 项查询暂不可用。` : ''}`
    : failures ? `${failures} 项查询暂不可用，当前没有可展示的结果。` : empty

  return {
    source: {
      id,
      status,
      checkedAt,
      lastSuccessAt: covered.length ? checkedAt : null,
      complete: failures === 0,
      itemCount: selected.length,
      message,
      ...(id === 'sec_edgar' ? { coveredSymbols: covered.map(({ key }) => key) } : {}),
    },
    items: selected,
  }
}

export async function pollPublicSources({
  fetchImpl = globalThis.fetch,
  signal,
  now,
  timeoutMs = 8_000,
  secUserAgent = process.env.SEC_USER_AGENT?.trim() || 'WorldLab/0.1',
} = {}) {
  const options = { fetchImpl, signal, timeoutMs, secUserAgent, clock: () => new Date(now ?? Date.now()).toISOString() }
  const results = await Promise.all([
    sourceResult('sec_edgar', issuers.map((issuer) => ({ key: issuer.symbol, promise: readFilings(issuer, options) })), options),
    sourceResult('polymarket', marketQueries.map((query) => ({ key: query, promise: searchMarkets(query, options) })), options),
  ])
  return { sources: results.map(({ source }) => source), items: results.flatMap(({ items }) => items) }
}
