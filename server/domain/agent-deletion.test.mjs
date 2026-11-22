import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDomainStore } from './domain-store.mjs'
import { createWorkbenchService } from './workbench-service.mjs'
import { getAgentCatalog, PROVIDED_TOOL_IDS } from './agent-catalog.mjs'

const NOW = '2026-11-22T08:00:00.000Z'
const storeAt = (path) => createDomainStore({ path, registeredToolIds: PROVIDED_TOOL_IDS, now: () => NOW })
const custom = { name: '自定义调查员', instructions: '读取真实材料并提交已引用的报告。' }

test('deletion is version checked, idempotent and preserves every builtin/custom version without revival', () => {
  const store = storeAt(':memory:')
  try {
    const first = store.saveAgentSpec(getAgentCatalog()[0], { idempotencyKey: 'builtin-save' })
    const second = store.saveAgentSpec({ agentSpecId: first.agentSpecId, expectedVersion: 1, name: '新版研究员' })
    const saved = store.saveAgentSpec(custom, { idempotencyKey: 'generated-custom' })
    for (const input of [{}, { expectedVersion: '2' }, { expectedVersion: 0 }, { expectedVersion: 2, extra: true }]) assert.throws(() => store.deleteAgentSpec(first.agentSpecId, input), error => error.status === 400)
    assert.throws(() => store.deleteAgentSpec(first.agentSpecId, { expectedVersion: 1 }), { code: 'VERSION_CONFLICT', status: 409 })
    assert.equal(store.getAgentSpec(first.agentSpecId).specVersion, 2)
    const receipt = store.deleteAgentSpec(first.agentSpecId, { expectedVersion: 2 })
    assert.deepEqual(receipt, { agentSpecId: first.agentSpecId, deleted: true, deletedAt: NOW })
    assert.equal(store.getAgentSpec(first.agentSpecId), null)
    assert.deepEqual(store.getAgentSpec(first.agentSpecId, { specVersion: 1 }), first)
    assert.deepEqual(store.getAgentSpec(first.agentSpecId, { specVersion: 2 }), second)
    assert.deepEqual(store.deleteAgentSpec(first.agentSpecId, { expectedVersion: 2 }), receipt)
    assert.throws(() => store.deleteAgentSpec(first.agentSpecId, { expectedVersion: 1 }), { code: 'VERSION_CONFLICT' })
    assert.throws(() => store.saveAgentSpec({ agentSpecId: first.agentSpecId, expectedVersion: 2, name: '不能复活' }), { code: 'AGENT_DELETED' })
    assert.throws(() => store.saveAgentSpec(getAgentCatalog()[0], { idempotencyKey: 'builtin-save' }), { code: 'AGENT_DELETED' })
    store.deleteAgentSpec(saved.agentSpecId, { expectedVersion: 1 })
    assert.throws(() => store.saveAgentSpec(custom, { idempotencyKey: 'generated-custom' }), { code: 'AGENT_DELETED' }, 'generated-ID create retries cannot report a tombstoned role as active')
    assert.equal(store.listAgentSpecs().length, 0)
    const recreated = store.saveAgentSpec({ ...custom, agentSpecId: 'new-custom-identity' })
    assert.equal(recreated.specVersion, 1)
    assert.equal(store.listAgentSpecs().length, 1)
    assert.throws(() => store.deleteAgentSpec('unknown-agent', { expectedVersion: 1 }), { code: 'AGENT_NOT_FOUND', status: 404 })
  } finally { store.close() }
})

test('tombstones survive reopening and startup seeding never restores deleted builtin or custom roles', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-agent-delete-')), path = join(folder, 'domain.sqlite')
  const services = []
  t.after(async () => { for (const service of services) service.close(); await rm(folder, { recursive: true, force: true }) })
  let service = createWorkbenchService({ path, now: () => NOW }); services.push(service)
  const original = service.getAgent('official')
  const extra = service.saveAgent({ ...custom, agentSpecId: 'local-worker' })
  const builtinReceipt = service.deleteAgent('official', { expectedVersion: original.specVersion })
  const customReceipt = service.deleteAgent(extra.agentSpecId, { expectedVersion: extra.specVersion })
  service.close()
  service = createWorkbenchService({ path, now: () => '2026-11-23T08:00:00.000Z' }); services.push(service)
  assert.equal(service.listAgents().length, 9)
  assert(!service.listAgents().some(agent => ['official', extra.agentSpecId].includes(agent.agentSpecId)))
  assert.throws(() => service.getAgent('official'), { code: 'AGENT_NOT_FOUND', status: 404 })
  assert.throws(() => service.getAgent(extra.agentSpecId), { code: 'AGENT_NOT_FOUND', status: 404 })
  assert.deepEqual(service.getAgent('official', { specVersion: 1 }), original)
  assert.deepEqual(service.deleteAgent('official', { expectedVersion: 1 }), builtinReceipt)
  assert.deepEqual(service.deleteAgent(extra.agentSpecId, { expectedVersion: 1 }), customReceipt)
  assert.throws(() => service.saveAgent({ agentSpecId: 'official', name: '恢复内置', instructions: '旧编号不可复用。' }), { code: 'AGENT_DELETED' })
})

test('active runtime/course usage blocks a new deletion while tombstone retries and historical reads remain available', () => {
  let runs = [{ runId: 'active-official', status: 'running', agent: { agentSpecId: 'official' } }], courseBusy = false
  const runtime = { listRuns: () => runs, findCreatedRun: () => null }
  const service = createWorkbenchService({ path: ':memory:', runtime, now: () => NOW, isAgentInUse: () => courseBusy })
  try {
    assert.throws(() => service.deleteAgent('official', { expectedVersion: 1 }), { code: 'AGENT_IN_USE', status: 409 })
    assert.equal(service.getAgent('official').specVersion, 1)
    service.deleteAgent('market', { expectedVersion: 1 })
    courseBusy = true
    assert.throws(() => service.deleteAgent('industry', { expectedVersion: 1 }), { code: 'AGENT_IN_USE', status: 409 })
    courseBusy = false; runs[0].status = 'completed'
    const receipt = service.deleteAgent('official', { expectedVersion: 1 })
    courseBusy = true
    assert.deepEqual(service.deleteAgent('official', { expectedVersion: 1 }), receipt)
    assert.equal(service.getAgent('official', { specVersion: 1 }).agentSpecId, 'official')
    const topic = service.createTopic({ title: '归档角色不可再派工', sourceMode: 'provided' })
    const prediction = service.createPrediction(topic.topicId, { type: 'binary', question: '事件是否发生？', object: '测试事件', timezone: 'Asia/Shanghai', status: 'ready',
      forecastClosesAt: '2099-12-30T12:00:00Z', targetAt: '2099-12-31T12:00:00Z', resolutionRule: '指定公告确认。', resolutionRuleVersion: 1,
      resolutionSource: { kind: 'specified', url: 'https://example.com/official' }, unresolvablePolicy: 'pending_then_manual_review' })
    assert.throws(() => service.createRun(prediction.predictionId, { agentSpecId: 'official', specVersion: 1 }), { code: 'AGENT_DELETED', status: 409 })
  } finally { service.close() }
})
