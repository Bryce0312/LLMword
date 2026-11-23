import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyModelCredentials } from './model-provider.mjs'

const key = 'TEST_CREDENTIAL_NOT_REAL'
const env = { WORLD_API_KEY: key, WORLD_BASE_URL: 'https://api.deepseek.com' }

test('credential check uses GET /models and discards the response body', async () => {
  let seen, bodyRead = false
  const result = await verifyModelCredentials(env, async (url, options) => {
    seen = { url, options }
    return { ok: true, status: 200, text: async () => { bodyRead = true; return '{"data":[]}' }, json: async () => { throw new Error('json must not be parsed') } }
  })
  assert.equal(seen.url, 'https://api.deepseek.com/models')
  assert.equal(seen.options.method, 'GET')
  assert.equal(seen.options.headers.Authorization, `Bearer ${key}`)
  assert.deepEqual(result, { connected: true, status: 200 })
  assert.equal(bodyRead, true, 'the body is consumed so the connection can be released')
  assert(!JSON.stringify(result).includes(key))
})

test('denied credentials and invalid configuration stay explicit without leaking the key', async () => {
  assert.deepEqual(await verifyModelCredentials(env, async () => ({ ok: false, status: 401, text: async () => '{"error":"private"}' })), { connected: false, status: 401 })
  await assert.rejects(verifyModelCredentials({}, async () => { throw new Error('must not call') }), error => error.code === 'MODEL_CONFIG')
  await assert.rejects(verifyModelCredentials({ ...env, WORLD_BASE_URL: 'file:///etc/passwd' }, async () => {}), error => error.code === 'MODEL_CONFIG')
})

test('credential checks derive models from full official and school endpoints without duplicate operations', async () => {
  for (const [url, expected] of [
    ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/models'],
    ['https://genai.comp.polyu.edu.hk/api/v1//chat/completions', 'https://genai.comp.polyu.edu.hk/api/v1//models'],
    ['http://127.0.0.1:9999/custom/invoke', 'http://127.0.0.1:9999/custom/models'],
  ]) {
    let called
    const checked = await verifyModelCredentials({ ...env, WORLD_CHAT_COMPLETIONS_URL: url, WORLD_BASE_URL: 'file:///ignored' }, async (endpoint, options) => {
      called = { endpoint, options }
      return { ok: true, status: 200, text: async () => 'PRIVATE BODY' }
    })
    assert.equal(called.endpoint, expected)
    assert.equal(called.options.method, 'GET')
    assert.deepEqual(checked, { connected: true, status: 200 })
    assert(!JSON.stringify(checked).includes('PRIVATE'))
  }
})

test('invalid explicit completion URLs are rejected before credential transport', async () => {
  let calls = 0
  for (const url of ['', 'file:///private', 'https://user:pass@host.example/chat/completions', 'https://host.example/chat/completions?key=private', 'https://host.example/chat/completions#fragment', 'https://host.example/chat/completions\n']) {
    await assert.rejects(verifyModelCredentials({ ...env, WORLD_CHAT_COMPLETIONS_URL: url }, async () => { calls++; throw new Error('must not call') }), { code: 'MODEL_CONFIG' })
  }
  assert.equal(calls, 0)
})
