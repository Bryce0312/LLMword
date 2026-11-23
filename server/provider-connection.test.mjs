import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createProviderConnection, handleProviderConnection } from './provider-connection.mjs'

const key = 'TEST_SESSION_KEY_NOT_REAL'
test('session connection applies a key without returning its value or starting a forecast', async () => {
  let applied = null, mode = 'mock'
  const connection = createProviderConnection({ getActiveCount: () => 0, getMode: () => mode, applyKey(value) { applied = value; mode = 'live' } })
  assert.equal(connection.status().configured, false)
  const status = await connection.update({ apiKey: key })
  assert.equal(applied, key)
  assert.equal(status.configured, true)
  assert.equal(status.keySource, 'session')
  assert.equal(status.connection, 'unknown')
  assert.equal(status.modelMode, 'live')
  assert.equal(status.persistence, 'server-session')
  assert(!JSON.stringify(connection).includes(key))
  assert(!JSON.stringify(status).includes(key))
})
test('credential verification marks connected or failed without rejecting the saved key', async () => {
  const connected = createProviderConnection({ getActiveCount: () => 0, applyKey: () => ({ connection: 'connected' }) })
  const ok = await connected.update({ apiKey: key })
  assert.equal(ok.configured, true)
  assert.equal(ok.connection, 'connected')
  assert.match(ok.verifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  const failed = createProviderConnection({ getActiveCount: () => 0, applyKey: () => ({ connection: 'failed' }) })
  const bad = await failed.update({ apiKey: key })
  assert.equal(bad.configured, true)
  assert.equal(bad.connection, 'failed')
  assert(!JSON.stringify(bad).includes(key))
})
test('mock environment locks key replacement and never writes a session credential', async () => {
  let writes = 0
  const connection = createProviderConnection({ locked: true, getActiveCount: () => 0, applyKey() { writes++ } })
  const status = connection.status()
  assert.equal(status.locked, true)
  assert.equal(status.canUpdate, false)
  await assert.rejects(connection.update({ apiKey: key }), e => e.code === 'MODE_LOCKED' && e.status === 409)
  assert.equal(writes, 0)
})
test('active work and simultaneous updates cannot change the current connection', async () => {  let active = 1, writes = 0, release
  const connection = createProviderConnection({ configured: true, getActiveCount: () => active,
    applyKey: () => { writes++; return new Promise(resolve => { release = resolve }) } })
  await assert.rejects(connection.update({ apiKey: key }), e => e.code === 'PROVIDER_UPDATE_BUSY')
  assert.equal(writes, 0)
  active = 0
  const first = connection.update({ apiKey: key })
  assert.equal(connection.status().canUpdate, false)
  await assert.rejects(connection.update({ apiKey: key }), e => e.status === 409)
  release(); await first
  assert.equal(writes, 1)
})
test('invalid input and upstream exceptions expose only static safe errors', async () => {
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey() { throw new Error(key) } })
  for (const input of [{ apiKey: 'short' }, { apiKey: key + '\nHeader: x' }, { apiKey: key, baseUrl: 'https://elsewhere.example' }]) {
    await assert.rejects(connection.update(input), e => e.code === 'INVALID_API_KEY' && !e.message.includes(key))
  }
  await assert.rejects(connection.update({ apiKey: key }), e => e.code === 'PROVIDER_UPDATE_FAILED' && !e.message.includes(key))
  assert.equal(connection.status().keySource, 'none')
})
test('an idle watcher blocks replacing an existing key and keeps the old credential', async () => {
  let calls = 0
  const connection = createProviderConnection({ configured: true, getActiveCount: () => 0, getActiveWatchCount: () => 1, applyKey() { calls++ } })
  assert.equal(connection.status().activeWatchers, 1)
  assert.equal(connection.status().canUpdate, false)
  await assert.rejects(connection.update({ apiKey: key }), e => e.code === 'PROVIDER_UPDATE_BUSY')
  assert.equal(calls, 0)
})
test('a first key can be saved while old watches exist, because those plans cannot run without credentials', async () => {
  let calls = 0
  const connection = createProviderConnection({ getActiveCount: () => 0, getActiveWatchCount: () => 1, applyKey() { calls++; return { connection: 'failed' } } })
  assert.equal(connection.status().canUpdate, true)
  const saved = await connection.update({ apiKey: key })
  assert.equal(saved.configured, true)
  assert.equal(saved.connection, 'failed')
  assert.equal(calls, 1)
})
async function request(connection, method, body = '', headers = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  Object.assign(req, { method, url: '/api/v1/course/provider-connection', headers })
  const response = { writeHead(status, values) { this.status = status; this.headers = values }, end(value) { this.body = JSON.parse(value) } }
  assert(await handleProviderConnection(connection, req, response))
  return response
}
test('connection HTTP contract is bounded, JSON only, and never echoes credentials', async () => {
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey() {} })
  assert.equal((await request(connection, 'POST', JSON.stringify({ apiKey: key }))).status, 415)
  const malformed = await request(connection, 'POST', key, { 'content-type': 'application/json' })
  assert.equal(malformed.status, 400)
  assert(!JSON.stringify(malformed).includes(key))
  assert.equal((await request(connection, 'POST', 'x'.repeat(4097), { 'content-type': 'application/json' })).status, 413)
  const result = await request(connection, 'POST', JSON.stringify({ apiKey: key }), { 'content-type': 'application/json' })
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert(!JSON.stringify(result).includes(key))
  assert.equal((await request(connection, 'GET')).body.configured, true)
})


