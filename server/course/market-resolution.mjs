import { createHash } from 'node:crypto'

export const PRICE_POLICY = 'binance-btc-usdt-higher-v1'
export const PRICE_URL = 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT'
export const PRICE_DIRECTION_RULE = '以本轮市场研究员首次成功取得的Binance BTC-USDT现价为固定基准；目标时点后5分钟内首次成功取得同一接口的有效现价，高于、等于、低于基准分别记为上涨、持平、下跌；未取得有效现价则不结算。取得时刻是系统观察时间，计价单位为USDT。'
export const PRICE_RULE = '以本轮市场研究员首次成功取得的Binance BTC-USDT现价为固定基准；目标时点后5分钟内首次成功取得同一接口的有效现价严格高于基准则Yes，等于或低于则No；未在观察窗口取得有效现价则不结算。取得时刻是系统观察时间，不声称精确成交时刻。USDT不等同于USD。'
const historyOrigin = 'https://data-api.binance.vision/api/v3/klines'
const fail = code => Object.assign(new Error(code), { priceCode: code })

async function boundedJson(response, limit) {
  if (!response.ok || Number(response.headers?.get?.('content-length')) > limit) { await response.body?.cancel?.(); throw fail('PRICE_HTTP') }
  let text = '', size = 0
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder()
    try { for (;;) { const {value,done} = await reader.read(); if(done)break; size+=value.byteLength; if(size>limit){ await reader.cancel(); throw fail('PRICE_BODY_LIMIT') }; text+=decoder.decode(value,{stream:true}) }; text+=decoder.decode() } finally { reader.releaseLock() }
  } else text=await response.text()
  if(Buffer.byteLength(text)>limit)throw fail('PRICE_BODY_LIMIT')
  return JSON.parse(text)
}

/** Fresh reader, deliberately not reusing a worker's pre-target quote cache. */
export async function readPriceSnapshot({ request=fetch, now=()=>new Date(), mode='live', signal }={}) {
  if(!['live','mock'].includes(mode))throw fail('PRICE_MODE')
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),fixture=mode!=='live'
  const raw=fixture?{symbol:'BTCUSDT',price:'100'}:await boundedJson(await request(PRICE_URL,{headers:{Accept:'application/json','Cache-Control':'no-cache'},redirect:'error',signal:combined}),16384)
  if(combined.aborted||raw?.symbol!=='BTCUSDT'||typeof raw.price!=='string'||!/^\d{1,16}(?:\.\d{1,16})?$/.test(raw.price)||!Number.isFinite(Number(raw.price))||Number(raw.price)<=0)throw fail('PRICE_INVALID')
  const obtainedAt=new Date(now()).toISOString(),provider=fixture?'synthetic-price-quote':'binance-public'
  const marketQuote={provider,pair:'BTC-USDT',value:Number(raw.price),currency:'USDT',observedAt:obtainedAt,url:PRICE_URL,sourcePublishedAt:null,timestampMeaning:'system-observation-time'}
  const text=JSON.stringify({provider,pair:'BTC-USDT',value:marketQuote.value,currency:'USDT',rawSpot:raw,systemObservedAt:obtainedAt})
  const citationHints=[`"pair":"BTC-USDT","value":${marketQuote.value},"currency":"USDT"`,JSON.stringify(raw).slice(1,-1),`"systemObservedAt":"${obtainedAt}"`]
  return {title:fixture?'【虚构】BTC-USDT现价样例':'Binance BTC-USDT现价快照',url:PRICE_URL,text,marketQuote,obtainedAt,observedAt:obtainedAt,publishedAt:null,
    contentHash:createHash('sha256').update(text).digest('hex'),sourceMode:fixture?'replay':'live',fixture,evidenceFormat:'json',citationHints}
}

