import Ajv from 'ajv'
import { createDomainStore } from './domain-store.mjs'
import { getAgentCatalog, getToolCatalog, getPlannedToolCatalog, getSkillCatalog, PROVIDED_TOOL_IDS } from './agent-catalog.mjs'
import { digest, domainFailure, identifier } from './contracts.mjs'

const validateRun = new Ajv({ strict: true, allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  properties: {
    agentSpecId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,120}$' },
    specVersion: { type: 'integer', minimum: 1 }, predictionVersion: { type: 'integer', minimum: 1 },
    objective: { type: 'string', minLength: 1, maxLength: 2000 },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
})

/** M1 topic/contracts/role versions plus one-worker research. No forecast publisher. */
export function createWorkbenchService({ path, runtime, world, now = () => new Date().toISOString(), isAgentInUse = () => false } = {}) {
  const store = createDomainStore({ path, registeredToolIds: PROVIDED_TOOL_IDS, now })
  for (const agent of getAgentCatalog()) {
    if (!store.getAgentSpec(agent.agentSpecId, { specVersion: 1 })) store.saveAgentSpec(agent, { idempotencyKey: `builtin-${agent.agentSpecId}-v1` })
  }
  const requirePrediction = (id, options) => {
    const value = store.getPrediction(id, options)
    if (!value) throw domainFailure('PREDICTION_NOT_FOUND', '找不到此预测题或版本。', 404)
    return value
  }
  const requireTopic = (id) => {
    const value = store.getTopic(id)
    if (!value) throw domainFailure('TOPIC_NOT_FOUND', '找不到此主题。', 404)
    return value
  }
  const runsFor = (predictionId) => (runtime?.listRuns() || []).filter((run) => run.predictionId === predictionId && run.kind === 'prediction-research')
  const decorated = (prediction) => {
    const allRuns = runsFor(prediction.predictionId)
    const currentRuns = allRuns.filter((run) => run.predictionVersion === prediction.version)
    return { ...prediction, forecast: null, latestRun: currentRuns.at(-1) || null,
      activeRunId: allRuns.find((run) => !['completed', 'failed', 'cancelled'].includes(run.status))?.runId || null }
  }

  function createRun(predictionId, input = {}, options = {}) {
    identifier(predictionId, 'predictionId')
    if (!validateRun(input)) throw domainFailure('INVALID_RESEARCH_REQUEST', '研究员、版本或材料选择格式无效。', 400)
    if (!runtime) throw domainFailure('RUNTIME_DISABLED', '研究引擎未启用；请在服务端开启运行时。', 503)
    const operationHash = digest({ predictionId, input })
    const duplicate = runtime.findCreatedRun(predictionId, options.idempotencyKey, operationHash)
    if (duplicate) return duplicate
    const prediction = requirePrediction(predictionId)
    if (input.predictionVersion !== undefined && input.predictionVersion !== prediction.version) {
      throw domainFailure('VERSION_CONFLICT', '问题版本已经更新，请读取最新版本后开始。', 409, ['predictionVersion'])
    }
    const topic = requireTopic(prediction.topicId)
    if (topic.sourceMode === 'replay' || prediction.legacy) {
      throw domainFailure('REPLAY_READ_ONLY', '历史导入题保留为回放档案，请从旧案例入口运行。', 409)
    }
    if (prediction.type !== 'binary') throw domainFailure('UNSUPPORTED_PREDICTION_TYPE', '当前仅开放是／否二元预测题。')
    if (prediction.status !== 'ready' || !prediction.validation.ready) {
      throw domainFailure('PREDICTION_NOT_READY', '请先补齐期限、结果规则和来源，并保存为可研读。', 409, prediction.validation.missingFields)
    }
    if (Date.parse(prediction.forecastClosesAt) <= Date.parse(now())) {
      throw domainFailure('FORECAST_CLOSED', '该预测题已过停止发布时间，只能查看已有记录。', 409)
    }
    const agentSpecId = input.agentSpecId || 'official'
    if (store.getAgentDeletion(agentSpecId)) throw domainFailure('AGENT_DELETED', '此研究员已经删除，不能建立新的调查；旧运行和版本仍可查看。', 409)
    const agent = store.getAgentSpec(agentSpecId, { specVersion: input.specVersion })
    if (!agent) throw domainFailure('AGENT_NOT_FOUND', '找不到此研究员版本。', 404)
    let evidence = store.listEvidence({ topicId: topic.topicId, predictionId })
    if (input.evidenceIds) {
      const visible = new Set(evidence.map((item) => item.evidenceId))
      if (input.evidenceIds.some((id) => !visible.has(id))) throw domainFailure('EVIDENCE_SCOPE_MISMATCH', '材料不属于当前预测题。', 409)
      evidence = evidence.filter((item) => input.evidenceIds.includes(item.evidenceId))
    }
    if (!evidence.length) throw domainFailure('EVIDENCE_REQUIRED', '请先在收报台为本题添加材料。', 409)
    if (evidence.length > 12) throw domainFailure('EVIDENCE_LIMIT', '单轮最多研读十二份材料，请选择材料或按题目归属整理。', 409)
    const skills = getSkillCatalog()
    const methodText = agent.skillRefs.map((ref) => skills.find((skill) => skill.skillId === ref.skillId && skill.version === ref.version)?.instructions).filter(Boolean)
    const resolvedAgent = { ...agent, instructions: [agent.instructions, ...methodText, '本批仅提交带来源的研读报告，不发布正式预测；probability 为 null。'].join('\n') }
    return runtime.createProbe({
      topicId: topic.topicId, predictionId,
      objective: input.objective || `研究问题：${prediction.question}\n目标期限：${prediction.targetAt}\n结果判定：${prediction.resolutionRule}`,
      evidence: evidence.map(({ evidenceId, title, text, url }) => ({ evidenceId, title, text, ...(url ? { url } : {}) })),
    }, { idempotencyKey: options.idempotencyKey, operationHash, agentSpec: resolvedAgent,
      predictionVersion: prediction.version, kind: 'prediction-research', evidenceRecords: evidence })
  }

  return {
    metadata: store.metadata,
    config: () => ({ stage: 'M1', modelMode: runtime?.capabilities.modelMode || 'mock',
      modelRef: runtime?.capabilities.modelRef || null,
      capabilities: { predictionTypes: ['binary'], multiplePredictions: true, roleVersions: true,
        research: Boolean(runtime), supervisor: false, forecastPublishing: false, graphMemory: false, watchPlans: false },
      limits: { evidencePerRun: 12, evidenceCharacters: 4000, maxConcurrent: 4 } }),
    createTopic: (...args) => store.createTopic(...args),
    listTopics: () => store.listTopics(), getTopic: requireTopic,
    updateTopic: (...args) => store.updateTopic(...args),
    createPrediction: (topicId, input, options) => decorated(store.createPrediction(topicId, input, options)),
    getPrediction: (id, options) => decorated(requirePrediction(id, options)),
    listPredictions: (options = {}) => { if (options.topicId) requireTopic(options.topicId); return store.listPredictions(options).map(decorated) },
    updatePrediction: (id, patch, options) => decorated(store.updatePrediction(id, patch, options)),
    listAgents: () => store.listAgentSpecs(),
    getAgent(id, options) {
      const agent = store.getAgentSpec(id, options)
      if (!agent) throw domainFailure('AGENT_NOT_FOUND', '找不到此研究员版本。', 404)
      return agent
    },
    saveAgent: (...args) => store.saveAgentSpec(...args),
    deleteAgent(agentSpecId, input) {
      identifier(agentSpecId, 'agentSpecId')
      // Return a committed tombstone before consulting mutable busy state so retries remain idempotent.
      if (store.getAgentDeletion(agentSpecId)) return store.deleteAgentSpec(agentSpecId, input)
      const activeRuntime = (runtime?.listRuns() || []).some(run => !['completed', 'failed', 'cancelled'].includes(run.status) && run.agent?.agentSpecId === agentSpecId)
      if (activeRuntime || isAgentInUse(agentSpecId)) throw domainFailure('AGENT_IN_USE', '研究员正在被调查任务使用，请等待任务结束或停止后再删除。', 409)
      return store.deleteAgentSpec(agentSpecId, input)
    },
    tools: () => ({ tools: getToolCatalog(), plannedTools: getPlannedToolCatalog(), skills: getSkillCatalog() }),
    addEvidence: (...args) => store.addEvidence(...args), listEvidence: (options) => store.listEvidence(options),
    listLearning: () => store.listLearningEntries(),
    listRuns: (id) => { requirePrediction(id); return runsFor(id) }, createRun,
    runEvents(runId) {
      if (!runtime) throw domainFailure('RUNTIME_DISABLED', '研究引擎未启用。', 503)
      runtime.getRun(runId)
      return runtime.listEvents({ runId, limit: 1000 })
    },
    async importLegacy() {
      if (!world) throw domainFailure('LEGACY_UNAVAILABLE', '当前服务没有可导入的旧案例。', 409)
      const snapshot = await world.get()
      const result = store.importLegacy({ snapshot, sourceHash: digest(snapshot) })
      // Archive originals stay private; only domain records and counts enter the UI.
      return { topic: result.topic, predictions: result.predictions, duplicate: result.duplicate,
        sourceHash: result.sourceHash, importedAt: result.importedAt, archiveRecords: result.mappings.length }
    },
    close: () => store.close(),
  }
}
