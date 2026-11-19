import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService, createCourseMockProvider } from './course-service.mjs'
import { createCourseStore } from './course-store.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'

const NOW = '2026-11-19T04:00:00.000Z'
const parseContext = (messages) => JSON.parse(messages.findLast((m) => m.role === 'user').content)
async function setup(t, wrap) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-routing-rules-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const gateway = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW })
  const protocol = createCourseMockProvider()
  const provider = { ...protocol, complete: (input) => wrap(input, protocol, workbench) }
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools: gateway, provider, modelMode: 'mock', now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return service
}

test('new routing delegates without research, workers fetch before a verified contract is compiled, and budgets are system instructions', async (t) => {
  const stages = [], tools = [], system = []
  let draftWorkers = 0
  const service = await setup(t, async (input, protocol, workbench) => {
    const context = parseContext(input.messages)
    const initial = JSON.parse(input.messages.find((m) => m.role === 'user').content)
    if (context.kind === 'course-main') { stages.push(context.phase); tools.push([context.phase, input.tools.map(x => x.function.name)]); system.push(input.messages[0].content) }
    if (initial.agentSpecId && JSON.parse(initial.objective).draft) {
      draftWorkers++
      assert.throws(() => workbench.getPrediction(initial.predictionId), 'No ready domain prediction may be invented before source discovery')
    }
    return protocol.complete(input)
  })
  const request = service.createRequest({ question: '【规则校验】城市科技展开幕吗', watch: false })
  await service.idle()
  const done = service.getRequest(request.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(stages[0], 'intake')
  assert.equal(stages.filter(s => s === 'intake').length, 1)
  assert.deepEqual(tools[0][1], ['draft_and_delegate'])
  assert(draftWorkers >= 3)
  assert.equal(done.run.assignments.filter(a => !a.followUp && a.report?.status === 'complete').length, 3)
  assert(stages.indexOf('prepare') > stages.indexOf('intake'))
  assert(!stages.includes('plan'), 'Initial delegation must not be repeated after contract compilation')
  assert(!done.run.events.some(e => e.payload.agentSpecId === 'main' && e.type === 'tool.started'))
  assert(system.every(s => s.includes('单次输出上限') && s.includes('剩余模型') && s.includes('≤400字')))
  assert.equal(done.run.harnessVersion, 3)
  assert.equal(done.run.draft.sourceVerified, false)
  assert(done.run.evidence.every(e => e.predictionId === done.predictionId && e.predictionVersion === done.normalized.version))
  assert(done.relations.every(r => r.predictionId === done.predictionId && r.predictionVersion === done.normalized.version))
})

test('two evidence-led follow-up cycles can revisit the same role with unique assignments and then must summarize', async (t) => {
  let followUps = 0
  const service = await setup(t, async (input, protocol) => {
    const context = parseContext(input.messages)
    const names = input.tools.map(x => x.function.name)
    const result = await protocol.complete(input)
    if (context.kind === 'course-main' && names.includes('request_followup')) {
      followUps++
      result.message.tool_calls = [{ id: 'followup_' + followUps, type: 'function', function: { name: 'request_followup', arguments: JSON.stringify({
        roleId: 'verification', objective: '核验这轮真实取得的正文口径，不重复全网。', reason: '校验有界质询与独立答复机制。', evidenceIds: context.evidence.map(e => e.evidenceId),
      }) } }]
    }
    return result
  })
  const created = service.createRequest({ question: '【规则校验】城市科技展开幕吗', watch: false })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert.equal(followUps, 2)
  assert.equal(done.run.orchestration.cycle, 3)
  assert.equal(done.run.orchestration.followUpsUsed, 2)
  const additional = done.run.assignments.filter(a => a.followUp)
  assert.deepEqual(additional.map(a => a.cycle), [2, 3])
  assert.equal(new Set(additional.map(a => a.assignmentId)).size, 2)
  assert(additional.every(a => a.status === 'completed'))
  assert.equal(done.forecasts.length, 1)
})

test('legacy queued run keeps its original preparation stage while new versions use intake', () => {
  const store = createCourseStore({ path: ':memory:', now: () => NOW })
  try {
    const old = store.createRequest({ question: '旧契约', horizonHours: 48, timezone: 'Asia/Shanghai', harnessVersion: 2 })
    const next = store.createRequest({ question: '新契约', horizonHours: 48, timezone: 'Asia/Shanghai', harnessVersion: 3 })
    assert.equal(store.getRun(old.activeRunId).phase, 'prepare')
    assert.equal(store.getRun(old.activeRunId).harnessVersion, 2)
    assert.equal(store.getRun(next.activeRunId).phase, 'intake')
    assert.equal(store.getRun(next.activeRunId).harnessVersion, 3)
  } finally { store.close() }
})
