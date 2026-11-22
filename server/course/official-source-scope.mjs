// A narrow research allowlist, not an issuer/listing verification service. Never
// infer new permissions from arbitrary links returned by a search or webpage.
const markets = Object.freeze({
  HK: ['hkexnews.hk', 'hkex.com.hk', 'sfc.hk'],
  US: ['sec.gov', 'nyse.com', 'nasdaq.com'],
  CN: ['cninfo.com.cn', 'sse.com.cn', 'szse.cn', 'csrc.gov.cn'],
})
const issuers = Object.freeze([
  { match: /腾讯|騰訊|\bTencent\b|\b00700\b|\b0*700\.HK\b|\bTCEHY\b/i, bare: /^0*700$/, domains: ['tencent.com'], market: 'HK' },
  { match: /英伟达|英偉達|\bNVIDIA\b|\bNVDA\b/i, domains: ['nvidia.com'], market: 'US' },
  { match: /苹果|蘋果|\bApple\b|\bAAPL\b/i, domains: ['apple.com'], market: 'US' },
  { match: /字节|字節|\bByteDance\b/i, domains: ['bytedance.com'], market: null },
])

/** Keep strict result-source policies unchanged; preset research can seek primary sources. */
export function officialSourceScope(request, specifiedSource) {
  if (!specifiedSource) return { sourceDomains: undefined, searchDomains: undefined }
  const reference = new URL(specifiedSource).hostname.toLowerCase().replace(/\.$/, '')
  if (request?.mode !== 'preset' || request?.resolutionPolicy) return { sourceDomains: [reference], searchDomains: undefined }
  const question = [request.question, request.normalized?.object, request.normalized?.question].filter(value => typeof value === 'string')
  const companies = issuers.filter(issuer => question.some(value => issuer.match.test(value) || issuer.bare?.test(value.trim())))
  const companyDomains = companies.flatMap(issuer => issuer.domains)
  // A calendar default does not establish an issuer's jurisdiction. A recognized
  // issuer's primary authorities stay reachable alongside the selected market;
  // this changes research permissions only, never the sealed calendar/identity.
  const marketIds = [...new Set([...companies.map(issuer => issuer.market), request.tradingHorizon?.market || request.market].filter(Boolean))]
  const authorities = [...new Set(marketIds.flatMap(market => markets[market] || []))]
  const sourceDomains = [...new Set([reference, ...companyDomains, ...authorities])].slice(0, 8)
  // Search a small permitted subset so site filters do not consume the entire
  // provider query limit. Exact reads may still use any allowed primary domain.
  const searchDomains = [...new Set([...companyDomains, authorities[0] || reference])].filter(domain => sourceDomains.includes(domain)).slice(0, 2)
  return { sourceDomains, searchDomains }
}