export function parsePriceSnapshot(source, {allowFixture=false}={}) {
  const raw=JSON.parse(source.text), quote=source.marketQuote
  if(source.url!==PRICE_URL || ![...(allowFixture?['synthetic-price-quote']:[]),'binance-public'].includes(raw.provider) || raw.pair!=='BTC-USDT' || raw.currency!=='USDT' || raw.rawSpot?.symbol!=='BTCUSDT' || typeof raw.rawSpot.price!=='string' || !/^\d{1,16}(?:\.\d{1,16})?$/.test(raw.rawSpot.price) || Number(raw.rawSpot.price)!==raw.value ||
    !Number.isFinite(raw.value) || raw.value<=0 || quote?.pair!==raw.pair || quote.value!==raw.value || quote.currency!==raw.currency || quote.provider!==raw.provider ||
    quote.url!==PRICE_URL || quote.observedAt!==source.obtainedAt || raw.systemObservedAt!==source.obtainedAt)throw fail('PRICE_INVALID')
  return raw.value
}

export function createPriceQuoteTool({request=fetch,now=()=>new Date(),mode='live',onEvidence}={}) {
  let cached
  return {toolId:'get_market_quote',version:2,timeoutMs:16000,inputSchema:{type:'object',additionalProperties:false,properties:{pair:{enum:['BTC-USDT']}},required:['pair']},
    description:'只读Binance BTC-USDT现价，保存可逐字引用的data.text和原始rawSpot。USDT不是USD；取得时间是系统观察时刻，不是成交时刻；不是未来结果。',
    async execute(args,context={}){
      try{
        if(args?.pair!=='BTC-USDT'||Object.keys(args).length!==1||typeof onEvidence!=='function'||context.signal?.aborted)throw fail('PRICE_ARGUMENTS')
        if(cached)return structuredClone(cached)
        const record=await readPriceSnapshot({request,now,mode,signal:context.signal}),receipt=await onEvidence(record,context),evidenceId=typeof receipt==='string'?receipt:receipt?.evidenceId
        if(!evidenceId||context.signal?.aborted)throw fail('PRICE_SAVE_FAILED')
        cached={status:'ok',data:{...record.marketQuote,text:record.text,citationHints:record.citationHints,evidenceId,synthetic:record.fixture},evidenceIds:[evidenceId],observedAt:record.obtainedAt,summary:'已读取并保存BTC-USDT现价；优先逐字复制citationHints，不把目标时间写成来源事实。',error:null,usage:{publicRequests:record.fixture?0:1}}
        return structuredClone(cached)
      }catch(error){return {status:'error',data:null,evidenceIds:[],observedAt:new Date(now()).toISOString(),summary:'未取得有效BTC-USDT现价，不能编造基准。',error:{code:error.priceCode||'PRICE_UNAVAILABLE',message:'公开报价不可核验。',retryable:false},usage:null}}
    }}
}

export function parsePriceHistory(raw, observedAt) {
  const end=Math.floor(Date.parse(observedAt)/60000)*60
  if(!Number.isFinite(end)||!Array.isArray(raw)||raw.length>300)throw fail('PRICE_HISTORY_INVALID')
  const seen=new Set(), candles=[]
  for(const row of raw) {
    if(!Array.isArray(row)||row.length!==6||row.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw fail('PRICE_HISTORY_INVALID')
    const [time,low,high,open,close,volume]=row
    if(!Number.isInteger(time)||time%60||low<=0||high<low||open<low||open>high||close<low||close>high||volume<0||seen.has(time))throw fail('PRICE_HISTORY_INVALID')
    seen.add(time)
    if(time>=end-1800 && time+60<=end)candles.push({time:new Date(time*1000).toISOString(),low,high,open,close,volume})
  }
  candles.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))
  if(candles.length<10)throw fail('PRICE_HISTORY_INSUFFICIENT')
  const first=candles[0],last=candles.at(-1)
  const returns=candles.slice(1).flatMap((c,i)=>Date.parse(c.time)-Date.parse(candles[i].time)===60000?[Math.log(c.close/candles[i].close)]:[])
  const mean=returns.reduce((a,b)=>a+b,0)/(returns.length||1)
  const sd=Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/Math.max(1,returns.length-1))
  return {pair:'BTC-USDT',granularitySeconds:60,closedCandlesOnly:true,expectedCandles:30,availableCandles:candles.length,
    missingCandles:30-candles.length,firstBucket:first.time,lastBucket:last.time,firstOpen:first.open,lastClose:last.close,
    observedReturnPct:(last.close/first.open-1)*100,adjacentReturnCount:returns.length,sampleMinuteLogReturnSd:sd,
    methods:'returnPct=(lastClose/firstOpen-1)*100; sd=sample SD of adjacent minute log(close/previousClose); gaps excluded; descriptive sample, not calibrated future probability',candles}
}

