/** Optional public RSS adapter. Disabled by default; no browser, cookies or API key. */
const hosts = new Set(['www.bing.com', 'cn.bing.com'])
const decode = (value) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, n, entity) => {
  if (entity) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()]
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
})
export async function searchBing({ query, market = 'en-US', language, engine = 'bing-international', maxResults = 3, signal, request = fetch }) {
  let url = new URL(`https://${engine === 'bing-domestic' ? 'cn.bing.com' : 'www.bing.com'}/search`)
  url.search = new URLSearchParams({ q: query, format: 'rss', mkt: market, ensearch: engine === 'bing-domestic' ? '0' : '1', ...(language ? { setlang: language } : {}) })
  const route = [], timeout = AbortSignal.timeout(8000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let hop = 0; hop < 3; hop++) {
    route.push(url.hostname)
    const response = await request(url.href, { method: 'GET', headers: { Accept: 'application/rss+xml, text/xml' }, redirect: 'manual', signal: combined })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel?.()
      const next = new URL(response.headers.get('location'), url)
      if (next.protocol !== 'https:' || !hosts.has(next.hostname) || next.username || next.password || next.port || next.pathname !== '/search') throw new Error('BING_REDIRECT_REJECTED')
      url = next; continue
    }
    if (!response.ok) { await response.body?.cancel?.(); throw new Error('BING_HTTP_' + response.status) }
    if (Number(response.headers?.get?.('content-length')) > 131072) { await response.body?.cancel?.(); throw new Error('BING_RESPONSE_TOO_LARGE') }
    let xml = '', size = 0
    if (response.body?.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 131072) { await reader.cancel(); throw new Error('BING_RESPONSE_TOO_LARGE') }; xml += decoder.decode(chunk.value, { stream: true }) }; xml += decoder.decode() }
      finally { reader.releaseLock() }
    } else xml = await response.text()
    if (Buffer.byteLength(xml) > 131072 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss[ >]/i.test(xml)) throw new Error('BING_RSS_UNAVAILABLE')
    const results = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, maxResults).map(([, item]) => {
      const value = (key) => decode(item.match(new RegExp(`<${key}[^>]*>([\\s\\S]*?)<\\/${key}>`, 'i'))?.[1] || '').trim()
      return { title: value('title'), url: value('link'), summary: value('description'), date: null }
    })
    if (!results.length) throw new Error('BING_NO_RESULTS')
    return { results, provenance: { requestedEngine: engine, requestedMarket: market, requestedLanguage: language || null, actualHost: url.hostname, route, redirected: route.length > 1, independentIndexVerified: false } }
  }
  throw new Error('BING_REDIRECT_LIMIT')
}
