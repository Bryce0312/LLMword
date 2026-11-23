import { createHash } from 'node:crypto'
import { abortable } from '../runtime/model-provider.mjs'

const pairs = ['BTC-USD', 'ETH-USD']
const schema = { type: 'object', additionalProperties: false, properties: { pair: { enum: pairs } }, required: ['pair'] }
const resultSchema = { type: 'object', properties: { status: { enum: ['ok', 'error'] }, data: {}, evidenceIds: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, observedAt: { type: 'string' }, error: { type: ['object','null'] }, usage: { type: ['object','null'] } }, required: ['status','data','evidenceIds','summary','observedAt','error','usage'] }
const failure = code => Object.assign(new Error(code), { quoteCode: code })

/** Public read-only spot quotes. No authentication, arbitrary URLs, trading or fabricated live fallback. */
export function createMarketQuoteTool({ request = fetch, now = () => new Date(), onEvidence, mode = 'live', timeoutMs = 15000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid quote timeout')
  if (!['live','replay','mock','fixture'].includes(mode)) throw new Error('Invalid quote mode')
  const cache = new Map()
  const stamp = () => new Date(now()).toISOString()
  return { toolId: 'get_market_quote', version: 1,
    description: '读取 BTC-USD 或 ETH-USD 当前 Coinbase 现价并保存可引用快照。observedAt是本系统取得时刻，不是交易所成交时间；报价是价格基准，不是未来预测。',
    inputSchema: structuredClone(schema), resultSchema: structuredClone(resultSchema), timeoutMs: timeoutMs + 1000,
    async execute(args, context = {}) {
      let timerSignal
      try {
        if (!args || Object.keys(args).length !== 1 || !pairs.includes(args.pair)) throw failure('INVALID_QUOTE_PAIR')
        if (context.signal?.aborted) throw failure('TOOL_CANCELLED')
        if (typeof onEvidence !== 'function') throw failure('EVIDENCE_SINK_REQUIRED')
        if (cache.has(args.pair)) { const cached = structuredClone(cache.get(args.pair)); cached.data.cached = true; return cached }
        timerSignal = AbortSignal.timeout(timeoutMs)
        const signal = context.signal ? AbortSignal.any([context.signal, timerSignal]) : timerSignal
        return await abortable(async () => {
          const fixture = mode !== 'live'
          const url = fixture ? `https://example.com/course-lab/market/${args.pair}` : `https://api.coinbase.com/v2/prices/${args.pair}/spot`
          let value, currency = 'USD'
          if (fixture) value = args.pair === 'BTC-USD' ? 100 : 20
          else {
            const response = await request(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal })
            if (!response.ok) throw failure('QUOTE_HTTP_ERROR')
            if (Number(response.headers?.get?.('content-length')) > 16384) throw failure('QUOTE_RESPONSE_INVALID')
            let raw = ''
            if (response.body?.getReader) {
              const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0
              try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16384) { await reader.cancel(); throw failure('QUOTE_RESPONSE_INVALID') }; raw += decoder.decode(chunk.value, { stream: true }) }; raw += decoder.decode() }
              finally { reader.releaseLock() }
            } else raw = await response.text()
            if (Buffer.byteLength(raw) > 16384) throw failure('QUOTE_RESPONSE_INVALID')
            let data; try { data = JSON.parse(raw).data } catch { throw failure('QUOTE_RESPONSE_INVALID') }
            value = Number(data?.amount); currency = data?.currency
            if (typeof data?.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(data.amount) || !Number.isFinite(value) || value <= 0 || currency !== 'USD' || (data.base && data.base !== args.pair.split('-')[0])) throw failure('QUOTE_RESPONSE_INVALID')
          }
          const observedAt = stamp()
          const marketQuote = { provider: fixture ? 'synthetic-course-quote' : 'coinbase', pair: args.pair, value, currency, observedAt, sourcePublishedAt: null, timestampMeaning: 'system-observation-time', url }
          // Observation timestamps are metadata; an unchanged price must keep the same content hash.
          const text = JSON.stringify({ provider: marketQuote.provider, pair: args.pair, value, currency, sourcePublishedAt: null })
          const record = { title: fixture ? `【虚构】${args.pair} 报价样例` : `Coinbase ${args.pair} 现价快照`, url, text,
            publishedAt: null, observedAt, contentHash: createHash('sha256').update(text).digest('hex'),
            sourceMode: fixture ? 'replay' : 'live', marketQuote, ...(fixture ? { fixture: true, scoringEligible: false } : {}) }
          if (signal.aborted) throw failure('TOOL_CANCELLED')
          let receipt; try { receipt = await onEvidence(structuredClone(record), context) } catch { throw failure('EVIDENCE_SAVE_FAILED') }
          if (signal.aborted) throw failure('TOOL_CANCELLED')
          const evidenceId = typeof receipt === 'string' ? receipt : receipt?.evidenceId
          if (typeof evidenceId !== 'string' || !evidenceId.trim()) throw failure('EVIDENCE_SAVE_FAILED')
          const result = { status: 'ok', data: { ...marketQuote, evidenceId, cached: false, synthetic: fixture }, evidenceIds: [evidenceId], observedAt,
            summary: fixture ? '已保存虚构报价样例，不是真实市场价格。' : `已取得并保存 ${args.pair} 现价 ${value} ${currency}；时间为系统取得时刻。`, error: null, usage: null }
          cache.set(args.pair, structuredClone(result)); return result
        }, signal)
      } catch (error) {
        const code = context.signal?.aborted ? 'TOOL_CANCELLED' : timerSignal?.aborted ? 'QUOTE_TIMEOUT' : error.quoteCode || 'QUOTE_UNAVAILABLE'
        const summary = code === 'INVALID_QUOTE_PAIR' ? '仅支持 BTC-USD 或 ETH-USD；不能提供任意目标地址。' : code === 'TOOL_CANCELLED' ? '报价读取已取消。' : code === 'EVIDENCE_SAVE_FAILED' ? '取得报价但未能保存证据，不能引用为基准。' : '未取得可核验的现价，不能编造价格基准；可继续搜集公开资料。'
        return { status: 'error', data: null, evidenceIds: [], summary, observedAt: stamp(), error: { code, message: summary, retryable: ['QUOTE_UNAVAILABLE','QUOTE_HTTP_ERROR','QUOTE_TIMEOUT'].includes(code) }, usage: null }
      }
    } }
}
