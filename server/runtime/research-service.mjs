import { createHash, randomUUID } from 'node:crypto'
import { createStore } from '../core/store.mjs'
import { parseProbe, runtimeFailure } from '../core/contracts.mjs'
import { runWorker } from './worker-loop.mjs'
import { createProbeProvider } from './probe-provider.mjs'

const TERMINAL = new Set(['completed', 'cancelled', 'failed'])
const AGENT = Object.freeze({
  agentSpecId: 'official', specVersion: 1,
  instructions: '这是一项运行时技术验证。先列出提供的材料，再读取相关正文；只使用真实工具结果，提交公开调查摘要，probability 必须为 null。',
  allowedTools: ['list_provided_sources', 'read_evidence'],
})

export function publicRun(run) {
  if (!run) return null
  const { runId, topicId, predictionId, scope, trigger, status, version, createdAt, updatedAt } = run
  const saved = run.checkpoint ?? {}
  const report = saved.worker?.report ?? saved.result?.report ?? null
  const assignmentStatus = report?.status || ({ queued: 'queued', waiting: 'waiting', running: 'running', cancelled: 'cancelled', failed: 'failed' })[status] || 'pending'
  return {
    runId, topicId, predictionId, scope, trigger, status, version, createdAt, updatedAt,
    stage: run.config.stage || 'M0', kind: run.config.kind || 'tool-loop-probe', modelMode: run.config.modelMode,
    predictionVersion: run.config.predictionVersion ?? null,
    inputSnapshotAt: run.config.inputSnapshotAt || run.createdAt,
    agent: { agentSpecId: run.config.agentSpec.agentSpecId, specVersion: run.config.agentSpec.specVersion,
      name: run.config.agentSpec.name || '官方资料研究员' },
    assignment: { ...run.config.assignment, status: assignmentStatus },
    report,
    usage: saved.worker?.usage ?? saved.result?.usage ?? null,
    error: saved.error ?? null,
  }
}

