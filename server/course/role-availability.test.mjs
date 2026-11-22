import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createCourseStore } from './course-store.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createRoleToolset } from './course-role-tools.mjs'
import { nativeTool } from './course-contracts.mjs'
import { suggestedRoles } from './course-context.mjs'
import { PRICE_URL, PRICE_RULE } from './market-resolution.mjs'
import { WARNING_URL, WARNING_RULE } from './weather-warning.mjs'

const NOW = '2026-11-22T00:00:00.000Z'
const question = '【模拟】公开科技展未来48小时会举办吗？'
const contextOf = messages => { try { return JSON.parse(messages.find(message => message.role === 'user')?.content || '{}') } catch { return {} } }
async function setup(t, transform = response => response) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-active-roles-'))
  const domainPath = join(folder, 'domain.sqlite'), coursePath = join(folder, 'course.sqlite')
  let workbench = createWorkbenchService({ path: domainPath, now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const protocol = createCourseMockProvider(), calls = []
  const provider = { ...protocol, async complete(input) { calls.push(structuredClone({ messages: input.messages, tools: input.tools })); return transform(await protocol.complete(input), input) } }
  let service = createCourseService({ path: coursePath, workbench, sourceTools, provider, now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return {
    calls, coursePath, get workbench() { return workbench }, get service() { return service },
    remove(id) { return workbench.deleteAgent(id, { expectedVersion: workbench.getAgent(id).specVersion }) },
    async reopen() { await service.close(); workbench.close(); workbench = createWorkbenchService({ path: domainPath, now: () => NOW }); service = createCourseService({ path: coursePath, workbench, sourceTools, provider, now: () => NOW }); return service },
  }
}

test('deleted built-in and custom roles disappear from live course capabilities and cannot be defaulted back', async t => {
  const fixture = await setup(t)
  const custom = fixture.workbench.saveAgent({ agentSpecId: 'custom-specialist', name: '自定义研究员', instructions: '读取公开资料并核验指定主题。' })
  assert(fixture.service.capabilities.roles.includes(custom.agentSpecId))
  fixture.remove('official'); fixture.remove(custom.agentSpecId)
  assert(!fixture.service.capabilities.roles.includes('official'))
  assert(!fixture.service.capabilities.roles.includes(custom.agentSpecId))
  assert(!fixture.service.capabilities.roleCatalogue.some(role => ['official', custom.agentSpecId].includes(role.roleId)))
  const request = fixture.service.createRequest({ question, watch: false })
  await fixture.service.idle()
  const done = fixture.service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert(done.run.assignments.every(assignment => assignment.roleId !== 'official'))
  for (const call of fixture.calls) {
    const context = contextOf(call.messages)
    if (context.kind === 'course-main') assert(!(context.roleCatalogue || []).some(role => role.roleId === 'official'))
    for (const tool of call.tools.filter(tool => ['draft_and_delegate', 'delegate_work'].includes(tool.function.name))) assert(!tool.function.parameters.properties.assignments.items.properties.roleId.enum.includes('official'))
  }
  await fixture.reopen()
  assert(!fixture.service.capabilities.roles.includes('official'))
  assert(!fixture.service.capabilities.roles.includes(custom.agentSpecId))
})

test('missing verification or fewer than three exact roles rejects new tasks before any model call', async t => {
  const fixture = await setup(t)
  fixture.workbench.saveAgent({ agentSpecId: 'imitation', name: 'verification', instructions: '名字不能替代内建核验角色身份。' })
  fixture.remove('verification')
  assert.equal(fixture.service.capabilities.teamAvailability.available, false)
  assert.throws(() => fixture.service.createRequest({ question }), { code: 'AGENT_TEAM_UNAVAILABLE', status: 409 })
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.service.listRequests().length, 0)
  const second = await setup(t)
  for (const id of second.workbench.listAgents().map(role => role.agentSpecId).filter(id => !['verification', 'timeline'].includes(id))) second.remove(id)
  assert.throws(() => second.service.createRequest({ question, purpose: 'research' }), { code: 'AGENT_TEAM_UNAVAILABLE', status: 409 })
  assert.equal(second.calls.length, 0)
})

test('strict fixed rules preflight their required roles and warning can use the still-active statistics seat', async t => {
  const fixture = await setup(t)
  fixture.remove('market')
  assert.throws(() => fixture.service.createRequest({ question: 'BTC价格会高于固定基准吗？', mode: 'strict', strict: { targetAt: '2026-11-22T01:00:00Z', resolutionSourceUrl: PRICE_URL, resolutionRule: PRICE_RULE } }), { code: 'AGENT_TEAM_UNAVAILABLE', status: 409 })
  assert.equal(fixture.calls.length, 0)
  fixture.remove('industry')
  const created = fixture.service.createRequest({ question: '香港天文台红色火灾危险警告会持续吗？', mode: 'strict', strict: { targetAt: '2026-11-22T01:00:00Z', resolutionSourceUrl: WARNING_URL, resolutionRule: WARNING_RULE } })
  await fixture.service.idle()
  const run = fixture.service.getRequest(created.requestId).run
  assert(run.assignments.some(item => item.roleId === 'statistics'))
  assert(!run.assignments.some(item => item.roleId === 'industry'))
  assert.notEqual(run.error?.code, 'DELEGATION_CAPABILITY')
})

test('new custom roles can be genuinely delegated without impersonating a built-in role', async t => {
  const fixture = await setup(t, (response, input) => {
    const context = contextOf(input.messages)
    const call = response.message.tool_calls?.[0]
    if (context.kind === 'course-main' && call?.function.name === 'draft_and_delegate') {
      const args = JSON.parse(call.function.arguments)
      args.assignments[0].roleId = 'custom-specialist'
      call.function.arguments = JSON.stringify(args)
    }
    return response
  })
  fixture.workbench.saveAgent({ agentSpecId: 'custom-specialist', name: '自定义研究员', instructions: '实际读取并引用本轮公开资料，保留不确定性。' })
  const request = fixture.service.createRequest({ question, watch: false })
  await fixture.service.idle()
  const done = fixture.service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  const assignment = done.run.assignments.find(item => item.roleId === 'custom-specialist')
  assert(assignment); assert.equal(assignment.name, '自定义研究员')
  assert(!fixture.calls.some(call => call.messages.some(message => typeof message.content === 'string' && message.content.includes('undefined 查询'))))
})

test('a created run keeps its role versions for initial work and followup even after global edits or deletion', async t => {
  const fixture = await setup(t)
  const original = fixture.workbench.getAgent('official')
  const created = fixture.service.createRequest({ question, watch: false })
  fixture.workbench.saveAgent({ agentSpecId: 'official', expectedVersion: original.specVersion, instructions: 'NEW_TEMPLATE_MUST_NOT_ENTER_EXISTING_RUN' })
  fixture.remove('official')
  fixture.remove('verification')
  await fixture.service.idle()
  const done = fixture.service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert(done.run.assignments.some(item => item.roleId === 'official'))
  assert(done.run.assignments.some(item => item.roleId === 'verification' && item.followUp))
  assert(!fixture.calls.some(call => call.messages.some(message => typeof message.content === 'string' && message.content.includes('NEW_TEMPLATE_MUST_NOT_ENTER_EXISTING_RUN'))))
})

test('later manual and scheduled checks cannot revive a removed original team or spend model calls', async t => {
  const fixture = await setup(t)
  const created = fixture.service.createRequest({ question, watch: true })
  await fixture.service.idle()
  const before = fixture.service.getRequest(created.requestId)
  const callCount = fixture.calls.length
  fixture.remove('verification')
  assert.throws(() => fixture.service.check(created.requestId), { code: 'AGENT_TEAM_UNAVAILABLE', status: 409 })
  assert.equal(fixture.calls.length, callCount)
  const watchBefore = fixture.service.getRequest(created.requestId).watch
  assert.equal(watchBefore.status, 'active')
  await fixture.service.close()
  const store = createCourseStore({ path: fixture.coursePath, now: () => NOW })
  const queued = store.queueRun(created.requestId, 'watch')
  store.close()
  await fixture.reopen()
  fixture.service.resume(); await fixture.service.idle()
  const failed = fixture.service.getRun(queued.runId)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'AGENT_TEAM_UNAVAILABLE')
  assert.equal(failed.usage.modelRequests, 0)
  assert.equal(fixture.calls.length, callCount)
  const after = fixture.service.getRequest(created.requestId)
  assert.equal(after.forecasts.length, before.forecasts.length)
  assert.equal(after.watch.status, 'active')
})

test('dynamic tool contracts accept only run catalogue IDs without mutating baseline schemas', () => {
  const ids = ['custom-specialist', 'timeline', 'verification']
  const tools = createRoleToolset(ids)
  const assignment = roleId => ({ roleId, objective: '调查原文', reason: '对应职责' })
  assert(tools.validate('delegate_work', { assignments: ids.map(assignment) }))
  assert(!tools.validate('delegate_work', { assignments: ['official', 'timeline', 'verification'].map(assignment) }))
  assert(nativeTool('delegate_work').function.parameters.properties.assignments.items.properties.roleId.enum.includes('official'))
  assert.deepEqual(suggestedRoles(question, ids), ['timeline', 'custom-specialist', 'verification'])
})
