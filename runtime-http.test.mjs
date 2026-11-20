import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

async function launch(folder, t) {
  const child = spawn(process.execPath, ['server/app.mjs'], {
    cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: '0', WORLD_MODEL: 'mock', WORLD_API_KEY: '',
      WORLD_MONITOR: 'off', WORLD_MOCK_PACING: '0', WORLD_RUNTIME: 'probe',
      WORLD_STATE_PATH: join(folder, 'legacy.json'), WORLD_RUNTIME_PATH: join(folder, 'runtime.sqlite') },
  })
  const exited = once(child, 'exit')
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) resolve(match[0])
    })
    exited.then(() => reject(new Error(`Test server stopped: ${errors}`)), reject)
  })
}

async function* frames(response) {
  const reader = response.body.getReader(); let buffer = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const text = buffer.slice(0, split); buffer = buffer.slice(split+2)
        const data = text.split('\n').find((line) => line.startsWith('data: '))
        if (data) yield { id: text.split('\n').find((line) => line.startsWith('id: '))?.slice(4), event: JSON.parse(data.slice(6)) }
      }
    }
  } finally { await reader.cancel() }
}

test('opt-in HTTP probe creates an async run, restores public state and reconnects from a persistent SSE cursor', { timeout: 15000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-runtime-http-'))
  const address = await launch(folder, t)
  // Node runs after-hooks in registration order. Stop the child before removing
  // its Windows-locked SQLite WAL and SHM files.
  t.after(() => rm(folder, { recursive: true, force: true }))
  const meta = await (await fetch(`${address}/api/v1/runtime`)).json()
  assert.equal(meta.stage, 'M0'); assert.equal(meta.modelMode, 'mock'); assert.equal(meta.forecastPublishing, false)
  assert.equal((await fetch(address)).status, 200)
  const body = { objective: '核实用户给出的公告，不发布概率。', evidence: [{ evidenceId: 'source_one', title: '样例公告', text: '这是离线协议测试原文。' }] }
  const url = `${address}/api/v1/runtime/probes`
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'request-one' }, body: JSON.stringify(body) }
  const created = await fetch(url, options)
  assert.equal(created.status, 202)
  const run = await created.json()
  assert.equal((await (await fetch(url, options)).json()).runId, run.runId)
  let current
  for (let i = 0; i < 60; i += 1) {
    current = await (await fetch(`${address}/api/v1/runs/${run.runId}`)).json()
    if (current.status === 'completed') break
    await delay(15)
  }
  assert.equal(current.status, 'completed'); assert.equal(current.report.probability, null)
  assert(!Object.hasOwn(current, 'checkpoint'))
  assert.equal(current.kind, 'tool-loop-probe')

  const first = await fetch(`${address}/api/v1/events`, { signal: AbortSignal.timeout(5000) })
  let snapshot
  for await (const { event } of frames(first)) {
    snapshot = event.payload; assert.equal(event.type, 'sync'); assert.equal(snapshot.reset, true); break
  }
  assert.equal(snapshot.runs[0].report.summary, current.report.summary)
  const upper = snapshot.snapshotVersion
  const replay = await fetch(`${address}/api/v1/events`, { headers: { 'Last-Event-ID': `${meta.serverEpoch}:0` }, signal: AbortSignal.timeout(5000) })
  const replayed = []
  for await (const { event, id } of frames(replay)) {
    if (event.type === 'sync') { assert.equal(event.payload.reset, false); continue }
    assert.equal(id, `${meta.serverEpoch}:${event.seq}`)
    replayed.push(event)
    if (event.seq === upper) break
  }
  assert.equal(replayed.filter((event) => event.type === 'assignment.completed').length, 1)
  assert.equal(replayed.at(-1).type, 'run.finished')
  const forbidden = await fetch(url, { ...options, headers: { Origin: 'https://example.com' } })
  assert.equal(forbidden.status, 403)
  const conflict = await fetch(url, { ...options, body: JSON.stringify({ ...body, objective: '不同目标' }) })
  assert.equal(conflict.status, 409)
})