export function createMarketHistoryTool({request=fetch,now=()=>new Date(),mode='live',onEvidence}={}) {
  return {toolId:'get_market_history',version:1,timeoutMs:16000,inputSchema:{type:'object',additionalProperties:false,properties:{pair:{enum:['BTC-USDT']}},required:['pair']},
    description:'读取Binance BTC-USDT最近30个已关闭分钟桶，保存原始K线、规范化字段及确定性样本收益/波动。样本不校准未来概率，分钟收盘不能替代目标现价。',
    async execute(args,context={}){
      try{
        if(!['live','mock'].includes(mode))throw fail('PRICE_MODE')
        if(args?.pair!=='BTC-USDT'||Object.keys(args).length!==1||typeof onEvidence!=='function')throw fail('PRICE_HISTORY_ARGUMENTS')
        const signal=context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)
        const startAt=new Date(now()), end=Math.floor(startAt.valueOf()/60000)*60000
        const url=historyOrigin+'?symbol=BTCUSDT&interval=1m&limit=30&endTime='+(end-1)
        const fixture=mode!=='live'
        const raw=fixture?Array.from({length:30},(_,i)=>[end-1800000+i*60000,'100','102','99',String(100+i/100),'1',end-1800000+(i+1)*60000-1,'100',1,'1','100','0']):await boundedJson(await request(url,{headers:{Accept:'application/json','Cache-Control':'no-cache'},redirect:'error',signal}),65536)
        if(!Array.isArray(raw)||raw.length>300||raw.some(row=>!Array.isArray(row)||row.length!==12||!Number.isInteger(row[0])||!Number.isInteger(row[6])||row[6]!==row[0]+59999))throw fail('PRICE_HISTORY_INVALID')
        const canonical=raw.map(row=>[row[0]/1000,Number(row[3]),Number(row[2]),Number(row[1]),Number(row[4]),Number(row[5])])
        if(signal.aborted)throw fail('PRICE_CANCELLED')
        const obtainedAt=new Date(now()).toISOString(), history=parsePriceHistory(canonical,startAt.toISOString())
        const {candles,...statistics}=history
        const text=JSON.stringify({provider:fixture?'synthetic-course-history':'binance-public',...statistics})
        const citationHints=[`"firstBucket":"${history.firstBucket}","lastBucket":"${history.lastBucket}"`,`"firstOpen":${history.firstOpen},"lastClose":${history.lastClose}`,`"availableCandles":${history.availableCandles},"missingCandles":${history.missingCandles}`,`"observedReturnPct":${history.observedReturnPct}`]
        const record={title:fixture?'【虚构】BTC分钟桶样例':'Binance BTC-USDT已关闭分钟桶',url,text,publishedAt:null,obtainedAt,
          contentHash:createHash('sha256').update(text).digest('hex'),sourceMode:fixture?'replay':'live',fixture,marketHistory:history,rawCandles:raw,evidenceFormat:'json',citationHints}
        const receipt=await onEvidence(record,context),evidenceId=typeof receipt==='string'?receipt:receipt?.evidenceId
        if(!evidenceId||signal.aborted)throw fail('PRICE_HISTORY_SAVE_FAILED')
        return {status:'ok',data:{title:record.title,url,text,evidenceId,marketHistory:statistics,citationHints},evidenceIds:[evidenceId],observedAt:obtainedAt,summary:'已读取已关闭分钟桶并计算样本摘要；完整原始K线已归档，此返回只含可引用统计，不能称读过逐根明细或已校准。',error:null,usage:{publicRequests:fixture?0:1}}
      }catch(error){return {status:'error',data:null,evidenceIds:[],observedAt:new Date(now()).toISOString(),summary:'未取得有效分钟桶，保留历史样本缺口。',error:{code:error.priceCode||'PRICE_HISTORY_UNAVAILABLE',message:'历史行情不可核验。',retryable:false},usage:null}}
    }}
}
