import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import { createEvents } from './events.mjs'
import { createMonitor } from './monitor.mjs'

async function until(check) {
  const deadline = Date.now() + 2500
  do {
    const result = await check()
    if (result) return result
    await wait(20)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for the unattended monitor')
}

test('monitor baselines existing evidence, gates new filings, and deduplicates after restart without browser clients', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'world-monitor-'))
  const path = join(dir, 'monitor.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const observedAt = '2026-11-13T15:00:00.000Z'
  const filing = (id, code) => ({
    id, kind: 'filing', sourceId: 'sec_edgar', title: id, symbols: ['AMD'],
    summary: 'Filing metadata', publishedAt: observedAt, observedAt,
    filing: { form: '8-K', items: [code] },
  })
  const original = filing('existing', '2.02')
  const material = filing('new earnings', '2.02')
  const routine = filing('administrative', '5.02')
  let polls = 0
  const poll = async () => ({
    sources: [{ id: 'sec_edgar', status: 'live', lastSuccessAt: observedAt, coveredSymbols: ['AMD'] }],
    items: ++polls === 1 ? [original] : [material, original, routine],
  })
  const options = { mode: 'public', path, intervalMs: 75, poll, now: () => new Date(observedAt), provider: { mode: 'mock' } }
  const first = createMonitor({ ...options, events: createEvents() })
  t.after(() => first.stop())
  first.start()
  const completed = await until(async () => {
    const state = await first.get()
    return state.latestMeeting ? state : null
  })
  first.stop()
  assert.deepEqual(Object.fromEntries(completed.decisions.map((item) => [item.title, item.action])), {
    existing: 'baseline', 'new earnings': 'meeting', administrative: 'ignore',
  })
  assert.equal(completed.latestMeeting.evidence[0].id, material.id)
  assert.equal(completed.latestMeeting.findings.length, 5)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(saved.pending, [])
  const initialPolls = polls
  const resumed = createMonitor({ ...options, events: createEvents() })
  t.after(() => resumed.stop())
  resumed.start()
  await until(() => polls > initialPolls + 1)
  await wait(20)
  resumed.stop()
  const after = await resumed.get()
  assert.equal(after.latestMeeting.id, completed.latestMeeting.id)
  assert.deepEqual(after.decisions, completed.decisions)
})

test('a monitor restart finishes an already persisted pending meeting without rediscovering its filing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'world-monitor-pending-'))
  const path = join(dir, 'monitor.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const at = '2026-11-13T15:00:00.000Z'
  const item = { id: 'pending-item', title: 'NVIDIA report', kind: 'filing', sourceId: 'sec_edgar', symbols: ['NVDA'], observedAt: at, publishedAt: at }
  await writeFile(path, JSON.stringify({
    version: 1, sources: [], latestItems: [item], decisions: [], latestMeeting: null, lastCheckAt: at,
    known: { [item.id]: { at, price: null } }, pending: [{ id: 'pending-run', item }], initialized: ['sec_edgar:NVDA'],
  }))
  const monitor = createMonitor({
    mode: 'public', path, intervalMs: 70, events: createEvents(), provider: { mode: 'mock' },
    poll: async () => ({ sources: [], items: [] }),
  })
  t.after(() => monitor.stop())
  monitor.start()
  const meeting = await until(async () => (await monitor.get()).latestMeeting)
  monitor.stop()
  assert.equal(meeting.id, 'pending-run')
  assert.equal(meeting.evidence[0].id, item.id)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).pending, [])
})

test('an automatic live-model task completes only after its validated answer arrives', async (t) => {
  const at = '2026-11-13T15:00:00.000Z'
  const item = { id: 'new-disclosure', title: 'NVIDIA earnings', kind: 'filing', sourceId: 'sec_edgar',
    symbols: ['NVDA'], observedAt: at, publishedAt: at, filing: { form: '8-K', items: ['2.02'] } }
  let polls = 0
  const poll = async () => ({
    sources: [{ id: 'sec_edgar', status: 'live', lastSuccessAt: at, coveredSymbols: ['NVDA'] }],
    items: ++polls === 1 ? [] : [item],
  })
  let finishCompany
  const held = new Promise((resolve) => { finishCompany = resolve })
  t.after(finishCompany)
  const finding = '已检查当前披露，保留后续核查。'
  const provider = { mode: 'live', async decide({ agentId }) {
    if (agentId === 'company') await held
    return { finding, evidenceIds: [item.id], probability: null }
  } }
  const frames = []
  const events = {
    publish() {},
    async run(_scope, action) { await action({ onEvent: (frame) => frames.push(frame) }) },
  }
  const monitor = createMonitor({ mode: 'public', intervalMs: 40, events, provider, poll, now: () => new Date(at) })
  t.after(() => monitor.stop())
  monitor.start()
  const done = () => frames.filter(({ type, status }) => type === 'task' && status === 'complete')
  await until(() => done().some(({ agentId }) => agentId === 'policy'))
  assert.ok(frames.some(({ type, status, agentId }) => type === 'task' && status === 'start' && agentId === 'company'))
  assert.ok(!done().some(({ agentId }) => agentId === 'company'))
  assert.equal((await monitor.get()).latestMeeting, null)
  finishCompany()
  const final = await until(async () => (await monitor.get()).latestMeeting)
  for (const task of done()) {
    const trace = frames.find(({ type, row }) => type === 'trace' && row.taskId === task.taskId)
    assert.equal(trace.row.agentId, task.agentId)
    assert.equal(trace.row.message, task.message)
    assert.deepEqual(task.sourceIds, [item.id])
  }
  assert.equal(done().length, final.findings.length)
})
