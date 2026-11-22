import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePriceHistory,readPriceSnapshot,createMarketHistoryTool,PRICE_URL } from './market-resolution.mjs'
import { runPriceCase } from '../../scripts/price-case.mjs'
import { createCourseStore } from './course-store.mjs'
import { readFileSync } from 'node:fs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

test('price outcome uses a fresh anonymous spot reader and validates failed JSON without fallback',async()=>{
  let calls=0
  const source=await readPriceSnapshot({now:()=> '2026-11-21T00:30:01Z',request:async(url,options)=>{calls++;assert.equal(url,PRICE_URL);assert(!options.headers.Authorization);assert.equal(options.redirect,'error');assert.equal(options.headers['Cache-Control'],'no-cache');return Response.json({symbol:'BTCUSDT',price:'101'})}})
  assert.equal(calls,1);assert.equal(source.marketQuote.value,101);assert.equal(source.obtainedAt,'2026-11-21T00:30:01.000Z')
  await assert.rejects(readPriceSnapshot({request:async()=>Response.json({symbol:'BTCUSDT',price:'0'})}))
})

test('minute context excludes open/future buckets, keeps gaps explicit and rejects inconsistent OHLC',()=>{
  const end=Date.parse('2026-11-21T00:30:00Z')/1000,rows=Array.from({length:31},(_,i)=>[end-1800+i*60,99,102,100,101,1])
  const result=parsePriceHistory(rows,'2026-11-21T00:30:04Z');assert.equal(result.availableCandles,30);assert.equal(result.lastBucket,'2026-11-21T00:29:00.000Z');assert.equal(result.observedReturnPct,1.0000000000000009)
  const sparse=parsePriceHistory(rows.filter((_,i)=>i!==4),'2026-11-21T00:30:04Z');assert.equal(sparse.missingCandles,1);assert.equal(sparse.adjacentReturnCount,27)
  assert.throws(()=>parsePriceHistory([...rows,rows[0]],'2026-11-21T00:30:04Z'))
  assert.throws(()=>parsePriceHistory([[end-60,100,99,100,100,1]],'2026-11-21T00:30:04Z'))
})

test('history fixture makes no network request and cannot accept an arbitrary URL or asset',async()=>{
  let calls=0,saves=0
  const tool=createMarketHistoryTool({mode:'mock',now:()=> '2026-11-21T00:30:00Z',request(){calls++;throw Error('must not connect')},onEvidence(){saves++;return 'saved'}})
  assert.equal((await tool.execute({pair:'BTC-USDT'})).status,'ok');assert.equal(calls,0);assert.equal(saves,1)
  for(const args of [{pair:'ETH-USD'},{pair:'BTC-USDT',url:'http://127.0.0.1'}])assert.equal((await tool.execute(args)).status,'error')
  assert.equal(saves,1)
})

test('bounded price mock closes for rise, equality and fall while retaining sealed records',async()=>{
  for(const value of [101,100,99]){const result=await runPriceCase({value});assert.equal(result.result.outcome,value>100?1:0);assert.equal(result.checks.length,8)}
})

test('a failed verification report cannot be replaced by two successful price researchers',async()=>{
  const result=await runPriceCase({incompleteVerification:true});assert.equal(result.rejected,true);assert(result.error)
})

test('a fixed result contract cannot bypass the reader with a direct outcome label',()=>{
  const store=createCourseStore({path:':memory:'})
  try{const request=store.createRequest({question:'fixed',resolutionPolicy:{version:'binance-btc-usdt-higher-v1'}});assert.throws(()=>store.recordResult(request.requestId,{outcome:1,evidenceIds:['fake']}),{code:'STRUCTURED_RESULT_REQUIRED'})}finally{store.close()}
})

test('actual failed market report now accepts exact decimal equivalence without another model call',()=>{
  const recorded=JSON.parse(readFileSync(new URL('../../docs/evidence/price-grounding-failure.json',import.meta.url),'utf8'))
  const report=recorded.reports.filter(item=>item.role==='market').at(-1).report
  const evidence=recorded.evidence.map(source=>({...source,readBy:['worker']}))
  assert.equal(validateGroundedClaims([...report.support,...report.counterevidence],evidence,{readerId:'worker'}).length,3)
  const tampered=JSON.parse(JSON.stringify(report.support));tampered[1].claim='原始价格为58263.35。';assert.throws(()=>validateGroundedClaims(tampered,evidence,{readerId:'worker'}))
  const precise={evidenceId:'p',text:'{"value":"9007199254740993.00"}',readBy:['worker']}
  const claim={claim:'值为9007199254740993。',basis:'fact',evidenceIds:['p'],citations:[{evidenceId:'p',quote:precise.text}]}
  assert.equal(validateGroundedClaims([claim],[precise]).length,1);assert.throws(()=>validateGroundedClaims([{...claim,claim:'值为9007199254740992。'}],[precise]))
})

test('structured price citations preserve real excerpts, refuse invented JSON braces and give owned hints',async()=>{
  const source={...await readPriceSnapshot({mode:'mock'}),evidenceId:'p',readBy:['worker']}
  const claim={claim:'当前报价为100 USDT。',basis:'fact',evidenceIds:['p'],citations:[{evidenceId:'p',quote:'"pair": "BTC-USDT", "value": 100, "currency": "USDT"'}]}
  assert.equal(validateGroundedClaims([claim],[source])[0].citations[0].quote,source.citationHints[0])
  const invalid={...claim,citations:[{evidenceId:'p',quote:'{"provider":"synthetic-price-quote","pair":"BTC-USDT","value":100,"currency":"USDT"}'}]}
  assert.throws(()=>validateGroundedClaims([invalid],[source]),/可逐字复制/)
  assert.throws(()=>validateGroundedClaims([claim],[source],{readerId:'foreign'}))
})

test('latest price is refreshed before summary, and a slow summary refreshes again without moving the baseline',async()=>{
  const result=await runPriceCase({lateSummary:true});assert.equal(result.forecast.currentReference.observedAt,'2026-11-21T00:03:00.000Z');assert.equal(result.metrics.toolCalls,10)
})
