import assert from 'node:assert/strict'
import test from 'node:test'
import { getAgentCatalog, getToolCatalog, getPlannedToolCatalog, getSkillCatalog, normalizeAgentSpec } from './agent-catalog.mjs'

test('ten reusable roles expose only two implemented tools and separate planned capabilities', () => {
  const roles = getAgentCatalog()
  assert.deepEqual(roles.map(({ agentSpecId }) => agentSpecId), ['official', 'timeline', 'industry', 'people', 'statistics', 'market', 'social', 'analogy', 'graph', 'verification'])
  assert.deepEqual(getToolCatalog().map(({ toolId }) => toolId), ['list_provided_sources', 'read_evidence'])
  assert(getToolCatalog().every((tool) => tool.availability === 'available' && !Object.hasOwn(tool, 'execute')))
  assert(getPlannedToolCatalog().every((tool) => tool.availability === 'planned' && !tool.executable))
  for (const role of roles) {
    assert.equal(role.specVersion, 1)
    assert.equal(role.availability, 'partial')
    assert.deepEqual(role.extensionSlots, [null, null])
    assert.deepEqual(role.allowedTools, ['list_provided_sources', 'read_evidence'])
    assert(role.plannedTools.length)
    assert.deepEqual(normalizeAgentSpec(role), role)
    const method = getSkillCatalog().find((skill) => skill.skillId === role.skillRefs[0].skillId)
    assert.equal(method.version, 1)
    assert.equal(method.executable, false)
    assert.equal(method.instructions, role.instructions)
  }
  roles[0].allowedTools.push('mutated')
  const tools = getToolCatalog()
  tools[0].inputSchema.properties.injected = {}
  assert(!getAgentCatalog()[0].allowedTools.includes('mutated'))
  assert(!getToolCatalog()[0].inputSchema.properties.injected)
})

test('role edits create a new immutable version and custom roles can bind registered extension slots', () => {
  const previous = getAgentCatalog()[0]
  const updated = normalizeAgentSpec({ name: '官方材料核验员', instructions: '按原文核验本题。', limits: { maxToolCalls: 3 } }, { previous })
  assert.equal(updated.specVersion, 2)
  assert.equal(updated.agentSpecId, 'official')
  assert.equal(updated.limits.maxToolCalls, 3)
  assert.equal(updated.limits.maxModelRequests, 8)
  assert.equal(previous.specVersion, 1)
  assert.notEqual(updated.instructions, previous.instructions)
  const custom = normalizeAgentSpec({
    agentSpecId: 'custom_legal', name: '用户自定义研究员', instructions: '分析提供的合同材料。',
    allowedTools: ['read_evidence'], extensionSlots: ['registered_contract_reader', null],
    skillRefs: [{ skillId: 'method_official', version: 1 }], modelRef: 'server-default',
  }, { registeredToolIds: ['read_evidence', 'registered_contract_reader'] })
  assert.equal(custom.origin, 'custom')
  assert.deepEqual(custom.allowedTools, ['read_evidence', 'registered_contract_reader'])
  assert.deepEqual(custom.plannedTools, [])
  assert.equal(custom.modelRef, 'server-default')
})

test('planned, unknown and malformed capabilities cannot become executable permissions', () => {
  const base = { agentSpecId: 'custom', name: '自定义', instructions: '核验资料。' }
  for (const patch of [{ allowedTools: ['search_official'] }, { extensionSlots: ['unregistered', null] }]) {
    assert.throws(() => normalizeAgentSpec({ ...base, ...patch }), { code: 'TOOL_NOT_REGISTERED' })
  }
  assert.throws(() => normalizeAgentSpec({ ...base, extensionSlots: [null] }), { code: 'INVALID_AGENT_SPEC' })
  assert.throws(() => normalizeAgentSpec({ ...base, extensionSlots: ['read_evidence', 'read_evidence'] }), { code: 'DUPLICATE_TOOL_SLOT' })
  assert.throws(() => normalizeAgentSpec({ ...base, skillRefs: [{ skillId: 'method_official', version: 2 }] }), { code: 'SKILL_NOT_REGISTERED' })
  assert.throws(() => normalizeAgentSpec({ ...base, instructions: '  ' }), { code: 'INVALID_AGENT_SPEC' })
  assert.throws(() => normalizeAgentSpec({ ...base, limits: { maxRetries: 3 } }), { code: 'INVALID_AGENT_SPEC' })
  assert.throws(() => normalizeAgentSpec({ ...base, limits: { inventedBudget: 3 } }), { code: 'INVALID_AGENT_SPEC' })
  assert.throws(() => normalizeAgentSpec({ ...base, agentSpecId: 'other' }, { previous: getAgentCatalog()[0] }), { code: 'AGENT_ID_IMMUTABLE' })
})
