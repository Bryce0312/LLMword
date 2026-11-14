import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProvider } from './provider.mjs'
import { createToolRegistry } from './tools.mjs'
import { createWorld } from './world.mjs'

const mock = () => createProvider({ WORLD_MODEL: 'mock' })

test('meeting uses only visible citations and locks a base forecast once', async () => {
  const world = createWorld({ provider: mock() })
  const initial = await world.get()
  assert.equal(initial.forecast, null)
  assert.equal(initial.stages[1].date, null)
  assert.deepEqual(initial.evidence.map((entry) => entry.id), ['amd-10k', 'nvda-8k'])
  assert.equal(initial.agents.length, 5)
  assert(initial.agents.every((agent) => agent.skillText && agent.tools.length))
  const first = await world.run()
  assert.equal(first.forecast.prior, 0.660)
  assert.equal(first.forecast.probability, 0.637)
  assert.equal(first.forecast.marketProbability, null)
  assert.equal(first.forecast.lockedProbability, 0.637)
  assert(first.trace.some((row) => row.stage === 'challenge'))
  assert(first.trace.some((row) => row.stage === 'review'))
  assert(first.trace.every((row) => row.sourceIds.every((id) => initial.evidence.some((entry) => entry.id === id))))
  const hypothetical = await world.run({ branch: 'narrow' })
  assert.equal(hypothetical.forecast.branch, 'narrow')
  assert(hypothetical.forecast.probability < first.forecast.probability)
  assert.equal(hypothetical.forecast.lockedProbability, undefined)
  assert.equal(hypothetical.forecast.transitions[1].to, 'conditional')
  assert.deepEqual(hypothetical.factors, first.factors)
  first.forecast.probability = 0
  const advanced = await world.advance()
  assert.equal(advanced.learning.resolved, 1)
  assert.equal(advanced.learning.history[0].probability, 0.637)
  assert.equal(advanced.outcome.value, 1)
})

test('a hypothetical alone cannot train and future disclosures stay unavailable', async () => {
  const world = createWorld({ provider: mock() })
  await world.run({ branch: 'broad' })
  const next = await world.advance()
  assert.equal(next.learning.resolved, 0)
  assert.equal(next.learning.adjustment, 0)
  assert.equal(next.evidence.some((item) => item.id === 'nvda-q1'), false)
  const run = await world.run()
  assert.equal(run.forecast.beforeLearning, run.forecast.probability)
  const resolved = await world.advance()
  assert.equal(resolved.learning.resolved, 1)
  const recap = await world.run()
  assert.equal(recap.forecast.probability, null)
  assert.equal(recap.forecast.target, null)
  assert(recap.trace.every((row) => !row.sourceIds.includes('amd-q2')))
})

test('meeting speaks from each table and streams a ready report while another seat is still working', { timeout: 3000 }, async () => {
  const fallback = mock()
  let releaseCompany
  const waitingForCompany = new Promise((resolve) => { releaseCompany = resolve })
  let hearFirstReport
  const heardReport = new Promise((resolve) => { hearFirstReport = resolve })
  const events = []
  const world = createWorld({ provider: {
    mode: fallback.mode,
    async decide(input) {
      if (input.agentId === 'company' && input.action === 'analyze') await waitingForCompany
      return await fallback.decide(input)
    },
  } })
  const run = world.run({
    runId: 'live-test',
    onEvent(event) {
      events.push(event)
      if (event.row?.stage === 'analysis') hearFirstReport(event)
    },
  })

  try {
    const first = await Promise.race([
      heardReport,
      run.then(() => assert.fail('The run finished before its first report arrived')),
    ])
    const roundTable = events.findIndex(({ type, room }) => type === 'movement' && room === 'meeting')
    assert(roundTable >= 0 && roundTable < events.indexOf(first))
    assert.equal(first.runId, 'live-test')
    assert.notEqual(first.row.agentId, 'company')
    assert(events.every(({ stage }) => stage !== 'challenge'))
    const companyTasks = events.filter(({ type, agentId }) => type === 'task' && agentId === 'company')
    assert.deepEqual(companyTasks.map(({ taskId, status }) => `${taskId}:${status}`), [
      'company-lookup:start', 'company-lookup:complete', 'company-analyze:start',
    ])
  } finally {
    releaseCompany()
  }

  const state = await run
  const speakers = events.flatMap((event) => {
    if (event.type === 'movement') return [event.room]
    if (event.type === 'side-meeting') {
      assert.deepEqual(event.agentIds, ['chair', 'company'])
      return [event.status]
    }
    if (event.row?.kind === 'message') return [`${event.row.stage}:${event.row.agentId}`]
    return []
  })
  assert.deepEqual(speakers.slice(0, 2), ['desks', 'meeting'])
  assert.deepEqual(speakers.slice(2, 6).sort(), ['analysis:company', 'analysis:market', 'analysis:policy', 'analysis:supply'])
  assert.deepEqual(speakers.slice(6), [
    'start', 'side-meeting', 'challenge:chair', 'review:company', 'end', 'meeting', 'decision:chair',
  ])
  assert.deepEqual(events.filter((event) => event.type === 'trace').map((event) => event.row), state.trace)
  for (const row of state.trace.filter(({ kind }) => kind === 'message')) {
    const reportEvents = events.filter(({ type, taskId }) => type === 'task' && taskId === row.taskId)
    assert.deepEqual(reportEvents.map(({ status }) => status), ['start', 'complete'])
    assert.equal(reportEvents[1].message, row.message)
    assert.equal(reportEvents[1].agentId, row.agentId)
    assert.deepEqual(reportEvents[1].sourceIds, row.sourceIds)
    const complete = events.indexOf(reportEvents[1])
    assert.equal(events[complete + 1].row.taskId, row.taskId)
    const latestMovement = events.slice(0, complete).findLast(({ type, agentIds }) =>
      type === 'movement' && agentIds.includes(row.agentId))
    assert.equal(latestMovement.room, ['challenge', 'review'].includes(row.stage) ? 'side-meeting' : 'meeting')
  }
  const lookupCompletions = events.filter(({ type, status, taskId }) =>
    type === 'task' && status === 'complete' && taskId.endsWith('-lookup'))
  assert.deepEqual(lookupCompletions.map(({ agentId }) => agentId), ['policy', 'supply', 'company', 'market'])
  for (const { agentId, message, sourceIds } of lookupCompletions) {
    const lookupTraces = state.trace.filter((row) => row.kind === 'tool' && row.agentId === agentId)
      .slice(0, agentId === 'supply' || agentId === 'company' ? 3 : 2)
    assert.equal(message, lookupTraces.map((row) => row.message).join(''))
    assert.deepEqual(sourceIds, [...new Set(lookupTraces.flatMap((row) => row.sourceIds))])
  }

  await world.advance()
  events.length = 0
  await world.run({ onEvent: (event) => events.push(event) })
  assert(events.every(({ type, stage }) => type !== 'side-meeting' && stage !== 'challenge'))
})

