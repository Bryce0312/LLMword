import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import Ajv from 'ajv'
import { createMarketQuoteTool } from './market-quote.mjs'

export const COURSE_WEB_TOOL_IDS = Object.freeze(['search_web', 'fetch_page', 'get_market_quote'])
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
    properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARACTERS }, maxResults: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'] },
  fetch_page: { type: 'object', additionalProperties: false,
    properties: { url: { type: 'string', minLength: 1, maxLength: 8192 } }, required: ['url'] },
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

const FIXTURE_PAGES = Object.freeze([
  { url: 'https://example.com/course-lab/official', title: '课程虚构样例：主办方公告',
    text: '【静态演示材料，不是真实新闻】虚构的城市科技展正在筹备，尚未发布正式开幕确认。场地审核与设备交付仍待核验。此页仅供课程软件流程演示，不描述任何现实公司或人物。' },
  { url: 'https://example.com/course-lab/news', title: '课程虚构样例：新闻线索',
    text: '【静态演示材料，不是真实新闻】虚构记者转述了主办方的筹备计划，未取得已经开幕的独立证明。转载与主办方公告属于同一信息链，不应作为两份独立确认。' },
  { url: 'https://example.com/course-lab/verification', title: '课程虚构样例：反证核查',
    text: '【静态演示材料，不是真实新闻】虚构核查记录指出，计划开展活动和活动已经举行是不同主张。当前演示材料没有正式开幕确认，应保留缺口，不把样例当作现实结果。' },
])
export const COURSE_FIXTURE_SOURCE_DOMAINS = Object.freeze(['example.com'])

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

