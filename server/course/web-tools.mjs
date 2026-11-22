import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import Ajv from 'ajv'
import { createMarketQuoteTool } from './market-quote.mjs'
import { FIXTURE_PAGES } from './course-fixtures.mjs'
import { createNewsSearchTool, textLanguage } from './news-search.mjs'
import { searchBing } from './bing-search.mjs'
import { WARNING_URL, createWeatherWarningTool, readWarnings } from './weather-warning.mjs'
import { createMarketHistoryTool, createPriceQuoteTool } from './market-resolution.mjs'
import { selectPageExcerpt, unreadablePageReason } from './page-excerpt.mjs'

export const COURSE_WEB_TOOL_IDS = Object.freeze(['search_web', 'fetch_page', 'get_market_quote', 'search_news', 'get_weather_warning', 'get_market_history'])
const quoteRoles = Object.freeze(['main', 'statistics', 'market'])
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_TEXT_CHARACTERS = 4000
const MAX_QUERY_CHARACTERS = 128
const apiOrigin = 'https://api.deepseek.com'
const resultSchema = {
  type: 'object', properties: {
    status: { enum: ['ok', 'partial', 'error'] }, data: {},
    evidenceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    summary: { type: 'string' }, observedAt: { type: 'string' },
    error: { type: ['object', 'null'] }, usage: { type: ['object', 'null'] },
  }, required: ['status', 'data', 'evidenceIds', 'summary', 'observedAt', 'error', 'usage'],
}
const inputSchemas = {
  search_web: { type: 'object', additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARACTERS }, maxResults: { type: 'integer', minimum: 1, maximum: 5 }, language: { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$', maxLength: 20 }, market: { type: 'string', pattern: '^[a-z]{2}-[A-Z]{2}$' }, engine: { enum: ['deepseek', 'auto', 'bing-domestic', 'bing-international'] } }, required: ['query'] },
  fetch_page: { type: 'object', additionalProperties: false,
    properties: { url: { type: 'string', minLength: 1, maxLength: 8192 }, focus: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['url'] },
}
const ajv = new Ajv({ strict: true, allErrors: true })
const validators = Object.fromEntries(Object.entries(inputSchemas).map(([key, schema]) => [key, ajv.compile(schema)]))
const characters = (text) => Array.from(text)
const clipped = (text, max) => characters(text).slice(0, max).join('')
const sha = (text) => createHash('sha256').update(text).digest('hex')
const safeErrors = new WeakSet()
const failure = (code, message, retryable = false) => {
  const error = Object.assign(new Error(message), { code, retryable }); safeErrors.add(error); return error
}

// Source URLs are sent only to the fixed provider endpoint. We never fetch a
// model-supplied URL locally, and we also reject private targets before forwarding.
function publicUrl(value) {
  let url
  try { url = new URL(value) } catch { throw failure('INVALID_SOURCE_URL', '请提供可公开访问的 HTTP 或 HTTPS 来源。') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw failure('INVALID_SOURCE_URL', '来源必须是无账号密码的公开 HTTP 或 HTTPS 地址。')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const type = isIP(host)
  if (type === 4) {
    const [a, b, c] = host.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113)) throw failure('PRIVATE_SOURCE_URL', '不能读取本机、私有网络或保留地址。')
  } else if (type === 6) {
    // Only global unicast literals are accepted. This also blocks mapped IPv4,
    // NAT64, unique-local and link-local variants of private addresses.
    if (!/^[23][0-9a-f]{3}:/.test(host) || host.startsWith('2001:db8:')) {
      throw failure('PRIVATE_SOURCE_URL', '不能读取本机、私有网络或保留地址。')
    }
  } else if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|invalid|test)$/.test(host)) {
    throw failure('PRIVATE_SOURCE_URL', '不能读取本机或私有网络地址。')
  }
  url.hash = ''
  return url
}

