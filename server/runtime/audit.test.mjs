import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createStore } from '../core/store.mjs'
import { runWorker } from './worker-loop.mjs'
import { createResearchService } from './research-service.mjs'
import { createModelProvider } from './model-provider.mjs'
import { createProbeProvider } from './probe-provider.mjs'

const assignment = {
  topicId: 'audit-topic', predictionId: 'audit-prediction', runId: 'audit-run',
  assignmentId: 'audit-assignment', agentInstanceId: 'audit-worker',
  objective: 'Read the supplied audit fixture and submit a sourced report.',
  inputEvidence: [], allowedTools: ['read_fixture'], timePolicy: 'live',
  budget: { maxToolCalls: 1 },
}
const agentSpec = {
  agentSpecId: 'official', specVersion: 1,
  instructions: 'Use the supplied fixture.', allowedTools: ['read_fixture'],
}
const toolResult = {
  status: 'ok', data: { text: 'Audit fixture only.' }, evidenceIds: ['audit-evidence'],
  summary: 'Read the audit fixture.', observedAt: '2026-11-18T08:00:00Z', error: null,
}
const toolCall = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})
const response = (call) => ({
  message: { role: 'assistant', content: null, tool_calls: [call] },
  finishReason: 'tool_calls', usage: { total_tokens: 10 },
})

test('audit: recovery can use a durable last-budget receipt before another tool attempt', async (t) => {
  const store = createStore({ path: ':memory:' })
  t.after(() => store.close())
  store.createRun({ ...assignment, status: 'running' })
  let executions = 0
  let receiptLookups = 0
  let checkpoint
  let modelRequests = 0
  const provider = {
    async complete() {
      modelRequests += 1
      if (modelRequests === 1) return response(toolCall('audit-read', 'read_fixture', {}))
      return response(toolCall('audit-submit', 'submit_report', {
        status: 'complete', summary: 'Read one supplied fixture.', evidenceIds: ['audit-evidence'],
        support: [{ claim: 'The fixture was read.', evidenceIds: ['audit-evidence'] }],
        counterevidence: [], missingEvidence: [], probability: null, nextSuggestion: '',
      }))
    },
  }
  const tools = [{
    toolId: 'read_fixture', version: 1,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute(args, context) {
      receiptLookups += 1
      const previous = store.getToolReceipt(assignment.runId, context.toolCallId)
      if (previous) return previous.result
      executions += 1
      store.commitStep({
        runId: assignment.runId,
        toolReceipt: {
          toolCallId: context.toolCallId, toolId: 'read_fixture', arguments: args, result: toolResult,
        },
      })
      return toolResult
    },
  }]
  await assert.rejects(runWorker({
    provider, assignment, agentSpec, tools,
    onCheckpoint(state) {
      if (state.toolExecutions.length) throw new Error('Audit crash before worker checkpoint commit')
      checkpoint = state
    },
  }), /Audit crash before worker checkpoint commit/)
  assert.equal(checkpoint.usage.toolCalls, 1)
  assert.equal(checkpoint.pendingToolCalls[0].id, 'audit-read')
  assert.equal(store.getToolReceipt(assignment.runId, 'audit-read').result.summary, toolResult.summary)

  const output = await runWorker({ provider, assignment, agentSpec, tools, resume: checkpoint })
  assert.equal(output.report.status, 'complete')
  assert.equal(executions, 1, 'The completed handler must run only once')
  assert.equal(receiptLookups, 2, 'Recovery must consult the durable receipt')
  assert.equal(output.usage.toolCalls, 1, 'Reading an existing receipt must preserve the tool budget')
})

test('audit: restart cannot silently replace the model pinned to an unfinished run', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-audit-model-'))
  const path = join(folder, 'audit.sqlite')
  const services = []
  t.after(async () => {
    for (const service of services) await service.close()
    await rm(folder, { recursive: true, force: true })
  })
  let announceRequest
  const requested = new Promise((resolve) => { announceRequest = resolve })
  const first = createResearchService({
    path, modelMode: 'mock', provider: {
      model: 'audit-original-model',
      complete() { announceRequest(); return new Promise(() => {}) },
    },
  })
  services.push(first)
  const run = first.createProbe({
    objective: 'Read a supplied audit fixture.',
    evidence: [{ evidenceId: 'audit-document', title: 'Audit fixture', text: 'Fixture only.' }],
  })
  await requested
  await first.close()

  let changedModelCalls = 0
  const restarted = createResearchService({
    path, modelMode: 'live', provider: {
      model: 'audit-replacement-model',
      async complete() {
        changedModelCalls += 1
        return response(toolCall('audit-replaced-model-report', 'submit_report', {
          status: 'insufficient', summary: 'No acquired evidence.', evidenceIds: [], support: [],
          counterevidence: [], missingEvidence: ['Original configured model'], probability: null,
          nextSuggestion: 'Restore the original run configuration.',
        }))
      },
    },
  })
  services.push(restarted)
  restarted.resume()
  await restarted.idle()
  assert.equal(changedModelCalls, 0, 'The stored mock run must not send its materials to a replacement live model')
  assert.equal(restarted.getRun(run.runId).status, 'waiting')
  assert.equal(restarted.getRun(run.runId).error.code, 'MODEL_CONFIGURATION_CHANGED')
  const waitingEventCount = restarted.listEvents({ runId: run.runId }).length
  restarted.resume()
  await restarted.idle()
  assert.equal(restarted.listEvents({ runId: run.runId }).length, waitingEventCount)
  await restarted.close()

  let restoredModelCalls = 0
  const restored = createResearchService({
    path, modelMode: 'mock', provider: {
      model: 'audit-original-model',
      async complete() {
        restoredModelCalls += 1
        return response(toolCall('audit-original-model-report', 'submit_report', {
          status: 'insufficient', summary: 'The original model is restored.', evidenceIds: [], support: [],
          counterevidence: [], missingEvidence: ['Further material'], probability: null, nextSuggestion: '',
        }))
      },
    },
  })
  services.push(restored)
  restored.resume()
  await restored.idle()
  assert.equal(restoredModelCalls, 1)
  assert.equal(restored.getRun(run.runId).status, 'completed')
  assert.equal(restored.getRun(run.runId).error, null)
})

