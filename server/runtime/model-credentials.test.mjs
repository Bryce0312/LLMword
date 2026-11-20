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