test('unauthorized tool batches publish no task events or tool traces', () => {
  const unexpectedCall = () => assert.fail('Unauthorized batch produced output')
  const tools = createToolRegistry({ evidence: [] }, unexpectedCall, unexpectedCall)
  const agent = { id: 'policy', tools: ['search_evidence'] }
  assert.throws(() => tools.batch(agent, [
    ['search_evidence', { topic: 'policy' }], ['verify_sources', { ids: [] }],
  ], 'policy-lookup', '查找政策依据'), /没有 verify_sources 权限/)
})

test('a failed challenge dismisses the side meeting without committing a forecast', async () => {
  const fallback = mock()
  const world = createWorld({ provider: {
    mode: fallback.mode,
    decide(input) {
      if (input.action === 'challenge') throw new Error('模拟主持人故障')
      return fallback.decide(input)
    },
  } })
  const events = []
  await assert.rejects(world.run({ onEvent: (event) => events.push(event) }), /模拟主持人故障/)
  assert.deepEqual(events.filter(({ type }) => type === 'side-meeting').map(({ status }) => status), ['start', 'end'])
  assert.deepEqual(events.filter(({ taskId }) => taskId === 'chair-challenge').map(({ status }) => status), ['start'])
  assert.equal(events.at(-1).room, 'meeting')
  assert.equal((await world.get()).forecast, null)
})

test('resolved learning persists and changes the next forecast; reset clears it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'world-lab-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const statePath = join(folder, 'state.json')
  const first = createWorld({ statePath, provider: mock() })
  await first.run()
  const firstResolution = await first.advance()
  assert(firstResolution.learning.adjustment > 0)

  const resumed = createWorld({ statePath, provider: mock() })
  const saved = await resumed.get()
  assert.equal(saved.step, 1)
  assert.equal(saved.learning.history.length, 1)
  const secondForecast = await resumed.run()
  assert(secondForecast.forecast.probability > secondForecast.forecast.beforeLearning)
  const resolutions = await Promise.all([resumed.advance(), resumed.advance(), resumed.advance()])
  assert.deepEqual(resolutions.map((state) => state.learning.resolved), [2, 2, 2])
  assert.deepEqual(resolutions.map((state) => state.step), [2, 3, 3])
  const cleared = await resumed.reset()
  assert.equal(cleared.step, 0)
  assert.equal(cleared.learning.resolved, 0)
})

test('unavailable citations are rejected atomically', async () => {
  const fallback = mock()
  const world = createWorld({ provider: {
    mode: 'mock',
    decide: (input) => input.agentId === 'policy'
      ? { finding: 'Unavailable', evidenceIds: ['nvda-q1'], probability: 0.9 }
      : fallback.decide(input),
  } })
  await assert.rejects(world.run(), /引用检查/)
  assert.equal((await world.get()).forecast, null)
  const next = await world.advance()
  assert.equal(next.learning.resolved, 0)
})

test('live adapter sends role skills and frozen inputs to an OpenAI-compatible endpoint', async () => {
  const recorded = []
  const transport = async (url, options) => {
    const request = JSON.parse(options.body)
    const input = JSON.parse(request.messages[1].content)
    recorded.push({ url, auth: options.headers.Authorization, request, input })
    const answer = {
      finding: '测试已收到此角色的档案与说明。',
      evidenceIds: input.allowedIds.slice(0, 1),
      probability: input.expectsProbability && input.allowedIds.length ? 0.6 : null,
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] })
  }
  const provider = createProvider({
    WORLD_MODEL: 'openai',
    WORLD_BASE_URL: 'http://127.0.0.1:9999/v1',
    WORLD_MODEL_NAME: 'local-protocol-test',
    WORLD_API_KEY: 'local-fake-key',
  }, transport)
  const world = createWorld({ provider })
  const run = await world.run()
  assert.equal(run.mode, 'live')
  assert.equal(run.forecast.probability, 0.6)
  assert.equal(recorded.length, 7)
  assert(recorded.every(({ url, auth, request, input }) =>
    url === 'http://127.0.0.1:9999/v1/chat/completions' && auth === 'Bearer local-fake-key' &&
    request.model === 'local-protocol-test' && request.messages[0].content.includes('专职 Agent') &&
    input.cutoff === run.cutoff && !JSON.stringify(input).includes('amd-8k')))
})
