import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import { groundingPolicy, validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createNewsSearchTool } from './news-search.mjs'
import { searchBing } from './bing-search.mjs'

test('quoted claims reject foreign readers, invented excerpts and uncovered numeric subclaims', () => {
  const source = { evidenceId: 'a', text: 'Q3 FY2027 revenue is USD 120 billion.', readBy: ['worker'], obtainedAt: '2026-11-21T00:00:00Z' }
  const claim = { claim: 'Q3 FY2027 revenue is 120 billion USD.', evidenceIds: ['a'], basis: 'fact', citations: [{ evidenceId: 'a', quote: source.text }] }
  const options = { readerId: 'worker', asOf: '2026-11-21T01:00:00Z' }
  assert.equal(validateGroundedClaims([claim], [source], options).length, 1)
  for (const bad of [{ ...claim, claim: 'FY2028 revenue growth is 75%.' }, { ...claim, citations: [{ evidenceId: 'a', quote: 'invented source excerpt' }] }, { ...claim, evidenceIds: ['a', 'foreign'] }, { ...claim, citations: [] }]) assert.throws(() => validateGroundedClaims([bad], [source], options))
  assert.throws(() => validateGroundedClaims([claim], [source], { ...options, readerId: 'other' }))
  assert.throws(() => validateGroundedClaims([claim], [{ ...source, publishedAt: '2026-11-22T00:00:00Z' }], options))
  assert.equal(validateGroundedClaims([{ ...claim, claim: '条件推断，不作为未来已实现事实。', basis: 'inference' }], [source], options).length, 1)
})

test('JSON formatting tolerates insignificant whitespace but returns an actual unchanged excerpt', () => {
  const text = 'HKO warnsum complete JSON snapshot:\n{"code":"WFIRER","name":"Fire Danger"}'
  const source = { evidenceId: 'json', text, readBy: ['worker'], weatherWarning: { completeSnapshot: true } }
  const make = quote => ({ claim: '代码为红色火灾危险警告。', basis: 'fact', evidenceIds: ['json'], citations: [{ evidenceId: 'json', quote }] })
  const result = validateGroundedClaims([make('{ "code": "WFIRER", "name": "Fire Danger" }')], [source])
  assert.equal(result[0].citations[0].quote, '{"code":"WFIRER","name":"Fire Danger"}')
  for (const quote of ['{"code":"WFIREY","name":"Fire Danger"}', '{"code":"WFIRER","name":"Fire  Danger"}']) assert.throws(() => validateGroundedClaims([make(quote)], [source]))
})
test('observation prefix may use verified retrieval metadata, with subsecond display rounding only', () => {
  const source = { evidenceId: 'a', text: '"code":"WFIRER","type":"Red"', readBy: ['worker'], obtainedAt: '2026-11-21T06:20:41.990Z' }
  const make = claim => ({ claim, basis: 'fact', evidenceIds: ['a'], citations: [{ evidenceId: 'a', quote: source.text }] })
  assert.equal(validateGroundedClaims([make('截至06:20:42Z快照，代码为WFIRER。')], [source]).length, 1)
  for (const claim of ['截至06:20:43Z快照，代码为WFIRER。', '截至06:20:42Z快照，收入为42亿美元。']) assert.throws(() => validateGroundedClaims([make(claim)], [source]))
})

test('multilingual searches accept Japanese and Arabic without a browser and bound query channels', async () => {
  const queries = []
  const search = { inputSchema: { properties: { language: {} } }, async execute(args) { queries.push(args); return { status: 'ok', observedAt: '2026-11-21T00:00:00Z', data: { results: [{ url: 'https://example.com/source?utm_source=' + args.language, title: '原始报道' }] }, usage: { providerRequests: 1 } } } }
  const tool = createNewsSearchTool(search), valid = new Ajv({ strict: true }).compile(tool.inputSchema)
  const input = { queries: [{ query: '決算発表', language: 'ja', market: 'ja-JP' }, { query: 'تقرير الشركة', language: 'ar', market: 'ar-SA' }] }
  assert(valid(input)); assert(!valid({ queries: [...input.queries, ...input.queries] })); assert(!valid({ ...input, queryEn: 'mixed' }))
  const result = await tool.execute(input)
  assert.equal(result.status, 'ok'); assert.equal(result.data.results.length, 1); assert.deepEqual(result.data.results[0].queryLanguages, ['ja', 'ar'])
  assert.deepEqual(queries.map(x => x.language), ['ja', 'ar']); assert.deepEqual(result.evidenceIds, [])
})