function domainSet(sourceDomains) {
  if (sourceDomains === undefined || sourceDomains === null) return []
  if (!Array.isArray(sourceDomains) || sourceDomains.length > 8) throw failure('INVALID_SOURCE_SCOPE', '来源范围必须是最多八个公开域名。')
  return [...new Set(sourceDomains.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw failure('INVALID_SOURCE_SCOPE', '来源域名无效。')
    const candidate = value.includes('://') ? value : `https://${value}`
    const url = publicUrl(candidate)
    if (url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw failure('INVALID_SOURCE_SCOPE', '来源范围请使用域名，不含路径或参数。')
    return url.hostname.toLowerCase().replace(/\.$/, '')
  }))]
}
const within = (url, domains) => !domains.length || domains.some((host) => url.hostname.toLowerCase().replace(/\.$/, '') === host || url.hostname.toLowerCase().replace(/\.$/, '').endsWith(`.${host}`))
const dateOrNull = (value) => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const textValue = (value, max) => typeof value === 'string' ? clipped(value.trim(), max) : ''

async function readJson(response) {
  const size = Number(response.headers?.get?.('content-length'))
  if (size > MAX_RESPONSE_BYTES) throw failure('SOURCE_RESPONSE_TOO_LARGE', '来源服务响应超过本轮大小上限。')
  let raw
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('SOURCE_RESPONSE_TOO_LARGE', '来源服务响应超过本轮大小上限。') }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  } else if (typeof response.text === 'function') {
    raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw failure('SOURCE_RESPONSE_TOO_LARGE', '来源服务响应超过本轮大小上限。')
  } else throw failure('SOURCE_RESPONSE_INVALID', '来源服务没有返回可读取的响应。')
  try { return JSON.parse(raw) } catch { throw failure('SOURCE_RESPONSE_INVALID', '来源服务没有返回有效 JSON。') }
}