test('editable connection settings default to official Flash and preserve the selected endpoint and model', async () => {
  let applied
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey: (value, settings) => { applied = { value, settings }; return { connection: 'connected' } } })
  assert.equal(connection.status().url, 'https://api.deepseek.com/chat/completions')
  assert.equal(connection.status().model, 'deepseek-flash')
  const url = 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model = 'DeepSeek-V4-Flash'
  const saved = await connection.update({ apiKey: key, url, model })
  assert.equal(applied.value, key)
  assert.deepEqual(applied.settings, { url, model, protocol: 'openai' })
  assert.equal(saved.url, url); assert.equal(saved.model, model)
  assert(!JSON.stringify(saved).includes(key))
  await connection.update({ apiKey: key, url: 'http://localhost:12345/custom/invoke', model: 'Custom/model-v1' })
  assert.equal(connection.status().model, 'Custom/model-v1')
})

test('invalid or failed configuration changes leave the previous connection unchanged', async () => {
  let fail = false, calls = 0
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey: () => { calls++; if (fail) throw new Error(key); return { connection: 'connected' } } })
  await connection.update({ apiKey: key })
  const original = connection.status()
  for (const change of [ { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com/chat/completions' }, { url: 'https://example.com/chat/completions?key=hidden' }, { model: '' }, { model: 'bad\nmodel' } ]) {
    await assert.rejects(connection.update({ apiKey: key, ...change }), error => error.code === 'INVALID_MODEL_CONFIG')
    assert.deepEqual(connection.status(), original)
  }
  assert.equal(calls, 1)
  fail = true
  await assert.rejects(connection.update({ apiKey: key, url: 'https://example.com/chat/completions', model: 'Custom' }), error => error.code === 'PROVIDER_UPDATE_FAILED' && !error.message.includes(key))
  assert.deepEqual(connection.status(), original)
})

test('busy work rejects changes to the whole connection without partial URL or model updates', async () => {
  let active = 0
  const connection = createProviderConnection({ getActiveCount: () => active, applyKey: () => ({ connection: 'connected' }) })
  await connection.update({ apiKey: key })
  active = 1
  await assert.rejects(connection.update({ apiKey: key, url: 'https://example.com/chat/completions', model: 'Other' }), error => error.code === 'PROVIDER_UPDATE_BUSY')
  assert.equal(connection.status().url, 'https://api.deepseek.com/chat/completions')
  assert.equal(connection.status().model, 'deepseek-flash')
})


test('each model connection refreshes public pricing with no credential and never returns the previous model price', async () => {
  const loads = []
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey: () => ({ connection: 'connected' }), loadPricing: async settings => {
    loads.push(settings)
    return { status: 'available', model: settings.model, currency: 'USD', unitTokens: 1000000, inputCacheHit: 0.01, inputCacheMiss: 0.1, output: 1, sourceUrl: 'https://example.com/pricing', checkedAt: '2026-11-22T00:00:00Z' }
  } })
  assert.equal(connection.status().pricing.status, 'unavailable')
  const first = await connection.update({ apiKey: key })
  assert.equal(first.pricing.model, 'deepseek-flash')
  const second = await connection.update({ apiKey: key, url: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model: 'DeepSeek-V4-Flash' })
  assert.equal(second.pricing.model, 'DeepSeek-V4-Flash')
  assert.deepEqual(loads, [ { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' }, { url: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model: 'DeepSeek-V4-Flash' } ])
  assert(!JSON.stringify(second).includes(key))
})

test('pricing lookup failure cannot reject a saved connection or retain an unrelated old price', async () => {
  let fail = false
  const connection = createProviderConnection({ getActiveCount: () => 0, applyKey: () => ({ connection: 'connected' }), loadPricing: async settings => {
    if (fail) throw new Error('not exposed')
    return { status: 'available', model: settings.model, currency: 'USD', unitTokens: 1000000, output: 1, checkedAt: '2026-11-22T00:00:00Z' }
  } })
  await connection.update({ apiKey: key })
  fail = true
  const saved = await connection.update({ apiKey: key, url: 'https://proxy.example/chat/completions', model: 'Other' })
  assert.equal(saved.configured, true)
  assert.equal(saved.connection, 'connected')
  assert.equal(saved.pricing.status, 'unavailable')
  assert.equal(saved.pricing.model, 'Other')
  assert.equal(saved.pricing.output, null)
  assert(!JSON.stringify(saved).includes('not exposed'))
})
