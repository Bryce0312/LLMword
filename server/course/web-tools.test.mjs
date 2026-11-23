import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWebResearchGateway, COURSE_WEB_TOOL_IDS } from './web-tools.mjs'

const key = 'test-only-search-credential'
const env = { WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_SEARCH_API_KEY: key }
const clock = () => '2026-11-19T05:00:00.000Z'
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const tool = (gateway, id, context = {}) => gateway.toolsFor(context).find((item) => item.toolId === id)

test('explicit draft-source discovery lets the official researcher find a public source without relaxing an existing domain or private-network guards', async () => {
  let saved = 0
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: clock, fixturePages: [
    { url: 'https://official.example.org/notice', title: '【规则样例】公告', text: '仅校验来源发现权限。' },
    { url: 'https://news.example.org/story', title: '【规则样例】报道', text: '非指定域名来源。' },
  ] })
  const missing = await tool(gateway, 'search_web', { roleId: 'official' }).execute({ query: 'notice' })
  assert.equal(missing.error.code, 'SOURCE_SCOPE_REQUIRED')
  const discovery = gateway.toolsFor({ roleId: 'official', allowSourceDiscovery: true, onEvidence: () => { saved++; return 'discovered_source' } })
  const search = await discovery.find(t => t.toolId === 'search_web').execute({ query: 'notice' })
  assert.equal(search.data.results.length, 2)
  const fetched = await discovery.find(t => t.toolId === 'fetch_page').execute({ url: 'https://official.example.org/notice' })
  assert.deepEqual(fetched.evidenceIds, ['discovered_source'])
  const unsafe = await discovery.find(t => t.toolId === 'fetch_page').execute({ url: 'http://127.0.0.1/private' })
  assert.equal(unsafe.status, 'error'); assert.equal(saved, 1)
  const constrained = gateway.toolsFor({ roleId: 'official', allowSourceDiscovery: true, sourceDomains: ['official.example.org'], onEvidence: () => 'scoped_source' })
  const scoped = await constrained.find(t => t.toolId === 'search_web').execute({ query: 'notice' })
  assert.equal(scoped.data.results.length, 1)
  const other = await constrained.find(t => t.toolId === 'fetch_page').execute({ url: 'https://news.example.org/story' })
  assert.equal(other.error.code, 'SOURCE_SCOPE_MISMATCH')
})

test('course web gateway has honest missing credentials, unsupported provider and explicit fixture capabilities', async () => {
  let called = 0
  const request = async () => { called++; throw new Error('must not call') }
  const missing = createWebResearchGateway({ env: {}, request, now: clock })
  assert.equal(missing.capabilities.available, false)
  assert.equal(missing.capabilities.mode, 'unavailable')
  assert.equal(missing.capabilities.reason, 'SEARCH_NOT_CONFIGURED')
  const result = await tool(missing, 'search_web').execute({ query: 'company leadership' })
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'SEARCH_NOT_CONFIGURED')
  assert.deepEqual(result.evidenceIds, []); assert.equal(called, 0)
  const unknown = createWebResearchGateway({ env: { ...env, WORLD_SEARCH_PROVIDER: 'unknown' }, request })
  assert.equal(unknown.capabilities.reason, 'SEARCH_PROVIDER_UNSUPPORTED')
  const fixture = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, request, now: clock })
  assert.equal(fixture.capabilities.mode, 'mock'); assert.equal(fixture.capabilities.sourceMode, 'replay')
  assert.deepEqual(fixture.capabilities.toolIds, COURSE_WEB_TOOL_IDS)
  const demo = await tool(fixture, 'search_web').execute({ query: 'demo' })
  assert.equal(demo.data.mode, 'mock'); assert.equal(demo.evidenceIds.length, 0)
  assert.match(demo.summary, /虚构/); assert.equal(called, 0)
})