export function createWebResearchGateway({ env = process.env, request = fetch, now = () => new Date().toISOString(), fixturePages = FIXTURE_PAGES, fixtureWarnings } = {}) {
  const provider = String(env.WORLD_SEARCH_PROVIDER || 'deepseek').trim().toLowerCase()
  let officialModel = false
  try { officialModel = new URL(env.WORLD_CHAT_COMPLETIONS_URL || env.WORLD_BASE_URL || apiOrigin).hostname === 'api.deepseek.com' } catch {}
  // A campus/proxy credential belongs to that endpoint, not the official tools service.
  const key = String(env.WORLD_SEARCH_API_KEY || (officialModel ? env.WORLD_API_KEY : '') || '').trim()
  const configured = provider === 'fixture' || provider === 'deepseek' && Boolean(key) && !/[\r\n]/.test(key) && typeof request === 'function'
  const mode = provider === 'fixture' ? 'mock' : configured ? 'live' : 'unavailable'
  const timeoutValue = Number(env.WORLD_SEARCH_TIMEOUT_MS)
  const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue >= 10 && timeoutValue <= 60000 ? timeoutValue : 20000
  const retries = env.WORLD_SEARCH_MAX_RETRIES === '0' ? 0 : 1
  // Explicit run scopes share fetched bodies, not reader permissions or saved
  // evidence IDs. A later Run must actually fetch again; unscoped callers retain
  // the old independent-toolsFor lifetime. Bound scopes and pages in memory.
  const runPages = new Map()
  function pageScope(scope) {
    if (typeof scope !== 'string' || !scope.trim()) return { pages: new Map(), pending: new Map() }
    if (!runPages.has(scope)) {
      if (runPages.size >= 24) runPages.delete(runPages.keys().next().value)
      runPages.set(scope, { pages: new Map(), pending: new Map() })
    }
    return runPages.get(scope)
  }
  const stamp = () => {
    const value = now(); const parsed = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(parsed.valueOf())) throw new TypeError('Gateway clock must return a valid date.')
    return parsed.toISOString()
  }
  const unavailable = () => provider !== 'deepseek' && provider !== 'fixture'
    ? failure('SEARCH_PROVIDER_UNSUPPORTED', '当前仅支持 DeepSeek 来源工具或明确的 fixture 演示。')
    : failure('SEARCH_NOT_CONFIGURED', '搜索服务尚未配置有效凭据；没有使用模拟材料替代。')
  const result = (status, data, evidenceIds, summary, observedAt = stamp(), error = null) => ({ status, data, evidenceIds, summary, observedAt, error, usage: null })
  const reject = (error) => ({ ...result('error', null, [], error.message, stamp(), { code: error.code, message: error.message, retryable: Boolean(error.retryable), ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}), ...(error.actionRequired ? { actionRequired: true } : {}) }),
    usage: { providerRequests: error.providerRequests || 0 } })

  async function bounded(action, externalSignal) {
    if (externalSignal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
    const controller = new AbortController(); let timedOut = false; let rejectAbort
    const cancelled = new Promise((_, rejectPromise) => { rejectAbort = rejectPromise })
    const stop = () => { controller.abort(); rejectAbort(failure(timedOut ? 'SOURCE_TIMEOUT' : 'TOOL_CANCELLED', timedOut ? '来源服务请求超时。' : '本次来源读取已取消。', timedOut)) }
    externalSignal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), cancelled]) }
    finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', stop) }
  }
  async function callOnce(path, payload, signal) {
    try {
      return await bounded(async (requestSignal) => {
        const response = await request(`${apiOrigin}/v1/tools/${path}`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: requestSignal, redirect: 'error',
        })
        if (!response || typeof response.status !== 'number') throw failure('SOURCE_RESPONSE_INVALID', '来源服务没有返回有效 HTTP 响应。')
        if (response.status < 200 || response.status >= 300) {
          const hardErrors = {
            401: ['SOURCE_AUTH_FAILED', '来源服务认证失败，请检查服务凭据后再继续。'],
            402: ['SOURCE_BALANCE_REQUIRED', '来源服务余额不足，请处理账户余额后再继续。'],
            403: ['SOURCE_ACCESS_DENIED', '来源服务拒绝访问，请处理访问权限后再继续。'],
          }
          const hard = hardErrors[response.status]
          const code = hard?.[0] || (response.status === 429 ? 'SEARCH_RATE_LIMITED' : 'SOURCE_HTTP_ERROR')
          // Never forward provider response bodies or thrown transport messages:
          // they may contain bearer keys, URLs, account details or request headers.
          const error = failure(code, hard?.[1] || `来源服务返回 HTTP ${response.status}。`, response.status === 408 || response.status === 429 || response.status >= 500)
          error.httpStatus = response.status
          if (hard) error.actionRequired = true
          const retryAfter = Number(response.headers?.get?.('retry-after'))
          if (retryAfter > 0) error.retryAfterMs = Math.min(retryAfter * 1000, 2000)
          throw error
        }
        return await readJson(response)
      }, signal)
    } catch (error) {
      if (error && safeErrors.has(error)) throw error
      throw failure('SOURCE_NETWORK_ERROR', '来源服务暂时无法连接。', true)
    }
  }
  async function call(path, payload, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return { payload: await callOnce(path, payload, signal), providerRequests: attempt + 1 } }
      catch (error) {
        error.providerRequests = attempt + 1
        if (!error.retryable || attempt >= retries || signal?.aborted) throw error
        // A failed page is not a reason to bypass access controls. Only transient
        // provider/network failures are retried. Account/access errors require
        // intervention; only missing pages take the alternative-source path.
        try { await bounded(() => new Promise((resolve) => setTimeout(resolve, error.retryAfterMs || 150)), signal) }
        catch (cancelled) { cancelled.providerRequests = attempt + 1; throw cancelled }
      }
    }
  }

  function toolsFor({ roleId, question, sourceDomains, searchDomains, onEvidence, allowSourceDiscovery = false, legacySchemas = false, marketResolution = false, cacheScope } = {}) {
    let domains = [], searchScope = []; let scopeError = null
    try {
      domains = domainSet(sourceDomains)
      searchScope = searchDomains === undefined ? domains : domainSet(searchDomains)
      if (searchDomains !== undefined && (!domains.length || !searchScope.length || searchScope.some(host => !within(new URL(`https://${host}`), domains)))) {
        throw failure('INVALID_SOURCE_SCOPE', '搜索限定必须是本轮已授权来源域名的非空子集。')
      }
      if (roleId === 'official' && !domains.length && question?.resolutionSource?.url) domains = [publicUrl(question.resolutionSource.url).hostname.toLowerCase()]
      if (roleId === 'official' && !domains.length && !allowSourceDiscovery) throw failure('SOURCE_SCOPE_REQUIRED', '官方资料研究员尚未获得指定来源域名。')
    } catch (error) { scopeError = error && safeErrors.has(error) ? error : failure('INVALID_SOURCE_SCOPE', '来源范围无效。') }
    const known = new Map(); const fetched = new Map(); let lastQuery = ''
    const bodyCache = pageScope(cacheScope)

    const wrap = (toolId, description, execute) => ({ toolId, version: 1, description,
      inputSchema: structuredClone(inputSchemas[toolId]), resultSchema: structuredClone(resultSchema), timeoutMs: (retries + 1) * timeoutMs + 2500,
      async execute(args, context = {}) {
        const metrics = { providerRequests: 0 }
        try {
          if (!validators[toolId](args) || toolId === 'search_web' && !args.query.trim()) throw failure('INVALID_ARGUMENTS', '联网工具参数未通过格式校验。')
          if (!configured) throw unavailable()
          if (scopeError) throw scopeError
          if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
          return await execute(args, context, metrics)
        } catch (error) {
          const safe = error && safeErrors.has(error)
            ? error : failure('SOURCE_TOOL_FAILED', '来源工具执行失败。', true)
          const rejected = reject(safe)
          rejected.usage.providerRequests = Math.max(rejected.usage.providerRequests, metrics.providerRequests)
          if (toolId === 'fetch_page' && (['SOURCE_CONTENT_MISSING', 'SOURCE_TIMEOUT', 'SOURCE_NETWORK_ERROR', 'SOURCE_RESPONSE_INVALID'].includes(safe.code) ||
            safe.code === 'SOURCE_HTTP_ERROR' && [404, 410].includes(safe.httpStatus) || safe.retryable && ['SEARCH_RATE_LIMITED', 'SOURCE_HTTP_ERROR'].includes(safe.code))) {
            const failedUrl = publicUrl(args.url).href
            const query = clipped(lastQuery || (typeof question === 'string' ? question : question?.question) || known.get(failedUrl)?.title || new URL(failedUrl).hostname, 72)
            rejected.data = { failedUrl, provider, mode, referenceable: false, evidenceKind: 'unread_source',
              recovery: { action: 'search_alternative', searchArgs: { query, maxResults: 5 }, requiredScope: [...domains], doNotBypassAccess: true },
              alternatives: [...known.values()].filter((item) => item.url !== failedUrl && within(new URL(item.url), domains)).slice(0, 4)
                .map(({ title, url, publishedAt }) => ({ title, url, publishedAt, referenceable: false, evidenceKind: 'search_snippet' })),
            }
            rejected.error.recoverable = true
            rejected.summary += ' 这一页读取失败不代表研究结束；可在授权来源内选择其他候选或重新搜索，不能将摘要冒充原文。'
          }
          return rejected
        }
      },
    })
    const search = wrap('search_web', '使用任意语言搜索公开候选；language/market记录查询意图，不保证地理覆盖。默认DeepSeek；可选Bing须服务器启用，否则回退并说明。摘要不是正文。', async ({ query, maxResults = 2, language, market, engine = 'deepseek' }, context, metrics) => {
      const terms = query.trim()
      lastQuery = terms
      const suffix = searchScope.length ? ` ${searchScope.map((host) => `site:${host}`).join(' OR ')}` : ''
      if (characters(terms + suffix).length > MAX_QUERY_CHARACTERS) throw failure('SOURCE_QUERY_TOO_LONG', '搜索词与来源限定合计过长，请缩短关键词。')
      const payload = { query: terms + suffix, count: maxResults, need_content: false }
      let response, provenance = { requestedEngine: engine, requestedLanguage: language || null, requestedMarket: market || null, actualProvider: provider, independentIndexVerified: false }, publicRequests = 0
      if (provider === 'fixture') response = { payload: { results: (typeof fixturePages === 'function' ? fixturePages() : fixturePages).map((page) => ({ ...page, summary: page.text ?? page.content })) }, providerRequests: 0 }
      else {
        if (engine !== 'deepseek') {
          if (env.WORLD_BING_SEARCH !== 'enabled') provenance.fallbackReason = 'BING_NOT_ENABLED'
          else try {
            publicRequests++
            const found = await searchBing({ query: payload.query, language, market: market || (engine === 'bing-domestic' ? 'zh-CN' : 'en-US'), engine: engine === 'auto' ? market === 'zh-CN' ? 'bing-domestic' : 'bing-international' : engine, maxResults, request, signal: context.signal })
            response = { payload: found, providerRequests: 0 }; provenance = { ...provenance, ...found.provenance, actualProvider: 'bing-public-rss' }
          } catch (error) { if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '搜索已取消。'); provenance.fallbackReason = /^BING_[A-Z0-9_]+$/.test(error.message) ? error.message : 'BING_UNAVAILABLE' }
        }
        response ||= await call('search', payload, context.signal)
      }
      metrics.providerRequests = response.providerRequests
      const raw = response.payload
      if (!raw || !Array.isArray(raw.results)) throw failure('SOURCE_RESPONSE_INVALID', '搜索服务结果缺少候选列表。')
      const results = []; const seen = new Set(); let omitted = false
      for (const row of raw.results.slice(0, 50)) {
        try {
          if (!row || typeof row.url !== 'string') { omitted = true; continue }
          const url = publicUrl(row.url)
          if (!within(url, domains) || seen.has(url.href)) { omitted = true; continue }
          seen.add(url.href)
          const candidate = { title: textValue(row.title, 300) || url.hostname, url: url.href,
            snippet: textValue(row.summary || row.snippet, 400), publishedAt: dateOrNull(row.date),
            sourceMode: provider === 'fixture' ? 'replay' : 'live', mode, evidenceKind: 'search_snippet', referenceable: false }
          known.set(url.href, candidate); results.push(candidate)
          if (results.length >= maxResults) break
        } catch { omitted = true }
      }
      return { ...result(omitted ? 'partial' : 'ok', { query: terms, results, provider, mode, cached: false, provenance }, [],
        provider === 'fixture' ? `静态演示搜索返回 ${results.length} 条虚构材料候选；并非真实联网。` : `搜索返回 ${results.length} 条来源候选，尚未读取正文。${provenance.fallbackReason ? ' 可选搜索渠道不可用，已回退现有服务。' : ''}`), usage: { providerRequests: response.providerRequests, publicSearchActions: publicRequests } }
    })
    const fetchPage = wrap('fetch_page', '读取公开来源并保存可引用原文。focus只填原文短词（≤80字），不是搜索问题；未命中返回partial降级正文与citationHints，不要为换focus反复抓同页。引用直接复制text或citationHints的连续片段；摘要和定位提示不能补造原文。登录/验证码/浏览器不支持页不作证据。', async ({ url: value, focus }, context, metrics) => {
      const url = publicUrl(value)
      const cacheKey = focus ? url.href + '#focus=' + focus : url.href
      if (!within(url, domains)) throw failure('SOURCE_SCOPE_MISMATCH', '该链接不属于本次授权来源域名。')
      if (typeof onEvidence !== 'function') throw failure('EVIDENCE_SINK_REQUIRED', '本轮尚未配置证据保存服务。')
      if (fetched.has(cacheKey)) {
        const cached = structuredClone(fetched.get(cacheKey))
        cached.data.cached = true; cached.summary = '返回本轮已经保存的同一份正文，没有新增证据。'
        cached.usage = { providerRequests: 0 }
        return cached
      }
      if (url.href === WARNING_URL) {
        const record = await readWarnings({ request, now, mode: provider === 'fixture' ? 'mock' : 'live', fixtureWarnings, signal: context.signal })
        const receipt = await onEvidence(record, context), evidenceId = typeof receipt === 'string' ? receipt : receipt?.evidenceId
        if (!evidenceId) throw failure('EVIDENCE_SAVE_FAILED', '警告原文未能保存。')
        const saved = { ...result('ok', { ...record, evidenceId, provider: 'hko-public-json', mode, cached: false }, [evidenceId], '已保存官方完整JSON；当前警告不等于未来结果。'), usage: { providerRequests: 0 } }
        fetched.set(cacheKey, structuredClone(saved)); return saved
      }
      const rawCached = bodyCache.pages.has(url.href) || bodyCache.pending.has(url.href)
      let raw = bodyCache.pages.get(url.href)
      if (!bodyCache.pages.has(url.href)) {
        const joined = bodyCache.pending.has(url.href)
        if (!joined) {
          const loading = (async () => {
            const response = provider === 'fixture' ? { payload: (typeof fixturePages === 'function' ? fixturePages() : fixturePages).find((page) => page.url === url.href), providerRequests: 0 } : await call('fetch', { url: url.href }, context.signal)
            metrics.providerRequests = response.providerRequests
            if (bodyCache.pages.size >= 32) bodyCache.pages.delete(bodyCache.pages.keys().next().value)
            bodyCache.pages.set(url.href, response.payload)
            return response.payload
          })()
          bodyCache.pending.set(url.href, loading)
        }
        const loading = bodyCache.pending.get(url.href)
        try { raw = joined ? await bounded(() => loading, context.signal) : await loading }
        catch (error) {
          if (joined && safeErrors.has(error)) {
            const own = failure(error.code, error.message, error.retryable)
            own.httpStatus = error.httpStatus; own.actionRequired = error.actionRequired; own.providerRequests = 0
            throw own
          }
          throw error
        } finally { if (!joined) bodyCache.pending.delete(url.href) }
      }
      if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
      if (!raw || typeof (raw.content ?? raw.text) !== 'string' || !(raw.content ?? raw.text).trim()) throw failure('SOURCE_CONTENT_MISSING', '此来源没有取得可读正文。')
      const completeText = (raw.content ?? raw.text).trim()
      if (unreadablePageReason(completeText, raw.title || '')) throw failure('SOURCE_CONTENT_MISSING', '取得的是浏览器不支持、访问验证或不可读页面，不作为正文证据；请选择其他公开来源，不重试同页定位。')
      const excerpt = selectPageExcerpt(completeText, focus, MAX_TEXT_CHARACTERS)
      const { text } = excerpt
      const record = { title: textValue(raw.title, 300) || known.get(url.href)?.title || url.hostname,
        url: url.href, ...excerpt, publishedAt: dateOrNull(raw.publishedAt || raw.date) || known.get(url.href)?.publishedAt || null,
        contentHash: sha(text), sourceMode: provider === 'fixture' ? 'replay' : 'live',
        language: textLanguage(text), evidenceKind: 'page_content', referenceable: true,
        ...(provider === 'fixture' ? { fixture: true, scoringEligible: false } : {}),
      }
      if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
      let receipt
      try { receipt = await onEvidence(structuredClone(record), context) } catch { throw failure('EVIDENCE_SAVE_FAILED', '正文已读取，但证据保存失败；本次不产生可引用证据。', true) }
      if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
      const evidenceId = typeof receipt === 'string' ? receipt : receipt?.evidenceId
      if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 160) throw failure('EVIDENCE_SAVE_FAILED', '证据保存服务没有返回有效编号；本次不产生可引用证据。')
      const observedAt = stamp()
      const focusNote = record.focusMatched ? '' : ' 未找到完整定位词；已返回真实降级片段，focusMatched=false。可直接引用text/citationHints，不要把未取得部分写成事实。'
      const saved = result(record.truncated || !record.focusMatched ? 'partial' : 'ok', { ...record, evidenceId, provider, mode, cached: false, rawCached }, [evidenceId],
        (provider === 'fixture' ? '已保存静态虚构演示正文；这不是真实新闻或预测证据。' : record.truncated ? '已读取并保存正文片段，未包含部分不可引用。' : '已读取并保存来源正文。') + focusNote, observedAt)
      saved.usage = { providerRequests: metrics.providerRequests }
      fetched.set(cacheKey, structuredClone(saved))
      return saved
    })
    if (domains.length) fetchPage.description += ` 本次允许读取的来源域：${domains.join('、')}。`
    if (searchScope.length) search.description += ` 本次检索优先限定：${searchScope.join('、')}；其他授权一手域可按确切URL读取。`
    const registered = [search, fetchPage]
    if (!legacySchemas && ['official', 'industry', 'statistics', 'verification'].includes(roleId) && /火灾危险警告|雷暴警告|weather warning|fire danger/i.test(typeof question === 'string' ? question : question?.question || '')) registered.push(createWeatherWarningTool({ request, now, mode: provider === 'fixture' ? 'mock' : 'live', fixtureWarnings,
      onEvidence: async (record, context) => { if (scopeError) throw scopeError; if (!within(new URL(record.url), domains)) throw failure('SOURCE_SCOPE_MISMATCH', '警告不属于授权来源。'); return onEvidence(record, context) } }))
    if (legacySchemas) { for (const key of ['language', 'market', 'engine']) delete search.inputSchema.properties[key]; search.description = '搜索网络来源候选；只返回链接与摘要，不取得可引用证据。官方资料席仅搜索已指定域名。' }
    if (['timeline', 'verification'].includes(roleId)) {
      const news = createNewsSearchTool(search)
      if (legacySchemas) { news.version = 1; news.description = '分别用中文和英文查询公开新闻候选；结果只是线索，必须读取正文后才能引用。'; news.inputSchema = { type: 'object', additionalProperties: false, properties: { queryZh: { type: 'string', minLength: 1, maxLength: 100 }, queryEn: { type: 'string', minLength: 1, maxLength: 100 }, maxResults: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['queryZh', 'queryEn'] } }
      registered.push(news)
    }
    const questionText = typeof question === 'string' ? question : [question?.question, question?.originalQuestion, question?.object].filter(Boolean).join(' ')
    const quotePairs = question === undefined ? ['BTC-USD', 'ETH-USD'] : [
      /比特币|\bBTC\b|bitcoin/i.test(questionText) ? 'BTC-USD' : null,
      /以太|\bETH\b|ethereum/i.test(questionText) ? 'ETH-USD' : null,
    ].filter(Boolean)
    if (!marketResolution && quoteRoles.includes(roleId) && quotePairs.length) {
      const quote = createMarketQuoteTool({ request, now,
      onEvidence: typeof onEvidence === 'function' ? (record, context) => onEvidence({ ...record, evidenceKind: 'market_quote', referenceable: true }, context) : undefined,
      mode: provider === 'fixture' ? 'mock' : 'live', timeoutMs: Math.min(timeoutMs, 30000) })
      quote.inputSchema.properties.pair.enum = quotePairs
      registered.push(quote)
    }
    if (marketResolution && ['main','market','statistics','verification'].includes(roleId)) registered.push(createPriceQuoteTool({ request, now, mode: provider === 'fixture' ? 'mock' : 'live', onEvidence }), createMarketHistoryTool({ request, now, mode: provider === 'fixture' ? 'mock' : 'live', onEvidence }))
    return registered
  }
  return { capabilities: Object.freeze({ provider, mode, sourceMode: provider === 'fixture' ? 'replay' : provider === 'deepseek' ? 'live' : null, available: configured,
    multilingualQueries: true, optionalBing: env.WORLD_BING_SEARCH === 'enabled', browserRequired: false,
    toolIds: [...COURSE_WEB_TOOL_IDS], reason: configured ? null : unavailable().code,
    marketQuote: { provider: provider === 'fixture' ? 'synthetic-course-quote' : 'coinbase', roles: [...quoteRoles], pairs: ['BTC-USD', 'ETH-USD'], synthetic: provider === 'fixture' },
    limits: { maxResults: 5, queryCharacters: MAX_QUERY_CHARACTERS, textCharacters: MAX_TEXT_CHARACTERS, responseBytes: MAX_RESPONSE_BYTES, timeoutMs, maxRetries: retries } }), toolsFor }
}