export function createWebResearchGateway({ env = process.env, request = fetch, now = () => new Date().toISOString(), fixturePages = FIXTURE_PAGES } = {}) {
  const provider = String(env.WORLD_SEARCH_PROVIDER || 'deepseek').trim().toLowerCase()
  const key = String(env.WORLD_SEARCH_API_KEY || env.WORLD_API_KEY || '').trim()
  const configured = provider === 'fixture' || provider === 'deepseek' && Boolean(key) && !/[\r\n]/.test(key) && typeof request === 'function'
  const mode = provider === 'fixture' ? 'mock' : configured ? 'live' : 'unavailable'
  const timeoutValue = Number(env.WORLD_SEARCH_TIMEOUT_MS)
  const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue >= 10 && timeoutValue <= 60000 ? timeoutValue : 20000
  const retries = env.WORLD_SEARCH_MAX_RETRIES === '0' ? 0 : 1
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

  function toolsFor({ roleId, question, sourceDomains, onEvidence, allowSourceDiscovery = false } = {}) {
    let domains = []; let scopeError = null
    try {
      domains = domainSet(sourceDomains)
      if (roleId === 'official' && !domains.length && question?.resolutionSource?.url) domains = [publicUrl(question.resolutionSource.url).hostname.toLowerCase()]
      if (roleId === 'official' && !domains.length && !allowSourceDiscovery) throw failure('SOURCE_SCOPE_REQUIRED', '官方资料研究员尚未获得指定来源域名。')
    } catch (error) { scopeError = error && safeErrors.has(error) ? error : failure('INVALID_SOURCE_SCOPE', '来源范围无效。') }
    const known = new Map(); const fetched = new Map(); let lastQuery = ''

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
    const search = wrap('search_web', '搜索网络来源候选；只返回链接与摘要，不取得可引用证据。官方资料席仅搜索已指定域名。', async ({ query, maxResults = 2 }, context, metrics) => {
      const terms = query.trim()
      lastQuery = terms
      const suffix = domains.length ? ` ${domains.map((host) => `site:${host}`).join(' OR ')}` : ''
      if (characters(terms + suffix).length > MAX_QUERY_CHARACTERS) throw failure('SOURCE_QUERY_TOO_LONG', '搜索词与来源限定合计过长，请缩短关键词。')
      const payload = { query: terms + suffix, count: maxResults, need_content: false }
      const response = provider === 'fixture' ? { payload: { results: (typeof fixturePages === 'function' ? fixturePages() : fixturePages).map((page) => ({ ...page, summary: page.text ?? page.content })) }, providerRequests: 0 } : await call('search', payload, context.signal)
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
      return { ...result(omitted ? 'partial' : 'ok', { query: terms, results, provider, mode, cached: false }, [],
        provider === 'fixture' ? `静态演示搜索返回 ${results.length} 条虚构材料候选；并非真实联网。` : `搜索返回 ${results.length} 条来源候选，尚未读取正文。`), usage: { providerRequests: response.providerRequests } }
    })
    const fetchPage = wrap('fetch_page', '读取公开来源原文并保存证据快照；只有成功保存的正文获得 evidenceId。不能读取私有网络或越过指定来源范围。', async ({ url: value }, context, metrics) => {
      const url = publicUrl(value)
      if (!within(url, domains)) throw failure('SOURCE_SCOPE_MISMATCH', '该链接不属于本次授权来源域名。')
      if (typeof onEvidence !== 'function') throw failure('EVIDENCE_SINK_REQUIRED', '本轮尚未配置证据保存服务。')
      if (fetched.has(url.href)) {
        const cached = structuredClone(fetched.get(url.href))
        cached.data.cached = true; cached.summary = '返回本轮已经保存的同一份正文，没有新增证据。'
        cached.usage = { providerRequests: 0 }
        return cached
      }
      const response = provider === 'fixture' ? { payload: (typeof fixturePages === 'function' ? fixturePages() : fixturePages).find((page) => page.url === url.href), providerRequests: 0 } : await call('fetch', { url: url.href }, context.signal)
      metrics.providerRequests = response.providerRequests
      const raw = response.payload
      if (!raw || typeof (raw.content ?? raw.text) !== 'string' || !(raw.content ?? raw.text).trim()) throw failure('SOURCE_CONTENT_MISSING', '此来源没有取得可读正文。')
      const completeText = (raw.content ?? raw.text).trim()
      const originalCharacters = characters(completeText).length
      const text = clipped(completeText, MAX_TEXT_CHARACTERS)
      const record = { title: textValue(raw.title, 300) || known.get(url.href)?.title || url.hostname,
        url: url.href, text, publishedAt: dateOrNull(raw.publishedAt || raw.date) || known.get(url.href)?.publishedAt || null,
        contentHash: sha(text), sourceMode: provider === 'fixture' ? 'replay' : 'live',
        truncated: originalCharacters > MAX_TEXT_CHARACTERS, originalCharacters, evidenceKind: 'page_content', referenceable: true,
        ...(provider === 'fixture' ? { fixture: true, scoringEligible: false } : {}),
      }
      if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
      let receipt
      try { receipt = await onEvidence(structuredClone(record), context) } catch { throw failure('EVIDENCE_SAVE_FAILED', '正文已读取，但证据保存失败；本次不产生可引用证据。', true) }
      if (context.signal?.aborted) throw failure('TOOL_CANCELLED', '本次来源读取已取消。')
      const evidenceId = typeof receipt === 'string' ? receipt : receipt?.evidenceId
      if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 160) throw failure('EVIDENCE_SAVE_FAILED', '证据保存服务没有返回有效编号；本次不产生可引用证据。')
      const observedAt = stamp()
      const saved = result(record.truncated ? 'partial' : 'ok', { ...record, evidenceId, provider, mode, cached: false }, [evidenceId],
        provider === 'fixture' ? '已保存静态虚构演示正文；这不是真实新闻或预测证据。' : record.truncated ? '已读取并保存正文片段，内容超过本轮上限，已明确截断。' : '已读取并保存来源正文。', observedAt)
      saved.usage = { providerRequests: response.providerRequests }
      fetched.set(url.href, structuredClone(saved))
      return saved
    })
    const registered = [search, fetchPage]
    if (quoteRoles.includes(roleId)) registered.push(createMarketQuoteTool({ request, now,
      onEvidence: typeof onEvidence === 'function' ? (record, context) => onEvidence({ ...record, evidenceKind: 'market_quote', referenceable: true }, context) : undefined,
      mode: provider === 'fixture' ? 'mock' : 'live', timeoutMs: Math.min(timeoutMs, 30000) }))
    return registered
  }
  return { capabilities: Object.freeze({ provider, mode, sourceMode: provider === 'fixture' ? 'replay' : configured ? 'live' : null, available: configured,
    toolIds: [...COURSE_WEB_TOOL_IDS], reason: configured ? null : unavailable().code,
    marketQuote: { provider: provider === 'fixture' ? 'synthetic-course-quote' : 'coinbase', roles: [...quoteRoles], pairs: ['BTC-USD', 'ETH-USD'], synthetic: provider === 'fixture' },
    limits: { maxResults: 5, queryCharacters: MAX_QUERY_CHARACTERS, textCharacters: MAX_TEXT_CHARACTERS, responseBytes: MAX_RESPONSE_BYTES, timeoutMs, maxRetries: retries } }), toolsFor }
}