/** M0 one-worker probe. Supervisor and forecast publishing are separate milestones. */
export function createResearchService({ path, provider = createProbeProvider(), modelMode = 'mock', maxConcurrent = 4 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw runtimeFailure('INVALID_CONCURRENCY', '模型并发上限应为一至四。')
  const store = createStore({ path })
  const jobs = new Map()
  const listeners = new Set()
  const providerIdentity = provider.configurationId || provider.model || 'injected'
  let closed = false
  let stopping = false

  const emit = (events) => {
    for (const event of events) for (const listener of listeners) {
      try { listener(event) } catch { /* A subscriber cannot roll back committed work. */ }
    }
  }
  const commit = (input) => {
    const result = store.commitStep(input)
    if (!result.duplicate) emit(result.events)
    return result.run
  }
  const requireRun = (runId) => {
    const run = store.getRun(runId)
    if (!run) throw runtimeFailure('RUN_NOT_FOUND', '找不到此运行。', 404)
    return run
  }
  const ensureActive = (runId, signal) => {
    if (signal?.aborted || TERMINAL.has(requireRun(runId).status)) throw runtimeFailure('RUN_CANCELLED', '此运行已停止。', 409)
  }

  function toolsFor(run, controller) {
    const records = new Map(run.config.evidence.map((item) => [item.evidenceId, item]))
    const result = (data, evidenceIds, summary) => ({
      status: 'ok', data, evidenceIds, summary, observedAt: new Date().toISOString(), error: null, usage: null,
    })
    const tools = [
      {
        toolId: 'list_provided_sources', version: 1, description: '列出本轮用户提供的材料编号和标题。',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        execute: () => result({ sources: [...records.values()].map(({ evidenceId, title }) => ({ evidenceId, title })) }, [], '已列出本轮材料。'),
      },
      {
        toolId: 'read_evidence', version: 1, description: '按本轮材料编号读取原文；其他运行的编号不可用。',
        inputSchema: { type: 'object', additionalProperties: false, properties: { evidenceId: { type: 'string', minLength: 1 } }, required: ['evidenceId'] },
        execute: ({ evidenceId }) => {
          const source = records.get(evidenceId)
          if (!source) throw runtimeFailure('EVIDENCE_NOT_FOUND', '此材料不属于当前运行。', 404)
          return result(source, [source.evidenceId], `已读取「${source.title}」。`)
        },
      },
    ]
    return tools.map((tool) => ({
      ...tool,
      async execute(args, context) {
        ensureActive(run.runId, controller.signal)
        const previous = store.getToolReceipt(run.runId, context.toolCallId)
        if (previous) {
          if (previous.toolId !== tool.toolId || JSON.stringify(previous.arguments) !== JSON.stringify(args)) {
            throw runtimeFailure('TOOL_RECEIPT_CONFLICT', '已记录调用与当前参数不一致。', 409)
          }
          return structuredClone(previous.result)
        }
        const value = await tool.execute(args, context)
        const receipt = { toolCallId: context.toolCallId, toolId: tool.toolId, assignmentId: run.config.assignment.assignmentId,
          agentInstanceId: run.config.assignment.agentInstanceId, arguments: args, result: value }
        if (controller.signal.aborted || TERMINAL.has(requireRun(run.runId).status)) {
          store.recordLateToolReceipt({ runId: run.runId, toolReceipt: receipt })
          throw runtimeFailure('RUN_CANCELLED', '迟到结果只保存审计。', 409)
        }
        commit({ runId: run.runId, toolReceipt: receipt })
        return value
      },
    }))
  }

  async function execute(runId, controller) {
    let run = requireRun(runId)
    let saved = { ...(run.checkpoint ?? {}), error: null }
    const seen = new Set(store.listEvents({ runId, limit: 1000 }).map((event) => event.eventId))
    const projectedEvent = (type, payload) => ({
      type, payload: { ...payload, assignmentId: run.config.assignment.assignmentId,
        agentInstanceId: run.config.assignment.agentInstanceId, agentSpecId: run.config.agentSpec.agentSpecId,
        specVersion: run.config.agentSpec.specVersion },
      eventId: `${runId}_${type.replaceAll('.', '_')}_${payload.toolCallId || payload.resultId || run.config.assignment.assignmentId}`,
    })
    const unseen = (events) => events.filter((event) => !seen.has(event.eventId))
    const remember = (events) => { for (const event of events) seen.add(event.eventId) }
    try {
      run = commit({ runId, status: 'running', checkpoint: saved, event: { type: 'run.started', payload: { resumed: Boolean(saved.worker) } } })
      const value = await runWorker({
        provider, assignment: run.config.assignment, agentSpec: run.config.agentSpec,
        tools: toolsFor(run, controller), enabledToolIds: run.config.agentSpec.allowedTools,
        signal: controller.signal, resume: saved.worker,
        async onCheckpoint(worker) {
          ensureActive(runId, controller.signal)
          saved = { ...saved, worker }
          // Store completion and the state that proves it in the same transaction.
          const events = worker.toolExecutions.map(({ toolCallId, toolId, result }) => projectedEvent(
            result.status === 'error' ? 'tool.failed' : 'tool.completed',
            { toolCallId, toolId, status: result.status, summary: result.summary, evidenceIds: result.evidenceIds },
          ))
          if (worker.report) events.push(projectedEvent('assignment.completed', {
            resultId: worker.report.resultId, status: worker.report.status,
            summary: worker.report.summary, evidenceIds: worker.report.evidenceIds,
          }))
          const fresh = unseen(events)
          commit({ runId, checkpoint: saved, events: fresh })
          remember(fresh)
        },
        async onEvent(event) {
          ensureActive(runId, controller.signal)
          const fresh = unseen([projectedEvent(event.type, event.payload)])
          if (fresh.length) { commit({ runId, events: fresh }); remember(fresh) }
        },
      })
      ensureActive(runId, controller.signal)
      saved = { ...saved, result: value }
      commit({ runId, status: 'completed', checkpoint: saved, event: { type: 'run.finished', payload: { reportStatus: value.report.status } } })
    } catch (error) {
      if (stopping || closed || TERMINAL.has(requireRun(runId).status)) return
      saved = { ...saved, error: {
        code: error.code || 'RUNTIME_FAILED', message: error.code ? error.message : '运行未完成。', retryable: Boolean(error.retryable),
      } }
      commit({ runId, status: 'failed', checkpoint: saved, event: { type: 'run.failed', payload: { error: saved.error } } })
    }
  }

  function pump() {
    if (closed || stopping) return
    for (const run of store.listRuns()) {
      if (jobs.size >= maxConcurrent) break
      if (TERMINAL.has(run.status) || jobs.has(run.runId)) continue
      if (run.config.modelMode !== modelMode || run.config.providerIdentity !== providerIdentity) {
        if (run.status !== 'waiting' || run.checkpoint?.error?.code !== 'MODEL_CONFIGURATION_CHANGED') {
          const error = { code: 'MODEL_CONFIGURATION_CHANGED', message: '模型配置已改变；恢复原配置后才能继续此运行。', retryable: false }
          commit({ runId: run.runId, status: 'waiting', checkpoint: { ...run.checkpoint, error }, event: { type: 'run.waiting', payload: { error } } })
        }
        continue
      }
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => execute(run.runId, controller)).finally(() => {
        jobs.delete(run.runId)
        pump()
      })
      jobs.set(run.runId, { controller, promise })
    }
  }

  function findCreatedRun(predictionId, idempotencyKey, operationHash) {
    if (!idempotencyKey) return null
    const previous = store.listRuns({ predictionId }).find((item) => item.config.createKey === idempotencyKey)
    if (!previous) return null
    if (operationHash && previous.config.inputHash !== operationHash) throw runtimeFailure('IDEMPOTENCY_CONFLICT', '此幂等键已用于不同输入。', 409)
    return publicRun(previous)
  }

  function createProbe(input, { idempotencyKey, agentSpec = AGENT, predictionVersion,
    kind = 'tool-loop-probe', operationHash, evidenceRecords } = {}) {
    if (closed || stopping) throw runtimeFailure('SERVICE_STOPPED', '运行服务已停止。', 503)
    const data = parseProbe(input)
    const selectedAgent = structuredClone(agentSpec)
    if (selectedAgent.modelRef && !['primary', provider.model].includes(selectedAgent.modelRef)) {
      throw runtimeFailure('MODEL_UNAVAILABLE', '所选角色的模型引用尚未配置，请选择当前主模型。', 409)
    }
    selectedAgent.allowedTools = [...new Set([...selectedAgent.allowedTools, ...(selectedAgent.extensionSlots || []).filter(Boolean)])]
    if (selectedAgent.allowedTools.some((id) => !['list_provided_sources', 'read_evidence'].includes(id))) {
      throw runtimeFailure('TOOL_UNAVAILABLE', '所选角色包含尚未接通的工具。', 409)
    }
    // Stable config makes retrying one create request return the same run.
    const fingerprint = operationHash || createHash('sha256').update(JSON.stringify(data)).digest('hex')
    const key = idempotencyKey || randomUUID()
    const previous = store.listRuns({ predictionId: data.predictionId }).find((item) => item.config.createKey === key)
    if (previous) {
      if (previous.config.inputHash !== fingerprint) throw runtimeFailure('IDEMPOTENCY_CONFLICT', '此幂等键已用于不同输入。', 409)
      return publicRun(previous)
    }
    if (store.listRuns({ predictionId: data.predictionId }).some((run) => !TERMINAL.has(run.status))) {
      throw runtimeFailure('PREDICTION_BUSY', '同一验证问题已有运行，请等待结束或取消。', 409)
    }
    const runId = `run_${randomUUID()}`
    const now = new Date().toISOString()
    const originalRecords = new Map((evidenceRecords || []).map((record) => [record.evidenceId, record]))
    const evidenceSnapshot = data.evidence.map((item) => {
      const source = originalRecords.get(item.evidenceId)
      if (source && (source.text !== item.text || source.title !== item.title)) {
        throw runtimeFailure('EVIDENCE_SNAPSHOT_CONFLICT', '原始材料与本轮快照不一致。', 409)
      }
      return { ...item, firstSeenAt: source?.firstSeenAt || now, retrievedAt: source?.retrievedAt || now,
        publishedAt: source?.publishedAt || null,
        contentHash: source?.contentHash || createHash('sha256').update(item.text).digest('hex'),
        sourceMode: source?.sourceMode || 'provided' }
    })
    const ceilings = { maxModelRequests: 8, maxToolCalls: 6, maxTotalTokens: 16000, maxTokens: 2048, timeoutMs: 60000, maxRetries: 2 }
    const roleBudget = Object.fromEntries(Object.entries(ceilings).map(([name, value]) => [name,
      Math.min(value, selectedAgent.limits?.[name] ?? (name === 'maxTokens' ? 1200 : value)),
    ]))
    const assignment = {
      topicId: data.topicId, predictionId: data.predictionId, runId,
      assignmentId: `assignment_${randomUUID()}`, agentInstanceId: `worker_${randomUUID()}`,
      agentSpecId: selectedAgent.agentSpecId, specVersion: selectedAgent.specVersion,
      objective: data.objective, allowedTools: selectedAgent.allowedTools,
      inputEvidence: kind === 'prediction-research' ? data.evidence.map((item) => item.evidenceId) : [], timePolicy: 'live',
      deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
      budget: roleBudget,
    }
    const run = store.createRun({
      runId, topicId: data.topicId, predictionId: data.predictionId, scope: 'live', trigger: 'manual', idempotencyKey: key,
      config: { assignment, agentSpec: selectedAgent, modelMode, modelRef: provider.model || 'injected', providerIdentity, createKey: key, inputHash: fingerprint,
        kind, stage: kind === 'prediction-research' ? 'M1' : 'M0', predictionVersion: predictionVersion ?? null,
        inputSnapshotAt: now, evidence: evidenceSnapshot },
    })
    emit(store.listEvents({ runId, afterSeq: 0 }))
    pump()
    return publicRun(run)
  }

  function snapshot() {
    const runs = store.listRuns().map(publicRun)
    // Store watermarks cover the full journal, not just the first page of events.
    const cursor = runs.length ? store.getSnapshot(runs[0].runId).coveredThroughCursor : `${store.metadata.serverEpoch}:0`
    return { snapshotVersion: Number(cursor.split(':').at(-1)), coveredThroughCursor: cursor,
      runs, activeRuns: runs.filter((run) => !TERMINAL.has(run.status)).map((run) => run.runId) }
  }

  return {
    metadata: store.metadata,
    capabilities: { stage: 'M0', modelMode, modelRef: provider.model || 'injected',
      nativeToolProtocol: true, supervisor: false, forecastPublishing: false, sources: ['provided'], persistent: true },
    createProbe,
    findCreatedRun,
    getRun: (runId) => publicRun(requireRun(runId)),
    listRuns: () => store.listRuns().map(publicRun),
    snapshot,
    listEvents: (options) => store.listEvents(options),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    cancelRun(runId) {
      const run = requireRun(runId)
      const cursor = Number(store.getSnapshot(runId).coveredThroughCursor.split(':').at(-1))
      const cancelled = store.cancelRun(runId)
      jobs.get(runId)?.controller.abort()
      if (!TERMINAL.has(run.status)) emit(store.listEvents({ afterSeq: cursor, runId }))
      return publicRun(cancelled)
    },
    resume() { pump() },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs.values()].map((job) => job.promise)) },
    async close() {
      if (closed) return
      stopping = true
      for (const job of jobs.values()) job.controller.abort()
      await Promise.allSettled([...jobs.values()].map((job) => job.promise))
      listeners.clear(); store.close(); closed = true
    },
  }
}
