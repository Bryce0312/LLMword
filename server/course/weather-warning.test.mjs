import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWarnings, readWarnings, WARNING_URL } from './weather-warning.mjs'
import { runWarningCase } from '../../scripts/warning-case.mjs'
const at = '2026-11-21T00:00:00.000Z'
const fire = { WFIRE: { name: 'Fire Danger Warning', code: 'WFIRER', actionCode: 'ISSUE', issueTime: at, updateTime: at } }
test('complete warning snapshots distinguish red, yellow, cancelled and invalid/error data', () => {
  assert.equal(parseWarnings(fire, at).redFireActive, true)
  assert.equal(parseWarnings({}, at).redFireActive, false)
  assert.equal(parseWarnings({ WFIRE: { ...fire.WFIRE, code: 'WFIREY' } }, at).redFireActive, false)
  assert.equal(parseWarnings({ WFIRE: { ...fire.WFIRE, actionCode: 'CANCEL' } }, at).redFireActive, false)
  for (const invalid of [null, [], { error: 'denied' }, { WFIRE: {} }, { WFIRE: { ...fire.WFIRE, updateTime: '2026-11-22T00:00:00Z' } }, { WFIRE: { ...fire.WFIRE, code: 'UNKNOWN' } }]) assert.throws(() => parseWarnings(invalid, at))
})
test('live warning reader uses only the fixed anonymous URL, bounds bodies and preserves raw evidence', async () => {
  let calls = 0
  const request = async (url, options) => { calls++; assert.equal(url, WARNING_URL); assert(!options.headers.Authorization); assert.equal(options.redirect, 'error'); return Response.json(fire) }
  const result = await readWarnings({ request, now: () => at }); assert.equal(result.sourceMode, 'live'); assert.equal(result.fixture, false); assert.equal(result.rawJson, JSON.stringify(fire)); assert(result.text.includes(result.rawJson)); assert.equal(calls, 1)
  await assert.rejects(readWarnings({ request: async () => new Response('bad'), now: () => at }))
  await assert.rejects(readWarnings({ request: async () => new Response('x'.repeat(33000)), now: () => at }))
  const mock = await readWarnings({ mode: 'mock', now: () => at, request: () => { throw Error('must not network') } }); assert.equal(mock.fixture, true)
})
test('mock prediction closes through source-failure recovery, immutable result and isolated protocol scoring', async () => {
  const result = await runWarningCase(); assert.equal(result.checks.length, 8); assert.equal(result.result.outcome, 0)
})
test('truncated short-window forecast resumes only the chief summary without repeating worker tools', async () => {
  const result = await runWarningCase({ truncateSummary: true }); assert.equal(result.result.outcome, 0)
})
