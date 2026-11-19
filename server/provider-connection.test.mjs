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
  assert.equal(status.modelMode, 'live')
  assert.equal(status.persistence, 'server-session')
  assert(!JSON.stringify(connection).includes(key))
  assert(!JSON.stringify(status).includes(key))
})
test('active work and simultaneous updates cannot change the current connection', async () => {
  let active = 1, writes = 0, release
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
test('an idle automatic watcher also blocks key replacement, so saving cannot wake prior plans with a new account', async () => {
  let calls = 0, watchers = 1
  const connection = createProviderConnection({ getActiveCount: () => 0, getActiveWatchCount: () => watchers, applyKey() { calls++ } })
  assert.equal(connection.status().activeWatchers, 1)
  assert.equal(connection.status().canUpdate, false)
  await assert.rejects(connection.update({ apiKey: key }), e => e.code === 'PROVIDER_UPDATE_BUSY')
  assert.equal(calls, 0)
  watchers = 0
  await connection.update({ apiKey: key })
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
