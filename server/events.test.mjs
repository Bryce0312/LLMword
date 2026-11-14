import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createEvents } from './events.mjs'

function subscribe(events, cursor) {
  const response = new EventEmitter()
  const frames = []
  response.writeHead = (status) => assert.equal(status, 200)
  response.flushHeaders = () => {}
  response.write = (frame) => {
    const body = frame.split('\n').find((line) => line.startsWith('data: '))
    if (body) frames.push(JSON.parse(body.slice(6)))
    return true
  }
  events.subscribe({ headers: { 'last-event-id': cursor } }, response)
  return { frames, close: () => response.emit('close') }
}

test('an SSE client joining an active meeting gets its movement history and reconnects after its last cursor', async (t) => {
  const events = createEvents()
  let send
  let release
  const begun = new Promise((resolve) => { send = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const job = events.run({ scope: 'replay', trigger: 'manual' }, async ({ onEvent }) => {
    onEvent({ type: 'movement', room: 'meeting', agentIds: ['policy'] })
    send(onEvent)
    await held
  })
  t.after(release)
  const emit = await begun
  const first = subscribe(events)
  t.after(first.close)
  assert.deepEqual(first.frames.map(({ type }) => type), ['sync', 'run-start', 'movement'])
  assert.equal(first.frames[0].reset, true)
  const cursor = first.frames.at(-1).seq
  first.close()
  emit({ type: 'trace', row: { kind: 'message', agentId: 'policy', message: '正在核对证据。' } })
  const resumed = subscribe(events, String(cursor))
  t.after(resumed.close)
  assert.deepEqual(resumed.frames.map(({ type }) => type), ['sync', 'trace'])
  assert.equal(resumed.frames[0].reset, false)
  assert.equal(resumed.frames[1].seq, cursor + 1)
  release()
  await job
  assert.equal(resumed.frames.at(-1).type, 'run-complete')
})
