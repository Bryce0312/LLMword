import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarketQuoteTool } from './market-quote.mjs'

test('quote uses a fixed public endpoint and persists actual data before granting a citation', async () => {
  let saved, calls = 0
  const tool = createMarketQuoteTool({ now: () => '2026-11-19T17:00:00Z', request: async (url, options) => {
    calls++; assert.equal(url, 'https://api.coinbase.com/v2/prices/BTC-USD/spot'); assert.equal(options.redirect, 'error'); assert(!options.headers.Authorization)
    return new Response(JSON.stringify({ data: { amount: '63123.45', currency: 'USD', base: 'BTC' } }))
  }, onEvidence: async record => { saved = record; return { evidenceId: 'real-saved-quote' } } })
  const result = await tool.execute({ pair: 'BTC-USD' })
  assert.equal(result.status, 'ok'); assert.equal(result.data.value, 63123.45); assert.equal(result.data.timestampMeaning, 'system-observation-time')
  assert.equal(saved.marketQuote.value, result.data.value); assert.equal(saved.publishedAt, null); assert.deepEqual(result.evidenceIds, ['real-saved-quote'])
  assert.equal((await tool.execute({ pair: 'BTC-USD' })).data.cached,true); assert.equal(calls, 1)
})

test('failed, malformed or unpersisted quotes never invent a baseline or expose transport errors', async () => {
  for (const request of [async () => new Response('{}', {status: 404}), async () => new Response('{"data":{"amount":"Infinity","currency":"USD"}}'), async () => { throw new Error('secret-private-transport') }]) {
    const result = await createMarketQuoteTool({ request, onEvidence: () => 'saved' }).execute({pair:'BTC-USD'})
    assert.equal(result.status,'error'); assert.deepEqual(result.evidenceIds,[]); assert.equal(result.data,null); assert(!JSON.stringify(result).includes('secret-private'))
  }
  const result=await createMarketQuoteTool({ mode:'replay', onEvidence:()=>null }).execute({pair:'BTC-USD'})
  assert.equal(result.error.code,'EVIDENCE_SAVE_FAILED'); assert.deepEqual(result.evidenceIds,[])
})

test('fixture quote is explicit synthetic replay and no arbitrary pair or URL can cause a request', async () => {
  let calls = 0, saved
  const tool=createMarketQuoteTool({ mode:'mock', request:async()=>{calls++;throw new Error('should not run')}, onEvidence:record=>{saved=record;return 'fixture-id'} })
  const result=await tool.execute({pair:'BTC-USD'})
  assert.equal(result.data.synthetic,true); assert.equal(result.data.value,100); assert.equal(saved.fixture,true); assert.equal(saved.scoringEligible,false); assert.equal(calls,0)
  for(const args of [{pair:'http://127.0.0.1/private'},{pair:'BTC-USD',url:'https://bad.example'}]) assert.equal((await tool.execute(args)).error.code,'INVALID_QUOTE_PAIR')
  assert.equal(calls,0)
})

test('same price at a later observation keeps its content hash and cancellation cannot create evidence', async () => {
  const records=[]
  for(const time of ['2026-11-19T17:00:00Z','2026-11-19T18:00:00Z']) await createMarketQuoteTool({mode:'replay',now:()=>time,onEvidence:r=>{records.push(r);return 'id'} }).execute({pair:'BTC-USD'})
  assert.equal(records[0].contentHash,records[1].contentHash); assert.notEqual(records[0].observedAt,records[1].observedAt)
  const controller=new AbortController();controller.abort();let saves=0
  const result=await createMarketQuoteTool({mode:'replay',onEvidence:()=>{saves++;return 'id'} }).execute({pair:'BTC-USD'},{signal:controller.signal})
  assert.equal(result.error.code,'TOOL_CANCELLED');assert.equal(saves,0)
})
