import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchModelPricing, MAX_PRICING_BODY_BYTES, MODEL_PRICING_SOURCE_URL } from './model-pricing.mjs'

const connection = { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' }
const checkedAt = '2026-11-22T01:00:00.000Z'
const fixture = `<html><table>
<tr><td colspan="3">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">PRICING<sup>(2)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr></table>
<p>Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak.</p></html>`
const htmlResponse = (html = fixture, options = {}) => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' }, ...options })
const options = request => ({ request, now: () => checkedAt, timeoutMs: 100 })

// This fixture follows the live official HTML inspected on 2026-11-22. The
// implementation reads every numeric value; fixtures are never a price fallback.
test('official list prices match the exact model column and retain both published time tiers', async () => {
  let received
  const result = await fetchModelPricing({ ...connection, apiKey: 'NOT_USED_OR_SENT' }, options(async (url, config) => { received = { url, config }; return htmlResponse() }))
  assert.equal(result.status, 'available')
  assert.equal(result.currency, 'USD'); assert.equal(result.unitTokens, 1000000)
  assert.equal(result.checkedAt, checkedAt); assert.equal(result.sourceUrl, MODEL_PRICING_SOURCE_URL)
  assert.equal(result.ratePeriod, 'tiered'); assert.equal(result.ratePeriodLabel, '分时计价')
  assert.deepEqual(result.rateTiers, { offPeak: { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6 }, peak: { inputCacheHit: 0.006, inputCacheMiss: 0.3, output: 1.2 } })
  assert.equal(result.inputCacheHit, null); assert.equal(result.inputCacheMiss, null); assert.equal(result.output, null)
  assert.match(result.schedule, /中国法定节假日除外/u)
  assert.equal(received.url, MODEL_PRICING_SOURCE_URL); assert.equal(received.config.method, 'GET')
  assert.equal(received.config.redirect, 'error'); assert.deepEqual(received.config.headers, { Accept: 'text/html' })
  assert(!JSON.stringify(received).includes('NOT_USED_OR_SENT'))
  const pro = await fetchModelPricing({ ...connection, model: 'deepseek-v4-pro' }, options(async () => htmlResponse()))
  assert.equal(pro.rateTiers.offPeak.output, 1.98)
})

test('a newly fetched changed price replaces the earlier value without a built-in rate fallback', async () => {
  const old = await fetchModelPricing(connection, options(async () => htmlResponse()))
  const updated = await fetchModelPricing(connection, options(async () => htmlResponse(fixture.replace('$0.003', '$0.004'))))
  assert.equal(old.rateTiers.offPeak.inputCacheHit, 0.003)
  assert.equal(updated.rateTiers.offPeak.inputCacheHit, 0.004)
  const failed = await fetchModelPricing(connection, options(async () => { throw new Error('PRIVATE UPSTREAM DETAIL') }))
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.rateTiers, null)
  assert.equal(failed.freshness, 'unavailable'); assert(!JSON.stringify(failed).includes('PRIVATE'))
})

test('campus, custom and malformed connection settings do not trigger an official pricing request', async () => {
  let calls = 0
  for (const url of ['https://genai.comp.polyu.edu.hk/api/v1//chat/completions', 'https://proxy.example/invoke', 'https://api.deepseek.com:444/chat/completions', 'file:///private', 'https://user:secret@api.deepseek.com/chat/completions']) {
    const result = await fetchModelPricing({ url, model: 'DeepSeek-V4-Flash' }, options(async () => { calls++; return htmlResponse() }))
    assert.equal(result.status, 'unavailable'); assert.equal(result.currency, null); assert.equal(result.rateTiers, null)
  }
  assert.equal(calls, 0)
})

test('unknown official model names never receive a neighbouring model price', async () => {
  const result = await fetchModelPricing({ ...connection, model: 'DeepSeek-V4-Flash' }, options(async () => htmlResponse()))
  assert.equal(result.status, 'unavailable'); assert.equal(result.reasonCode, 'MODEL_PRICE_NOT_LISTED')
  assert.equal(result.rateTiers, null)
})

test('changed or incomplete official markup is unavailable rather than partially priced', async () => {
  for (const html of [fixture.replace('$1.2', 'contact sales'), fixture.replace('(CACHE HIT)', '(CACHE WRITE)'), fixture.replace('excluding Chinese public holidays', 'new schedule pending'), '<html><p>maintenance</p></html>']) {
    const result = await fetchModelPricing(connection, options(async () => htmlResponse(html)))
    assert.equal(result.status, 'unavailable'); assert.equal(result.rateTiers, null)
  }
})

test('HTTP failure, redirect and non-HTML responses never become fresh prices', async () => {
  for (const response of [new Response('PRIVATE FAILURE', { status: 403 }), new Response('', { status: 302, headers: { Location: 'https://other.example/prices' } }), new Response(fixture, { status: 200, headers: { 'Content-Type': 'application/json' } }), { status: 200, redirected: true, text: async () => fixture }]) {
    const result = await fetchModelPricing(connection, options(async () => response))
    assert.equal(result.status, 'unavailable'); assert.equal(result.rateTiers, null)
    assert(!JSON.stringify(result).includes('PRIVATE FAILURE'))
  }
})

test('advertised and streamed body sizes are bounded and an oversized stream is cancelled', async () => {
  let cancelled = false
  const tooLarge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PRICING_BODY_BYTES + 1)) }, cancel() { cancelled = true } })
  const streamed = await fetchModelPricing(connection, options(async () => new Response(tooLarge, { headers: { 'Content-Type': 'text/html' } })))
  assert.equal(streamed.reasonCode, 'PRICING_BODY_TOO_LARGE'); assert.equal(cancelled, true)
  const advertised = await fetchModelPricing(connection, options(async () => htmlResponse('', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(MAX_PRICING_BODY_BYTES + 1) } })))
  assert.equal(advertised.reasonCode, 'PRICING_BODY_TOO_LARGE')
})

test('timeout bounds transports that ignore abort and also bounds a stalled response body', async () => {
  let signal
  const timeout = await fetchModelPricing(connection, { ...options(async (_url, config) => { signal = config.signal; return new Promise(() => {}) }), timeoutMs: 10 })
  assert.equal(timeout.reasonCode, 'PRICING_TIMEOUT'); assert.equal(signal.aborted, true)
  let cancelled = false
  const stalled = new ReadableStream({ cancel() { cancelled = true } })
  const body = await fetchModelPricing(connection, { ...options(async () => new Response(stalled, { headers: { 'Content-Type': 'text/html' } })), timeoutMs: 10 })
  assert.equal(body.reasonCode, 'PRICING_TIMEOUT'); assert.equal(cancelled, true)
})