test('DeepSeek search uses the fixed authenticated endpoint, clamps schema and returns deduplicated candidates only', async () => {
  const calls = []; let saves = 0
  const gateway = createWebResearchGateway({ env, now: clock, request: async (url, options) => {
    calls.push({ url, options })
    return json({ results: [
      { title: 'First', url: 'https://news.example.com/article#one', summary: '摘'.repeat(1000), date: '2026-11-18T01:00:00Z', content: 'Never count search content as evidence.' },
      { title: 'Duplicate', url: 'https://news.example.com/article#two' },
      { title: 'Private', url: 'http://127.0.0.1/secrets' },
      { title: 'Second', url: 'https://other.example.com/post', snippet: 'Short snippet', date: 'yesterday' },
    ] })
  } })
  const search = tool(gateway, 'search_web', { roleId: 'main', onEvidence: () => { saves++ } })
  const output = await search.execute({ query: '  latest leadership  ', maxResults: 5 })
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`)
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: 'latest leadership', count: 5, need_content: false })
  assert.equal(output.status, 'partial'); assert.equal(output.data.results.length, 2)
  assert.equal(output.data.results[0].url, 'https://news.example.com/article')
  assert.equal(output.data.results[0].publishedAt, '2026-11-18T01:00:00.000Z')
  assert.equal(output.data.results[0].snippet.length, 400)
  assert.equal(output.data.results[1].publishedAt, null)
  assert.equal(output.data.results[0].sourceMode, 'live')
  assert.equal(output.data.results[0].evidenceKind, 'search_snippet'); assert.equal(output.data.results[0].referenceable, false)
  assert.equal(output.observedAt, clock()); assert.deepEqual(output.evidenceIds, []); assert.equal(saves, 0)
  for (const args of [{ query: 'x', maxResults: 6 }, { query: ' ' }, { query: 'x', count: 5 }, { query: 'x'.repeat(129) }]) {
    assert.equal((await search.execute(args)).error.code, 'INVALID_ARGUMENTS')
  }
  assert.equal(calls.length, 1)
  const defaults = await search.execute({ query: 'default candidate budget' })
  assert.equal(JSON.parse(calls[1].options.body).count, 2)
  assert.equal(defaults.data.results.length, 2)
  assert.deepEqual(defaults.evidenceIds, []); assert.equal(saves, 0)
})

test('only fetched text saved through the evidence callback becomes referenceable and preserves tool context', async () => {
  const records = []; const calls = []; const context = { toolCallId: 'fetch_1', assignmentId: 'assignment_1' }
  const gateway = createWebResearchGateway({ env, now: clock, request: async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) })
    if (url.endsWith('/search')) return json({ results: [{ title: 'Source title', url: 'https://public.example.com/notice', date: '2026-11-18T12:00:00Z' }] })
    return json({ title: 'Official notice', content: '# Leadership\nNo confirmed appointment in this example.' })
  } })
  const tools = gateway.toolsFor({ roleId: 'main', onEvidence: async (record, receivedContext) => { records.push({ record, receivedContext }); return { evidenceId: 'evidence_saved' } } })
  await tools[0].execute({ query: 'notice' })
  const output = await tools[1].execute({ url: 'https://public.example.com/notice' }, context)
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/fetch')
  assert.deepEqual(calls[1].payload, { url: 'https://public.example.com/notice' })
  assert.equal(output.status, 'ok'); assert.deepEqual(output.evidenceIds, ['evidence_saved'])
  assert.equal(records[0].receivedContext, context)
  assert.equal(records[0].record.sourceMode, 'live')
  assert.equal(records[0].record.evidenceKind, 'page_content'); assert.equal(records[0].record.referenceable, true)
  assert.equal(records[0].record.publishedAt, '2026-11-18T12:00:00.000Z')
  assert.equal(records[0].record.contentHash, createHash('sha256').update(output.data.text).digest('hex'))
  assert.equal(output.data.evidenceId, 'evidence_saved'); assert.equal(output.data.cached, false)
  assert.equal(output.data.truncated, false)
})

test('official role source domains constrain both search results and fetched URLs at host boundaries', async () => {
  const requests = []
  const gateway = createWebResearchGateway({ env, request: async (url, options) => {
    requests.push(JSON.parse(options.body))
    return url.endsWith('search') ? json({ results: [
      { url: 'https://investor.company.example.com/notice', title: 'Allowed' },
      { url: 'https://company.example.com.attacker.org/notice', title: 'Not allowed' },
      { url: 'https://other.example.org/notice', title: 'Not allowed either' },
    ] }) : json({ title: 'Notice', content: 'Stored content' })
  } })
  const tools = gateway.toolsFor({ roleId: 'official', sourceDomains: ['company.example.com'], onEvidence: async () => 'evidence_official' })
  const search = await tools[0].execute({ query: 'leadership' })
  assert.equal(requests[0].query, 'leadership site:company.example.com')
  assert.equal(search.data.results.length, 1)
  assert.equal((await tools[1].execute({ url: 'https://company.example.com.attacker.org/notice' })).error.code, 'SOURCE_SCOPE_MISMATCH')
  assert.equal((await tools[1].execute({ url: 'https://investor.company.example.com/notice' })).status, 'ok')
  const unscoped = await tool(gateway, 'search_web', { roleId: 'official' }).execute({ query: 'leadership' })
  assert.equal(unscoped.error.code, 'SOURCE_SCOPE_REQUIRED')
  const scoped = tool(gateway, 'search_web', { roleId: 'official', question: { resolutionSource: { url: 'https://company.example.com/resolve' } } })
  assert.equal((await scoped.execute({ query: 'leadership' })).data.results.length, 1)
  assert.equal((await scoped.execute({ query: 'x'.repeat(128) })).error.code, 'SOURCE_QUERY_TOO_LONG')
})

test('public source guards reject private aliases, credentials, unsafe schemes and malformed scope before any request', async () => {
  let calls = 0
  const gateway = createWebResearchGateway({ env, request: async () => { calls++; return json({ content: 'must not reach' }) } })
  const fetcher = tool(gateway, 'fetch_page', { onEvidence: async () => 'evidence_test' })
  for (const url of [
    'http://localhost/foo', 'http://127.0.0.1/foo', 'http://2130706433/foo', 'http://0x7f000001/foo',
    'http://10.0.0.1/foo', 'http://172.16.0.1/foo', 'http://192.168.1.1/foo', 'http://169.254.169.254/latest',
    'http://100.64.0.1/foo', 'http://[::1]/foo', 'http://[::ffff:127.0.0.1]/foo', 'http://[fc00::1]/foo',
    'http://service.local/foo', 'http://machine.internal/foo', 'http://host/foo', 'file:///etc/passwd',
    'https://user:password@public.example.com/foo', 'javascript:alert(1)',
  ]) {
    const output = await fetcher.execute({ url })
    assert.equal(output.status, 'error', url); assert.deepEqual(output.evidenceIds, [])
  }
  const invalidScope = tool(gateway, 'search_web', { sourceDomains: ['127.0.0.1'] })
  assert.equal((await invalidScope.execute({ query: 'x' })).status, 'error')
  assert.equal(calls, 0)
})

test('HTTP and transport failures are structured and never echo provider bodies, headers or credentials', async () => {
  for (const [status, code, retryable] of [[401, 'SOURCE_AUTH_FAILED', false], [402, 'SOURCE_BALANCE_REQUIRED', false], [403, 'SOURCE_ACCESS_DENIED', false], [429, 'SEARCH_RATE_LIMITED', true], [500, 'SOURCE_HTTP_ERROR', true]]) {
    const gateway = createWebResearchGateway({ env, request: async () => json({ error: { message: `Authorization: Bearer ${key}` } }, status) })
    const output = await tool(gateway, 'search_web').execute({ query: 'test' })
    assert.equal(output.error.code, code); assert.equal(output.error.retryable, retryable)
    assert.equal(output.error.httpStatus, status)
    assert.equal(output.error.actionRequired, [401, 402, 403].includes(status) ? true : undefined)
    assert.equal(JSON.stringify(output).includes(key), false); assert.deepEqual(output.evidenceIds, [])
  }
  for (const error of [new Error(`network details ${key}`), Object.assign(new Error(`provider details ${key}`), { code: 'SOURCE_HTTP_ERROR' })]) {
    const gateway = createWebResearchGateway({ env, request: async () => { throw error } })
    const output = await tool(gateway, 'search_web').execute({ query: 'test' })
    assert.equal(output.error.code, 'SOURCE_NETWORK_ERROR')
    assert.equal(JSON.stringify(output).includes(key), false)
  }
})

test('account and access HTTP failures require intervention for both source tools without retries or alternative-page prompts', async () => {
  for (const [status, code] of [[401, 'SOURCE_AUTH_FAILED'], [402, 'SOURCE_BALANCE_REQUIRED'], [403, 'SOURCE_ACCESS_DENIED']]) {
    for (const id of ['search_web', 'fetch_page']) {
      let requests = 0; let saves = 0; let bodyReads = 0
      const gateway = createWebResearchGateway({ env, now: clock, request: async () => {
        requests++
        return { status, headers: new Headers({ 'retry-after': '1' }), text: async () => { bodyReads++; return `private provider payload ${key}` } }
      } })
      const output = await tool(gateway, id, { onEvidence: async () => { saves++; return 'must-not-save' } }).execute(id === 'search_web' ? { query: 'research' } : { url: 'https://public.example.com/report' })
      assert.equal(output.status, 'error'); assert.equal(output.error.code, code)
      assert.equal(output.error.httpStatus, status); assert.equal(output.error.actionRequired, true)
      assert.equal(output.error.retryable, false); assert.equal(output.error.recoverable, undefined)
      assert.equal(output.data, null); assert.deepEqual(output.evidenceIds, [])
      assert.equal(output.usage.providerRequests, 1); assert.equal(requests, 1)
      assert.equal(bodyReads, 0); assert.equal(saves, 0)
      assert(!JSON.stringify(output).includes(key))
      assert(!output.summary.includes('其他候选'))
    }
  }
})

test('timeouts and caller cancellation abort transport and do not save evidence', async () => {
  let saves = 0; let requestSignal
  const gateway = createWebResearchGateway({ env: { ...env, WORLD_SEARCH_TIMEOUT_MS: '15' }, request: async (_, options) => { requestSignal = options.signal; return new Promise(() => {}) } })
  const output = await tool(gateway, 'fetch_page', { onEvidence: async () => { saves++; return 'impossible' } }).execute({ url: 'https://example.org/page' })
  assert.equal(output.error.code, 'SOURCE_TIMEOUT'); assert.equal(output.error.retryable, true)
  assert.equal(requestSignal.aborted, true); assert.equal(saves, 0)
  const controller = new AbortController()
  const pending = tool(gateway, 'search_web').execute({ query: 'cancel' }, { signal: controller.signal })
  controller.abort()
  assert.equal((await pending).error.code, 'TOOL_CANCELLED')
  assert.equal(saves, 0)
})

test('oversized and malformed responses produce no evidence, and long readable text is explicitly bounded', async () => {
  let saves = 0
  for (const response of [
    new Response('not json', { status: 200 }),
    json({ wrong: [] }),
    json({ results: [] }, 200, { 'Content-Length': String(300000) }),
    json({ results: [{ title: 'x'.repeat(300000) }] }),
  ]) {
    const gateway = createWebResearchGateway({ env, request: async () => response })
    const output = await tool(gateway, 'search_web', { onEvidence: () => { saves++ } }).execute({ query: 'test' })
    assert.equal(output.status, 'error'); assert.deepEqual(output.evidenceIds, [])
  }
  const gateway = createWebResearchGateway({ env, request: async () => json({ title: 'Long article', content: '中'.repeat(5000) }) })
  const output = await tool(gateway, 'fetch_page', { onEvidence: (record) => { saves++; assert.equal(record.text.length, 4000); return { evidenceId: 'evidence_excerpt' } } }).execute({ url: 'https://example.org/long' })
  assert.equal(output.status, 'partial'); assert.equal(output.data.truncated, true)
  assert.equal(output.data.originalCharacters, 5000); assert.equal(output.data.text.length, 4000)
  assert.equal(saves, 1)
})

test('an unavailable or failing evidence sink cannot manufacture citation IDs from fetched pages', async () => {
  let requests = 0
  const gateway = createWebResearchGateway({ env, request: async () => { requests++; return json({ content: 'A real provider response fixture' }) } })
  const missing = await tool(gateway, 'fetch_page').execute({ url: 'https://example.org/page' })
  assert.equal(missing.error.code, 'EVIDENCE_SINK_REQUIRED'); assert.equal(requests, 0)
  for (const onEvidence of [async () => { throw new Error(`private storage error ${key}`) }, async () => null, async () => ({ id: 'wrong' })]) {
    const output = await tool(gateway, 'fetch_page', { onEvidence }).execute({ url: 'https://example.org/page' })
    assert.equal(output.error.code, 'EVIDENCE_SAVE_FAILED'); assert.deepEqual(output.evidenceIds, [])
    assert.equal(output.usage.providerRequests, 1, 'A successful HTTP read is still counted if persistence fails')
    assert.equal(JSON.stringify(output).includes(key), false)
  }
})

test('a same-run cached page retains original time and citation while a later scope can fetch genuinely changed content', async () => {
  let tick = 0; let network = 0; let saves = 0
  const gateway = createWebResearchGateway({ env, now: () => `2026-11-19T05:00:0${tick++}.000Z`, request: async () => json({ content: `version ${++network}` }) })
  const onEvidence = async () => `evidence_${++saves}`
  const fetcher = tool(gateway, 'fetch_page', { onEvidence })
  const first = await fetcher.execute({ url: 'https://example.org/page' })
  const repeated = await fetcher.execute({ url: 'https://example.org/page#fragment' })
  assert.equal(repeated.data.cached, true); assert.equal(first.observedAt, repeated.observedAt)
  assert.equal(repeated.usage.providerRequests, 0)
  assert.equal(first.data.contentHash, repeated.data.contentHash); assert.deepEqual(first.evidenceIds, repeated.evidenceIds)
  assert.equal(network, 1); assert.equal(saves, 1)
  const later = await tool(gateway, 'fetch_page', { onEvidence }).execute({ url: 'https://example.org/page' })
  assert.equal(later.data.cached, false); assert.notEqual(later.data.contentHash, first.data.contentHash)
  assert.equal(network, 2); assert.equal(saves, 2)
})

test('a 404 page stays a failed unread source and offers scoped alternatives before another real fetch', async () => {
  const requests = []; const saved = []
  const gateway = createWebResearchGateway({ env, now: clock, request: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body })
    if (url.endsWith('search')) return json({ results: [
      { title: 'Broken page', url: 'https://official.example.com/broken', summary: 'Index only' },
      { title: 'Alternative page', url: 'https://official.example.com/readable', summary: 'Candidate, not evidence' },
      { title: 'Out of scope', url: 'https://unrelated.example.org/mirror', summary: 'Must not cross official permission' },
    ] })
    if (body.url.endsWith('/broken')) return json({ error: { message: `private provider ${key}` } }, 404)
    return json({ title: 'Actually fetched alternative', content: 'A real page body from the injected HTTP response.' })
  } })
  const tools = gateway.toolsFor({ roleId: 'official', sourceDomains: ['official.example.com'], onEvidence: async (record) => { saved.push(record); return 'evidence_alternative' } })
  await tools[0].execute({ query: 'latest notices', maxResults: 5 })
  const unavailable = await tools[1].execute({ url: 'https://official.example.com/broken' })
  assert.equal(unavailable.status, 'error'); assert.deepEqual(unavailable.evidenceIds, [])
  assert.equal(unavailable.error.httpStatus, 404); assert.equal(unavailable.error.retryable, false); assert.equal(unavailable.error.recoverable, true)
  assert.equal(unavailable.data.referenceable, false); assert.equal(unavailable.data.evidenceKind, 'unread_source')
  assert.equal(unavailable.data.recovery.action, 'search_alternative')
  assert.equal(unavailable.data.recovery.searchArgs.maxResults, 5)
  assert.deepEqual(unavailable.data.recovery.requiredScope, ['official.example.com'])
  assert.equal(unavailable.data.recovery.doNotBypassAccess, true)
  assert.equal(unavailable.data.alternatives.length, 1)
  assert.equal(unavailable.data.alternatives[0].referenceable, false)
  assert.equal(requests.filter((item) => item.body.url?.endsWith('/broken')).length, 1, '404 is not blindly retried')
  assert.equal(saved.length, 0); assert(!JSON.stringify(unavailable).includes(key))
  const replacement = await tools[1].execute({ url: unavailable.data.alternatives[0].url })
  assert.equal(replacement.status, 'ok'); assert.equal(replacement.data.url, 'https://official.example.com/readable')
  assert.deepEqual(replacement.evidenceIds, ['evidence_alternative']); assert.equal(saved.length, 1)
})

test('transient provider failure retries once with measured request usage while access denial does not bypass a source', async () => {
  let requests = 0; let saves = 0
  const gateway = createWebResearchGateway({ env, request: async () => ++requests === 1 ? json({ error: {} }, 503) : json({ title: 'Restored', content: 'Readable source after a transient error.' }) })
  const fetched = await tool(gateway, 'fetch_page', { onEvidence: () => { saves++; return 'evidence_retry' } }).execute({ url: 'https://example.org/source' })
  assert.equal(fetched.status, 'ok'); assert.equal(fetched.usage.providerRequests, 2)
  assert.equal(requests, 2); assert.equal(saves, 1)
  let deniedRequests = 0
  const denied = createWebResearchGateway({ env, request: async () => { deniedRequests++; return json({ error: {} }, 403) } })
  const blocked = await tool(denied, 'fetch_page', { onEvidence: () => assert.fail('No body was obtained') }).execute({ url: 'https://x.com/public-example' })
  assert.equal(blocked.status, 'error'); assert.deepEqual(blocked.evidenceIds, [])
  assert.equal(blocked.error.code, 'SOURCE_ACCESS_DENIED'); assert.equal(blocked.error.actionRequired, true)
  assert.equal(blocked.error.recoverable, undefined); assert.equal(blocked.data, null)
  assert.equal(deniedRequests, 1)
})

test('market quote capability is restricted by role and fixture quotes remain synthetic without network access', async () => {
  let calls = 0; const records = []
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: clock,
    request: async () => { calls++; throw new Error('No live calls in fixture mode') },
  })
  for (const roleId of ['official', 'timeline', 'verification', 'social', undefined]) {
    assert(!gateway.toolsFor({ roleId }).some((item) => item.toolId === 'get_market_quote'))
  }
  for (const roleId of ['main', 'statistics', 'market']) {
    const quote = gateway.toolsFor({ roleId, onEvidence: async (record) => { records.push(record); return { evidenceId: `quote_${roleId}` } } }).find((item) => item.toolId === 'get_market_quote')
    assert(quote)
    const result = await quote.execute({ pair: 'BTC-USD' })
    assert.equal(result.data.synthetic, true); assert.equal(result.data.value, 100)
    assert.equal(result.data.sourcePublishedAt, null); assert.equal(result.data.timestampMeaning, 'system-observation-time')
    assert.deepEqual(result.evidenceIds, [`quote_${roleId}`])
  }
  assert.equal(calls, 0)
  assert(records.every((record) => record.evidenceKind === 'market_quote' && record.referenceable && record.fixture && record.scoringEligible === false))
  assert.deepEqual(gateway.capabilities.marketQuote.roles, ['main', 'statistics', 'market'])
})

test('live public quote is a fixed anonymous price request and its original data is saved before citation', async () => {
  let stored
  const gateway = createWebResearchGateway({ env, now: clock, request: async (url, options) => {
    assert.equal(url, 'https://api.coinbase.com/v2/prices/ETH-USD/spot')
    assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, undefined)
    return json({ data: { amount: '3200.25', currency: 'USD', base: 'ETH' } })
  } })
  const quote = gateway.toolsFor({ roleId: 'main', onEvidence: async (record) => { stored = record; return 'evidence_price' } }).find((item) => item.toolId === 'get_market_quote')
  const result = await quote.execute({ pair: 'ETH-USD' })
  assert.equal(result.data.value, 3200.25); assert.equal(result.data.synthetic, false)
  assert.equal(stored.marketQuote.value, result.data.value); assert.equal(stored.sourceMode, 'live')
  assert.equal(stored.publishedAt, null); assert.equal(stored.evidenceKind, 'market_quote')
})

test('fixture pages are explicit replay material, injectable for polling tests and never silently advance', async () => {
  let version = 1; const records = []
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: clock,
    fixturePages: () => [{ url: 'https://example.com/course-lab/official', title: '虚构材料', text: `【静态演示】版本${version}` }],
    request: async () => { throw new Error('fixture must not use network') },
  })
  const scoped = () => gateway.toolsFor({ roleId: 'official', sourceDomains: ['example.com'], onEvidence: async (record) => { records.push(record); return { evidenceId: `fixture_${records.length}` } } })
  const firstTools = scoped()
  assert.equal((await firstTools[0].execute({ query: 'demo' })).data.mode, 'mock')
  const first = await firstTools[1].execute({ url: 'https://example.com/course-lab/official' })
  assert.equal(first.data.fixture, true); assert.equal(first.data.sourceMode, 'replay')
  assert.equal(records[0].scoringEligible, false)
  version = 2
  const sameScope = await firstTools[1].execute({ url: 'https://example.com/course-lab/official' })
  assert.equal(sameScope.data.text, first.data.text)
  const next = await scoped()[1].execute({ url: 'https://example.com/course-lab/official' })
  assert.notEqual(next.data.contentHash, first.data.contentHash)
  const unknown = await scoped()[1].execute({ url: 'https://example.com/not-a-fixture' })
  assert.equal(unknown.error.code, 'SOURCE_CONTENT_MISSING'); assert.deepEqual(unknown.evidenceIds, [])
})


test('campus and custom model keys are not forwarded to the official search service', async () => {
  let requests = 0
  for (const url of ['https://genai.comp.polyu.edu.hk/api/v1//chat/completions', 'https://proxy.example/custom/invoke']) {
    const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_CHAT_COMPLETIONS_URL: url, WORLD_API_KEY: 'CAMPUS_MODEL_KEY_NOT_OFFICIAL' }, request: async () => { requests++; throw new Error('unexpected official request') } })
    assert.equal(gateway.capabilities.available, false)
    assert.equal(gateway.capabilities.reason, 'SEARCH_NOT_CONFIGURED')
    assert.equal(gateway.capabilities.sourceMode, 'live', 'public live tools are not replay when official search is unconfigured')
  }
  assert.equal(requests, 0)
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_CHAT_COMPLETIONS_URL: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', WORLD_API_KEY: 'CAMPUS_MODEL_KEY_NOT_OFFICIAL', WORLD_SEARCH_API_KEY: 'SEPARATE_OFFICIAL_KEY' }, request: async () => {} })
  assert.equal(gateway.capabilities.available, true)
})

test('missing focus degrades to real saved text and later focus reuses the body without fetching again', async () => {
  let requests = 0; const records = []
  const content = 'Source introduction\n' + 'A'.repeat(5000) + '\nNet revenue\nRevenue was $12 billion for the current quarter.'
  const gateway = createWebResearchGateway({ env, request: async () => { requests++; return json({ title: 'Quarterly report', content }) } })
  const fetcher = tool(gateway, 'fetch_page', { onEvidence: (record) => { records.push(record); return 'excerpt_' + records.length } })
  const partial = await fetcher.execute({ url: 'https://example.org/report', focus: 'nonexistent phrase' })
  assert.equal(partial.status, 'partial'); assert.equal(partial.error, null)
  assert.equal(partial.data.focusMatched, false); assert.equal(partial.data.focusMatch, 'not-found')
  assert(content.includes(partial.data.text)); assert(!partial.data.text.includes('nonexistent phrase'))
  assert(partial.data.citationHints.every(quote => partial.data.text.includes(quote)))
  const found = await fetcher.execute({ url: 'https://example.org/report', focus: 'Net revenue' })
  assert.equal(found.data.focusMatched, true); assert.equal(found.data.rawCached, true)
  assert(found.data.text.includes('$12 billion')); assert(content.includes(found.data.text))
  assert.equal(found.usage.providerRequests, 0); assert.equal(requests, 1); assert.equal(records.length, 2)
  assert.notEqual(partial.data.evidenceId, found.data.evidenceId)
})

test('focus tolerates original line breaks but the saved evidence is never normalized or fabricated', async () => {
  const content = 'Quarterly figures\nNet\n  revenue was $12 billion.\nKeep this original spacing.'
  const gateway = createWebResearchGateway({ env, request: async () => json({ title: 'Financial statement', content }) })
  const output = await tool(gateway, 'fetch_page', { onEvidence: () => 'original_spacing' }).execute({ url: 'https://example.org/report', focus: 'Net revenue' })
  assert.equal(output.status, 'ok'); assert.equal(output.data.focusMatched, true)
  assert.equal(output.data.focusMatch, 'whitespace'); assert.equal(output.data.text, content)
  assert(output.data.citationHints.every(quote => content.includes(quote)))
})

test('a run-scoped body cache coalesces readers but still persists evidence separately and never crosses runs or source permissions', async () => {
  let requests = 0; const readers = []
  const gateway = createWebResearchGateway({ env, request: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 5)); return json({ content: `Body version ${requests}. Revenue was $12 billion.`, title: 'Original report' }) } })
  const scoped = (roleId, scope) => tool(gateway, 'fetch_page', { roleId, cacheScope: scope,
    onEvidence: (record, context) => { readers.push({ roleId, text: record.text, reader: context.assignmentId }); return 'reader_' + context.assignmentId } })
  const first = scoped('statistics', 'run_1'), second = scoped('verification', 'run_1')
  const [a, b] = await Promise.all([
    first.execute({ url: 'https://example.org/source' }, { assignmentId: 'stat_1' }),
    second.execute({ url: 'https://example.org/source', focus: 'missing term' }, { assignmentId: 'verify_1' }),
  ])
  assert.equal(requests, 1); assert.equal(readers.length, 2)
  assert.deepEqual(a.evidenceIds, ['reader_stat_1']); assert.deepEqual(b.evidenceIds, ['reader_verify_1'])
  assert.equal(a.usage.providerRequests + b.usage.providerRequests, 1)
  assert.equal(b.data.rawCached, true); assert.equal(b.data.focusMatched, false)
  const forbidden = tool(gateway, 'fetch_page', { roleId: 'official', sourceDomains: ['other.example.org'], cacheScope: 'run_1', onEvidence: () => assert.fail('No cross-scope saved evidence') })
  assert.equal((await forbidden.execute({ url: 'https://example.org/source' })).error.code, 'SOURCE_SCOPE_MISMATCH')
  const later = await scoped('statistics', 'run_2').execute({ url: 'https://example.org/source' }, { assignmentId: 'stat_2' })
  assert.equal(requests, 2); assert.notEqual(a.data.contentHash, later.data.contentHash)
})

test('access barriers never become cited evidence and repeating focus does not re-fetch the blocked page', async () => {
  for (const page of [
    { title: 'Your browser is unsupported', content: 'Your browser is unsupported. Please download a supported browser to view this page.' },
    { title: 'Just a moment...', content: 'Checking your browser. Please verify you are human.' },
    { title: 'Site', content: 'Please enable JavaScript and cookies to continue.' },
  ]) {
    let requests = 0
    const gateway = createWebResearchGateway({ env, request: async () => { requests++; return json(page) } })
    const fetcher = tool(gateway, 'fetch_page', { onEvidence: () => assert.fail('Do not save challenge text') })
    const first = await fetcher.execute({ url: 'https://example.org/blocked', focus: 'price' })
    const second = await fetcher.execute({ url: 'https://example.org/blocked', focus: 'revenue' })
    assert.equal(first.error.code, 'SOURCE_CONTENT_MISSING'); assert.deepEqual(first.evidenceIds, [])
    assert.equal(first.data.referenceable, false); assert.equal(second.usage.providerRequests, 0)
    assert.equal(requests, 1)
  }
})

test('spot quote is omitted for unsupported assets and its schema only advertises the supported asset in the question', () => {
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' } })
  for (const question of ['英伟达股票走势', '黄金未来会涨吗', { question: 'NVIDIA forecast', object: 'NASDAQ NVDA stock' }]) {
    for (const roleId of ['main', 'statistics', 'market']) {
      assert(!gateway.toolsFor({ roleId, question }).some(tool => tool.toolId === 'get_market_quote'))
    }
  }
  const btc = gateway.toolsFor({ roleId: 'market', question: '比特币接下来会涨吗' }).find(tool => tool.toolId === 'get_market_quote')
  assert.deepEqual(btc.inputSchema.properties.pair.enum, ['BTC-USD'])
  const eth = gateway.toolsFor({ roleId: 'statistics', question: { question: 'Will ETH fall?' } }).find(tool => tool.toolId === 'get_market_quote')
  assert.deepEqual(eth.inputSchema.properties.pair.enum, ['ETH-USD'])
})

test('coalesced fetch failures count the external request once and do not leak a provider body', async () => {
  let requests = 0
  const gateway = createWebResearchGateway({ env: { ...env, WORLD_SEARCH_MAX_RETRIES: '0' }, request: async () => {
    requests++; await new Promise(resolve => setTimeout(resolve, 5)); return json({ error: `private account ${key}` }, 503)
  } })
  const scoped = () => tool(gateway, 'fetch_page', { cacheScope: 'run_error', onEvidence: () => assert.fail('No response text') })
  const [first, second] = await Promise.all([scoped().execute({ url: 'https://example.org/failure' }), scoped().execute({ url: 'https://example.org/failure' })])
  assert.equal(requests, 1); assert.equal(first.usage.providerRequests + second.usage.providerRequests, 1)
  for (const value of [first, second]) {
    assert.equal(value.error.code, 'SOURCE_HTTP_ERROR'); assert.deepEqual(value.evidenceIds, [])
    assert(!JSON.stringify(value).includes(key))
  }
})

test('cancelling one joined reader does not save its evidence or cancel the other reader', async () => {
  let finish; const started = new Promise(resolve => { finish = resolve }); const cancelled = new AbortController(); const saved = []
  const gateway = createWebResearchGateway({ env, request: async () => { await started; return json({ content: 'An actual source body with report data.' }) } })
  const scoped = name => tool(gateway, 'fetch_page', { cacheScope: 'run_cancel', onEvidence: () => { saved.push(name); return 'source_' + name } })
  const owner = scoped('owner').execute({ url: 'https://example.org/source' })
  const reader = scoped('cancelled').execute({ url: 'https://example.org/source' }, { signal: cancelled.signal })
  cancelled.abort()
  const aborted = await reader
  assert.equal(aborted.error.code, 'TOOL_CANCELLED'); assert.deepEqual(aborted.evidenceIds, [])
  finish(); const completed = await owner
  assert.equal(completed.status, 'ok'); assert.deepEqual(saved, ['owner'])
})
