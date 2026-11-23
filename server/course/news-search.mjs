export const textLanguage = (text = '') => {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko'
  if (/[\u0400-\u04ff]/u.test(text)) return 'ru'
  if (/[\u0600-\u06ff]/u.test(text)) return 'ar'
  if (/[\u0900-\u097f]/u.test(text)) return 'hi'
  const han = (text.match(/[\u3400-\u9fff]/gu) || []).length, latin = (text.match(/[a-z]/gi) || []).length
  return han && han / (han + latin) > .12 ? 'zh' : latin > 2 ? 'en' : han ? 'zh' : 'unknown'
}
export function canonicalNewsUrl(value) {
  const url = new URL(value); url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|spm|from)$/i.test(key)) url.searchParams.delete(key)
  return url.href
}
export function createNewsSearchTool(search) {
  const query = { type: 'string', minLength: 1, maxLength: 100 }
  return { toolId: 'search_news', version: 2, timeoutMs: search.timeoutMs,
    description: '按题选择最多三路任意语言查询，可记录language和market、选择可选搜索引擎；兼容queryZh/queryEn。按来源原始语言取证，不必固定中英。结果仅为线索，须读正文；市场意图不保证独立地区索引。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      queryZh: query, queryEn: query, maxResults: { type: 'integer', minimum: 1, maximum: 3 },
      queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, properties: {
        query, language: { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$', maxLength: 20 },
        market: { type: 'string', pattern: '^[a-z]{2}-[A-Z]{2}$' }, engine: { enum: ['deepseek', 'auto', 'bing-domestic', 'bing-international'] },
      }, required: ['query', 'language'] } },
    }, oneOf: [{ properties: { queryZh: query, queryEn: query, queries: false }, required: ['queryZh', 'queryEn'] }, { properties: { queries: {}, queryZh: false, queryEn: false }, required: ['queries'] }] },
    resultSchema: search.resultSchema,
    async execute(args, context) {
      const queries = args.queries || [{ language: 'zh', query: args.queryZh }, { language: 'en', query: args.queryEn }]
      if (!Array.isArray(queries) || !queries.length || queries.length > 3 || queries.some(x => typeof x.query !== 'string' || !x.query.trim() || !x.language)) return { status: 'error', data: null, evidenceIds: [], summary: '新闻查询格式无效。', observedAt: new Date().toISOString(), error: { code: 'INVALID_ARGUMENTS' }, usage: { providerRequests: 0 } }
      const responses = await Promise.all(queries.map(async ({ language, query, market, engine }) => {
        try { return { language, query, market, result: await search.execute({ query, maxResults: args.maxResults || 3, ...(search.inputSchema?.properties?.language ? { language } : {}), ...(market ? { market } : {}), ...(engine ? { engine } : {}) }, context) } }
        catch { return { language, query, market, result: { status: 'error', error: { code: 'SOURCE_TOOL_FAILED', message: '新闻检索未完成。' } } } }
      }))
      const merged = new Map()
      for (const entry of responses) for (const candidate of entry.result.data?.results || []) {
        let key; try { key = canonicalNewsUrl(candidate.url) } catch { continue }
        if (merged.has(key)) { const prior = merged.get(key); prior.queryLanguages = [...new Set([...prior.queryLanguages, entry.language])]; continue }
        merged.set(key, { ...candidate, canonicalUrl: key, queryLanguages: [entry.language], languageHint: textLanguage(candidate.title), referenceable: false, independence: 'unverified-read-original-and-check-syndication' })
      }
      const success = responses.filter((item) => item.result.status !== 'error').length
      return { status: success === responses.length ? 'ok' : success ? 'partial' : 'error',
        data: { queries: responses.map(({ language, query, market, result }) => ({ language, query, market: market || null, status: result.status, error: result.error || null, provenance: result.data?.provenance || null })), results: [...merged.values()], referenceable: false },
        evidenceIds: [], observedAt: responses.find(x => x.result.observedAt)?.result.observedAt || new Date().toISOString(),
        summary: '按所选语言检索公开线索；读取原文并核验首发及转载后才能引用。',
        error: success ? null : { code: 'NEWS_SEARCH_UNAVAILABLE', message: '所有所选新闻查询均未完成。', retryable: false },
        usage: { providerRequests: responses.reduce((n, item) => n + (item.result.usage?.providerRequests || 0), 0), publicSearchActions: responses.reduce((n, item) => n + (item.result.usage?.publicSearchActions || 0), 0) } }
    } }
}