test('Bing is optional: default needs no local browser or Bing access; failed opt-in falls back transparently', async () => {
  const calls = [], request = async (url, options) => {
    calls.push({ url, options })
    if (url.includes('bing.com')) { assert(!options.headers.Authorization); return new Response('challenge', { status: 200 }) }
    return Response.json({ results: [{ title: '公開資料', url: 'https://example.com/public', summary: 'candidate only' }] })
  }
  const make = (enabled) => createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_API_KEY: 'fixture-only', ...(enabled ? { WORLD_BING_SEARCH: 'enabled' } : {}) }, request }).toolsFor({ roleId: 'timeline' }).find(x => x.toolId === 'search_web')
  const args = { query: '日本 決算', engine: 'bing-international', language: 'ja', market: 'ja-JP' }
  const result = await make(false).execute(args)
  assert.equal(calls.length, 1); assert.equal(result.data.provenance.fallbackReason, 'BING_NOT_ENABLED')
  const fallback = await make(true).execute(args)
  assert.equal(fallback.data.provenance.fallbackReason, 'BING_RSS_UNAVAILABLE'); assert.equal(fallback.data.provenance.actualProvider, 'deepseek')
  assert.equal(fallback.evidenceIds.length, 0)
})

test('optional Bing preserves actual redirect provenance and rejects off-domain redirects', async () => {
  let count = 0
  const request = async () => ++count === 1 ? new Response('', { status: 302, headers: { location: 'https://cn.bing.com/search?q=test&format=rss' } }) : new Response('<rss><channel><item><title>A &amp; B</title><link>https://example.com/a</link><description>candidate</description></item></channel></rss>')
  const result = await searchBing({ query: 'test', request })
  assert.equal(result.provenance.actualHost, 'cn.bing.com'); assert.equal(result.provenance.redirected, true); assert.equal(result.provenance.independentIndexVerified, false)
  assert.equal(result.results[0].title, 'A & B')
  await assert.rejects(searchBing({ query: 'test', request: async () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }) }), /BING_REDIRECT_REJECTED/)
})

test('ten role matrix executes three distinct workers per question with grounded output', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'delivery-ten-roles-')), now = () => '2026-11-21T00:00:00Z'
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now })
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, evidencePolicy: groundingPolicy, provider: createCourseMockProvider(), sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now }), now })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  const seen = new Set()
  for (const question of ['公开科技展是否会举办？', 'BTC未来24小时会上涨吗？', '社群舆情和人物公开发言如何核验？', '行业供应链关系图有哪些反证？', '历史类比与基准率如何判断？']) {
    const created = service.createRequest({ purpose: 'research', question, watch: false }); await service.idle()
    const record = service.getRequest(created.requestId), roles = record.run.assignments.filter(x => !x.followUp)
    assert.equal(record.run.status, 'completed', JSON.stringify({ error: record.run.error, assignments: roles.map(x => ({ role: x.roleId, status: x.status, error: x.error })) }))
    assert.equal(roles.length, 3); assert.equal(new Set(roles.map(x => x.roleId)).size, 3)
    assert(roles.some(x => x.roleId === 'verification')); assert.equal(record.researchReport.groundingPolicy, groundingPolicy)
    for (const role of roles) { seen.add(role.roleId); assert.equal(role.investigationProfile.version, 'investigation-methods-v2'); assert.equal(role.report.status, 'complete') }
  }
  assert.equal(seen.size, 10)
})