test('audit: completed worker and completion events survive process exit before run finalization', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-audit-completion-'))
  const path = join(folder, 'audit.sqlite')
  let restarted
  let reopened
  t.after(async () => {
    await restarted?.close()
    reopened?.close()
    await rm(folder, { recursive: true, force: true })
  })
  const serviceUrl = new URL('./research-service.mjs', import.meta.url).href
  const storeUrl = new URL('../core/store.mjs', import.meta.url).href
  const script = `
    import { createResearchService } from ${JSON.stringify(serviceUrl)};
    import { createStore } from ${JSON.stringify(storeUrl)};
    const path = ${JSON.stringify(path)};
    const service = createResearchService({ path });
    service.subscribe((event) => {
      if (event.type !== 'assignment.completed') return;
      const reader = createStore({ path });
      const run = reader.getRun(event.runId);
      const events = reader.listEvents({ runId: event.runId });
      const valid = run.status === 'running'
        && run.checkpoint.worker.status === 'completed'
        && events.filter((entry) => entry.type === 'tool.completed').length === 3
        && events.filter((entry) => entry.type === 'assignment.completed').length === 1
        && !events.some((entry) => entry.type === 'run.finished');
      process.stdout.write(JSON.stringify({ runId: event.runId, valid }));
      process.exit(valid ? 0 : 31);
    });
    service.createProbe({ objective: 'Read the supplied fixture.',
      evidence: [{ evidenceId: 'audit-document', title: 'Audit fixture', text: 'Fixture only.' }] });
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  const { runId, valid } = JSON.parse(child.stdout)
  assert.equal(valid, true)

  reopened = createStore({ path })
  const before = reopened.listEvents({ runId })
  const completionIds = before.filter((event) => ['tool.completed', 'assignment.completed'].includes(event.type))
    .map((event) => event.eventId)
  let modelCalls = 0
  restarted = createResearchService({ path, provider: {
    model: 'offline-protocol-fixture',
    complete() { modelCalls += 1; throw new Error('A completed checkpoint must not request a model') },
  } })
  restarted.resume()
  await restarted.idle()
  assert.equal(modelCalls, 0)
  assert.equal(restarted.getRun(runId).status, 'completed')
  const after = restarted.listEvents({ runId })
  assert.deepEqual(after.filter((event) => ['tool.completed', 'assignment.completed'].includes(event.type))
    .map((event) => event.eventId), completionIds)
  assert.equal(after.filter((event) => event.type === 'run.finished').length, 1)
  restarted.resume()
  await restarted.idle()
  assert.equal(restarted.listEvents({ runId }).filter((event) => event.type === 'run.finished').length, 1)
})

test('audit: private protocol and fixture credentials stay out of public runs, snapshots and events', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-audit-public-'))
  const path = join(folder, 'audit.sqlite')
  const privateMarker = 'AUDIT_PRIVATE_REASONING_FIXTURE'
  const fixtureCredential = 'AUDIT_SYNTHETIC_CREDENTIAL_ONLY'
  const offline = createProbeProvider()
  const provider = createModelProvider({
    WORLD_API_KEY: fixtureCredential, WORLD_MODEL_NAME: 'audit-model',
    WORLD_BASE_URL: 'https://audit.invalid/v1',
  }, async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${fixtureCredential}`)
    const answer = await offline.complete(JSON.parse(options.body))
    return Response.json({
      choices: [{ message: { ...answer.message, reasoning_content: privateMarker }, finish_reason: answer.finishReason }],
      usage: { total_tokens: 10 },
    })
  })
  const service = createResearchService({ path, provider, modelMode: 'live' })
  let internal
  t.after(async () => {
    await service.close()
    internal?.close()
    await rm(folder, { recursive: true, force: true })
  })
  const observed = []
  service.subscribe((event) => observed.push(event))
  const run = service.createProbe({
    objective: 'Read the supplied fixture.',
    evidence: [{ evidenceId: 'audit-document', title: 'Audit fixture', text: 'Fixture only.' }],
  })
  await service.idle()
  assert.equal(service.getRun(run.runId).status, 'completed')
  internal = createStore({ path })
  assert(JSON.stringify(internal.getRun(run.runId).checkpoint).includes(privateMarker),
    'The private checkpoint must actually contain the test marker')
  for (const output of [service.getRun(run.runId), service.listRuns(), service.snapshot(), service.listEvents(), observed]) {
    const serialized = JSON.stringify(output)
    assert(!serialized.includes(privateMarker))
    assert(!serialized.includes(fixtureCredential))
    assert(!serialized.includes('reasoning_content'))
    assert(!serialized.includes('"messages"'))
    assert(!serialized.includes('"checkpoint"'))
  }
})
