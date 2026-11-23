import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentDeletionAction, agentDeletionError } from './agent-deletion.mjs'

const seat = { agentSpecId: 'custom/one', name: '测试研究员', specVersion: 3 }

test('seat deletion is never requested when the named confirmation is cancelled', async () => {
  let requested = false
  const action = createAgentDeletionAction(seat, {
    confirm: message => { assert.match(message, /测试研究员/); assert.match(message, /不再用于新任务/); assert.match(message, /历史定义、运行与报告保留/); return false },
    request: async () => { requested = true; throw new Error('must not request') },
  })
  assert.equal(requested, false, 'constructing a view action has no side effects')
  assert.deepEqual(await action(), { deleted: false, cancelled: true })
  assert.equal(requested, false)
})

test('confirmation sends the encoded agent id and current expected version exactly once while pending', async () => {
  let resolveRequest; let confirmations = 0; let requests = 0
  const action = createAgentDeletionAction(seat, {
    confirm: () => { confirmations++; return true },
    request: (path, options) => {
      requests++
      assert.equal(path, '/agents/custom%2Fone')
      assert.deepEqual(options, { method: 'DELETE', body: { expectedVersion: 3 } })
      return new Promise(resolve => { resolveRequest = resolve })
    },
  })
  const first = action()
  assert.deepEqual(await action(), { deleted: false, busy: true })
  assert.equal(confirmations, 1); assert.equal(requests, 1)
  resolveRequest({ agentSpecId: seat.agentSpecId, deleted: true, deletedAt: '2026-11-22T08:00:00Z' })
  assert.equal((await first).deleted, true)
})

test('failed deletes retain a retryable action and do not become successful results', async () => {
  let calls = 0
  const action = createAgentDeletionAction(seat, {
    confirm: () => true,
    request: async () => { calls++; if (calls === 1) throw Object.assign(new Error('PRIVATE_BODY'), { code: 'AGENT_IN_USE', status: 409 }); return { agentSpecId: seat.agentSpecId, deleted: true } },
  })
  await assert.rejects(action(), { code: 'AGENT_IN_USE' })
  assert.equal((await action()).deleted, true)
  assert.equal(calls, 2)
})

test('a malformed response or another seat cannot confirm removal of the selected seat', async () => {
  for (const response of [{}, { agentSpecId: seat.agentSpecId, deleted: false }, { agentSpecId: 'other', deleted: true }]) {
    const action = createAgentDeletionAction(seat, { confirm: () => true, request: async () => response })
    await assert.rejects(action(), { code: 'AGENT_DELETE_UNCONFIRMED' })
  }
})

test('a missing current version cannot produce a destructive request or confirmation', async () => {
  const unexpected = () => { throw new Error('must not call') }
  const action = createAgentDeletionAction({ ...seat, specVersion: undefined }, { confirm: unexpected, request: unexpected })
  await assert.rejects(action(), { code: 'AGENT_DELETE_INVALID_VERSION' })
})

test('deletion errors explain active use and conflicts without echoing provider bodies', () => {
  assert.match(agentDeletionError({ code: 'AGENT_IN_USE', status: 409 }), /仍有调查正在运行或排队/)
  assert.match(agentDeletionError({ status: 409 }), /刷新列表/)
  for (const status of [401, 403, 404, 409, 500]) assert(!agentDeletionError({ status, message: 'SECRET_BODY' }).includes('SECRET'))
})

test('confirmation describes a real missing-verifier or fewer-than-three consequence only when relevant', async () => {
  const messages = []
  const neverRequest = () => { throw new Error('cancel must not request') }
  for (const [agent, availableCount] of [[seat, 10], [{ ...seat, agentSpecId: 'verification' }, 10], [seat, () => 3]]) {
    const action = createAgentDeletionAction(agent, { availableCount, confirm: message => { messages.push(message); return false }, request: neverRequest })
    await action()
  }
  assert(!messages[0].includes('新预测无法启动'))
  assert.match(messages[1], /缺少核验席，新预测无法启动/)
  assert.match(messages[2], /不足三类，新预测无法启动/)
})

test('an asynchronous confirmation is pending before any request and cannot be duplicated', async () => {
  let decide; let confirmations = 0; let requests = 0
  const action = createAgentDeletionAction(seat, {
    confirm: () => { confirmations++; return new Promise(resolve => { decide = resolve }) },
    request: async () => { requests++; return { agentSpecId: seat.agentSpecId, deleted: true } },
  })
  const pending = action()
  assert.equal(requests, 0, 'a truthy Promise is not approval')
  assert.deepEqual(await action(), { deleted: false, busy: true })
  assert.equal(confirmations, 1)
  decide(false)
  assert.deepEqual(await pending, { deleted: false, cancelled: true })
  assert.equal(requests, 0)
  const retry = action()
  decide(true)
  assert.equal((await retry).deleted, true)
  assert.equal(requests, 1)
})

test('dismissed, rejected, undefined, or non-boolean confirmations never authorize DELETE', async () => {
  for (const confirm of [async () => false, async () => undefined, async () => 'true', async () => ({ confirmed: true }), async () => { throw new Error('dialog dismissed') }]) {
    let requests = 0
    const action = createAgentDeletionAction(seat, { confirm, request: async () => { requests++; throw new Error('must not send') } })
    assert.deepEqual(await action(), { deleted: false, cancelled: true })
    assert.equal(requests, 0)
    assert.deepEqual(await action(), { deleted: false, cancelled: true }, 'cancellation releases the pending guard')
  }
})
