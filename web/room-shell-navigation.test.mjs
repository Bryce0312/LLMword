import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRoomShellNavigation, roomShellTarget, mergeRoomHistory } from './room-shell-navigation.mjs'

function harness(extra = {}) {
  const calls = { idle: 0, clears: 0, scenes: [], overlays: [], closed: 0, replaced: [], focused: 0, revealed: 0, selected: [], requests: [] }
  const nav = createRoomShellNavigation({
    showIdle: () => { calls.idle++ }, clearScene: () => { calls.clears++ },
    mountScene: async (target, token) => { calls.scenes.push({ target, token }); calls.requests.push({ method: 'GET', path: '/course/requests/' + target.id }) },
    renderOverlay: async (target, token) => { calls.overlays.push({ target, token }); if (target.parts[0] === 'model-connection') calls.requests.push({ method: 'GET', path: '/course/provider-connection' }) },
    closeOverlay: () => { calls.closed++ }, replaceHash: hash => calls.replaced.push(hash), restoreFocus: () => { calls.focused++ }, revealOverlay: () => { calls.revealed++ }, selectRun: runId => calls.selected.push(runId), ...extra,
  })
  return { nav, calls }
}

test('empty and room locations are idle; menu and legacy routes are workspaces, only saved course ids mount rooms', () => {
  for (const hash of ['', '#/room']) assert.equal(roomShellTarget(hash).kind, 'idle')
  for (const hash of ['#/predictions', '#/predictions/new', '#/course/new', '#/agents/official?specVersion=1', '#/model-connection', '#/advanced']) assert.equal(roomShellTarget(hash).kind, 'overlay')
  const task = roomShellTarget('#/course/request-1?runId=run-2')
  assert.equal(task.kind, 'scene'); assert.equal(task.id, 'request-1'); assert.equal(task.query.get('runId'), 'run-2')
})

test('opening menus from the idle room never mounts a task or issues a write', async () => {
  const { nav, calls } = harness()
  await nav.navigate(''); await nav.navigate('#/predictions'); await nav.navigate('#/agents'); await nav.navigate('#/model-connection')
  assert.equal(calls.idle, 1)
  assert.equal(calls.scenes.length, 0)
  assert.deepEqual(calls.requests, [{ method: 'GET', path: '/course/provider-connection' }])
  assert(!calls.requests.some(request => request.method === 'POST'))
})

test('menu workspaces leave the live scene generation and poll owner intact', async () => {
  const { nav, calls } = harness()
  await nav.navigate('#/course/actual-request?runId=published-run')
  const sceneToken = nav.sceneSerial
  await nav.navigate('#/agents'); await nav.navigate('#/model-connection'); nav.closeOverlay()
  assert.equal(nav.sceneSerial, sceneToken)
  assert.equal(nav.isSceneCurrent(sceneToken), true)
  assert.equal(calls.scenes.length, 1)
  assert.equal(calls.clears, 1)
})

test('closing a workspace restores the selected task hash including replaceState run choice and requests trigger focus', async () => {
  const { nav, calls } = harness()
  await nav.navigate('#/course/task?runId=initial')
  await nav.navigate('#/agents', { previousHash: '#/course/task?runId=manually-selected' })
  const token = nav.overlaySerial
  nav.closeOverlay()
  assert.equal(nav.isOverlayCurrent(token), false)
  assert.equal(calls.replaced.at(-1), '#/course/task?runId=manually-selected')
  assert.equal(calls.focused, 1)
  assert.equal(calls.scenes.length, 1, 'replaceState close does not remount the scene')
})

test('same-menu activation preserves unsaved workspace state; explicit rerender affects only that owner', async () => {
  const { nav, calls } = harness()
  await nav.navigate('#/course/task'); await nav.navigate('#/agents')
  const token = nav.overlaySerial, sceneToken = nav.sceneSerial
  await nav.navigate('#/agents')
  assert.equal(nav.overlaySerial, token); assert.equal(calls.overlays.length, 1); assert.equal(calls.revealed, 1)
  await nav.navigate('#/agents', { forceOverlay: true })
  assert.equal(nav.isOverlayCurrent(token), false); assert.equal(calls.overlays.length, 2); assert.equal(nav.sceneSerial, sceneToken)
})

test('same-task run navigation reselects the run without cleaning or remounting its polling context', async () => {
  const { nav, calls } = harness()
  await nav.navigate('#/course/task?runId=a'); const token = nav.sceneSerial
  await nav.navigate('#/course/task?runId=b')
  assert.deepEqual(calls.selected, ['b']); assert.equal(nav.sceneSerial, token); assert.equal(calls.scenes.length, 1)
  await nav.navigate('#/course/another-task')
  assert.equal(nav.isSceneCurrent(token), false); assert.equal(calls.scenes.length, 2)
})

test('a workspace owner is active while loading and becomes stale immediately on close or menu switch', async () => {
  let release; let loadingToken
  const { nav } = harness({ renderOverlay: async (_target, token) => { loadingToken = token; await new Promise(resolve => { release = resolve }) } })
  const opening = nav.navigate('#/model-connection')
  assert.equal(nav.isOverlayCurrent(loadingToken), true)
  nav.closeOverlay()
  assert.equal(nav.isOverlayCurrent(loadingToken), false)
  release(); await opening
  assert.equal(nav.overlayOpen, false)
})

test('a scene initial read can complete while a workspace is open, but changing the task invalidates its owner', async () => {
  let release; let token
  const { nav } = harness({ mountScene: async (_target, value) => { token = value; await new Promise(resolve => { release = resolve }) } })
  const loading = nav.navigate('#/course/task')
  await nav.navigate('#/predictions')
  assert.equal(nav.isSceneCurrent(token), true)
  release(); await loading
  await nav.navigate('#/room')
  assert.equal(nav.isSceneCurrent(token), false)
  assert.equal(nav.sceneId, null)
})

test('late history reads preserve locally advanced and newly created records without inventing entries', () => {
  const old = { requestId: 'existing', status: 'queued' }, unchanged = { requestId: 'other', status: 'queued' }
  const advanced = { requestId: 'existing', status: 'completed' }, created = { requestId: 'new', status: 'queued' }
  const incomingOther = { requestId: 'other', status: 'completed' }
  const merged = mergeRoomHistory([{ ...old }, incomingOther], [advanced, unchanged, created], [old, unchanged])
  assert.deepEqual(merged, [advanced, incomingOther, created])
})

test('explicit scene retry remounts the same saved id while ordinary same-id navigation does not', async () => {
  const { nav, calls } = harness()
  await nav.navigate('#/course/failed-read?runId=saved')
  const firstToken = nav.sceneSerial
  await nav.navigate('#/course/failed-read?runId=saved')
  assert.equal(calls.scenes.length, 1)
  await nav.navigate(nav.sceneHash, { forceScene: true })
  assert.equal(calls.scenes.length, 2)
  assert.equal(nav.isSceneCurrent(firstToken), false)
  assert.equal(calls.scenes.at(-1).target.id, 'failed-read')
  assert.equal(calls.requests.every(request => request.method === 'GET'), true)
})
