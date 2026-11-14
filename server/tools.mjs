export const toolCatalog = [
  { id: 'search_evidence', name: '检索档案', description: '从截至当前回放时点的档案按主题查找证据。' },
  { id: 'verify_sources', name: '核对出处', description: '逐项检查证据编号、披露时间和原始来源。' },
  { id: 'map_exposure', name: '追踪公司敞口', description: '查询政策和产品在公司之间的映射。' },
  { id: 'read_factors', name: '读取共享状态', description: '读取当前事实快照及每个因子的出处。' },
  { id: 'compare_charges', name: '比较财务计提', description: '按公司与财季读取预计上限和已披露计提。' },
  { id: 'market_availability', name: '检查行情覆盖', description: '校验基准及行情标签可用性。' },
  { id: 'read_memory', name: '读取验证记忆', description: '只读取截点前已揭晓的历史预测和评分。' },
  { id: 'roll_scenario', name: '推演情景', description: '从共享快照推演指定政策假设，保留真实观察。' },
  { id: 'score_forecast', name: '评分并学习', description: '给已揭晓的二元预测计算 Brier 分数。' },
]

const catalogById = Object.fromEntries(toolCatalog.map((tool) => [tool.id, tool]))
const sourceIds = (items) => items.map((item) => item.id)

function scenarioFrom(context) {
  const { branch, companies } = context
  const amd = companies.find((company) => company.ticker === 'AMD')
  const confirmed = amd.sourceIds.includes('amd-8k')
  const scope = confirmed ? 'confirmed' : branch.id === 'broad' ? 'assumed' : 'unresolved'
  const substitution = scope !== 'unresolved' ? 'constrained' : branch.id === 'narrow' ? 'conditional' : 'unknown'
  const transitions = [
    {
      step: 1, variable: 'amdLicenseExposure', from: confirmed ? 'confirmed' : 'unresolved', to: scope,
      basis: confirmed ? 'observed' : scope === 'assumed' ? 'assumption' : 'unresolved',
    },
    {
      step: 2, variable: 'substitutionCapacity', from: 'unknown', to: substitution, basis: 'scenario',
    },
  ]
  const substitutionPath = {
    label: '替代需求', direction: 'up',
    detail: '如果未受限产品满足客户要求，订单可能转移。产品和地区范围需要核验。',
  }
  const jointPath = {
    label: '共同敞口',
    direction: substitution === 'constrained' ? 'down' : 'neutral',
    detail: confirmed
      ? 'MI308 已有公司披露，两款产品都受许可约束。'
      : scope === 'assumed'
        ? '情景假设同类产品也受限，替代空间收窄。仍需公开材料确认 AMD 的具体产品。'
        : '如果许可也覆盖同类产品，替代空间收窄。需后续公开材料确认 AMD 的具体产品。',
  }
  const paths = [
    { label: '直接敞口', direction: 'down', detail: '许可门槛提高 → H20 出货受约束 → 库存与采购义务承压。' },
    substitution === 'conditional' ? substitutionPath : jointPath,
    { label: '市场定价', direction: 'neutral', detail: '需要可用行情与行业基准判断价格是否已反应，当前未估计股价方向。' },
  ]
  return {
    paths, transitions,
    sourceIds: [...new Set(companies.flatMap((company) => company.sourceIds))],
    message: `从「${branch.label}」推演两步。先判断 AMD 的许可敞口，再检查可替代供给。`,
  }
}

const operations = {
  search_evidence(context, { topic }) {
    const evidence = context.evidence.filter((item) => item.topics.includes(topic))
    return { evidence, sourceIds: sourceIds(evidence), message: `找到 ${evidence.length} 条「${topic}」档案。` }
  },
  verify_sources(context, { ids }) {
    const visible = context.evidence.filter((item) => ids.includes(item.id))
    const missing = ids.filter((id) => !visible.some((item) => item.id === id))
    return { visible, missing, sourceIds: sourceIds(visible), message: `核对 ${visible.length} 条已公开出处。${missing.length ? `另有 ${missing.length} 条超出可见范围或无法验证。` : ''}` }
  },
  map_exposure(context) {
    const edges = context.companies.map(({ ticker, exposure, sourceIds }) => ({ factor: 'policy', ticker, exposure, sourceIds }))
    return { edges, sourceIds: [...new Set(edges.flatMap((edge) => edge.sourceIds))], message: `核对了共享许可状态到 ${edges.length} 家公司的产品敞口。` }
  },
  read_factors(context) {
    return { factors: context.factors, sourceIds: [...new Set(context.factors.flatMap((factor) => factor.sourceIds))], message: '读取出口许可、替代供给、公司敞口、计提及市场预期。' }
  },
  compare_charges(context) {
    const evidence = context.evidence.filter((item) => item.topics.includes('charge'))
    return { evidence, sourceIds: sourceIds(evidence), message: '按公告区分预计上限与实际计提。' }
  },
  market_availability() {
    return { available: false, sourceIds: [], message: '本案例未接入带时间戳的个股和基准行情，股价预测保持空缺。' }
  },
  read_memory(context) {
    const { resolved, adjustment, history } = context.learning
    return { resolved, adjustment, history, sourceIds: [], message: `读取 ${resolved} 条已结算预测。` }
  },
  roll_scenario(context) {
    return scenarioFrom(context)
  },
  score_forecast(_context, { probability, value }) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1 || ![0, 1].includes(value)) {
      throw new TypeError('结算需要合法的二元预测及事实标签。')
    }
    return { brier: (probability - value) ** 2, sourceIds: [], message: '按已封存概率与实际标签计算 Brier 分数。' }
  },
}

export function createToolRegistry(context, trace, onEvent) {
  function authorize(agent, id) {
    if (!Object.hasOwn(catalogById, id) || !agent.tools.includes(id)) {
      throw new Error(`角色 ${agent.id} 没有 ${id} 权限。`)
    }
  }

  function execute(agent, id, args = {}) {
    const result = operations[id](context, args)
    trace(agent.id, 'tool', 'tool', result.message, id, result.sourceIds)
    return result
  }

  return {
    call(agent, id, args) {
      authorize(agent, id)
      return execute(agent, id, args)
    },
    batch(agent, calls, taskId, label) {
      for (const [id] of calls) authorize(agent, id)
      const task = { type: 'task', agentId: agent.id, taskId, label }
      onEvent?.({ ...task, status: 'start' })
      const results = calls.map(([id, args]) => execute(agent, id, args))
      const sourceIds = [...new Set(results.flatMap((result) => result.sourceIds))]
      onEvent?.({
        ...task,
        status: 'complete',
        message: results.map((result) => result.message).join(''),
        shortMessage: taskId === 'market-lookup' ? '行情覆盖已检查'
          : sourceIds.length ? `已核对 ${sourceIds.length} 条依据` : '检查完成',
        sourceIds,
      })
      return results
    },
  }
}
