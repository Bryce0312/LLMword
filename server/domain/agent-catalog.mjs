import Ajv from 'ajv'
import { domainFailure, identifier, json } from './contracts.mjs'

export const PROVIDED_TOOL_IDS = Object.freeze(['list_provided_sources', 'read_evidence'])
const DEFAULT_LIMITS = Object.freeze({ maxModelRequests: 8, maxToolCalls: 6, maxTotalTokens: 16000, maxTokens: 2048, timeoutMs: 60000, maxRetries: 2 })
const evidenceIds = { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }
const resultSchema = {
  type: 'object', properties: {
    status: { enum: ['ok', 'partial', 'error'] }, data: {}, evidenceIds,
    summary: { type: 'string' }, observedAt: { type: 'string' },
    error: { type: ['object', 'null'] }, usage: { type: ['object', 'null'] },
  }, required: ['status', 'data', 'evidenceIds', 'summary', 'observedAt', 'error', 'usage'],
}
const tools = [
  { toolId: 'list_provided_sources', version: 1, name: '列出已提供材料',
    description: '列出当前运行实际提供的材料编号和标题；不搜索外部网站。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { toolId: 'read_evidence', version: 1, name: '读取材料原文',
    description: '读取当前运行内指定 evidenceId 的材料，不能跨运行读取。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { evidenceId: { type: 'string', minLength: 1 } }, required: ['evidenceId'] } },
].map((tool) => ({ ...tool, availability: 'available', access: 'read', sourceScope: ['provided'], timeoutMs: 60000, costCategory: 'local', resultSchema }))

const roles = [
  ['official', '官方资料研究员', '以原始公告、正式文件和指定结果来源核查事实。区分正式发布、草案与二手转述；缺少原文时说明。', ['search_official']],
  ['timeline', '新闻时间线研究员', '按材料明确的发布时间排列事件，区分首发、更正与转载。时间不明保留缺口，不把转载数量当独立证据。', ['search_news', 'deduplicate_events']],
  ['industry', '行业与专业研究员', '检查技术、行业和制度条件。说明判断的适用范围、必要条件及专业资料缺口，避免把行业经验当作已核实事实。', ['search_domain']],
  ['people', '人物与组织研究员', '核对人物身份、履历、组织职责及利益关系。区分同名对象、正式任命与传闻，关系必须有具体来源。', ['search_entities']],
  ['statistics', '统计与指标研究员', '核对指标口径、单位、样本和时段。只报告能够复核的数字；计算工具尚未接入时不要宣称执行过计算，缺数据须说明。', ['read_dataset', 'calculate']],
  ['market', '预测市场研究员', '先区分现货价格、预测市场报价与本系统事件概率。首次建立BTC/ETH涨跌题时优先用get_market_quote取得本轮对应资产的现价快照，报告须引用该快照并写明交易对、USD单位和系统观察时间；工具失败或只取得另一资产报价时明确基准缺口。后续检查沿用已固定的原始基准，不把新现价改写成旧基准。再核对目标时点、结果判定规则及公开材料。无合约盘口时不编造盘口概率、价差或流动性，也不把现价涨跌直接换算为Yes概率。', ['read_contract', 'read_market_quotes']],
  ['social', '社群与舆情研究员', '在授权材料范围内识别社群线索、传播路径和样本偏差。传闻只作待核验线索；不能据声量推断事件必然发生。', ['search_social']],
  ['analogy', '历史类比研究员', '比较历史事件的相似条件、差异和失败反例，基准率须说明样本来源。不能用已知后续结果回填历史判断。', ['search_history', 'read_memory']],
  ['graph', '关系图研究员', '从材料整理实体、事实关系和影响假设，保留来源、时间、条件与反例。unknown 不表示零相关；没有图处理器时只提建议，不宣称已写入图。', ['query_graph', 'propose_graph_patch']],
  ['verification', '反证与核验研究员', '优先寻找与关键主张矛盾的材料，核验出处、时间和来源独立性。证据不足可以保留异议；团队一致不等于事实正确。', ['search_counterevidence', 'verify_sources']],
]
const skills = roles.map(([roleId, name, instructions]) => ({
  skillId: `method_${roleId}`, version: 1, name: `${name}调查方法`, instructions,
  kind: 'method', executable: false,
}))
const agents = roles.map(([agentSpecId, name, instructions, plannedTools]) => ({
  agentSpecId, specVersion: 1, name,
  description: '可分析本轮提供的材料；专用外部渠道或处理器尚待接入。',
  instructions, skillRefs: [{ skillId: `method_${agentSpecId}`, version: 1 }],
  allowedTools: [...PROVIDED_TOOL_IDS], extensionSlots: [null, null], modelRef: null,
  limits: { ...DEFAULT_LIMITS }, plannedTools, origin: 'builtin', availability: 'partial',
}))
const plannedTools = [...new Set(roles.flatMap((role) => role[3]))].map((toolId) => ({
  toolId, version: null, name: toolId, availability: 'planned', executable: false,
  description: '目标能力，尚无可执行处理器；不能加入本次工具许可或扩展槽。',
}))

/** These are metadata. Per-run handlers remain owned by the tool gateway. */
export const getToolCatalog = () => structuredClone(tools)
export const getPlannedToolCatalog = () => structuredClone(plannedTools)
export const getSkillCatalog = () => structuredClone(skills)
export const getAgentCatalog = () => structuredClone(agents)

const ajv = new Ajv({ strict: true, allErrors: true })
const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,120}$' }
const limitsSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, { type: 'integer', minimum: key === 'maxRetries' ? 0 : 1, maximum: key === 'maxRetries' ? 2 : 2147483647 }])),
}
const validate = ajv.compile({
  type: 'object', properties: {
    agentSpecId: id, specVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 }, instructions: { type: 'string', minLength: 1, maxLength: 12000 },
    skillRefs: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { skillId: id, version: { type: 'integer', minimum: 1 } }, required: ['skillId', 'version'] } },
    allowedTools: { type: 'array', maxItems: 64, uniqueItems: true, items: id },
    extensionSlots: { type: 'array', minItems: 2, maxItems: 2, items: { anyOf: [id, { type: 'null' }] } },
    modelRef: { type: ['string', 'null'], maxLength: 240 }, limits: limitsSchema,
  },
})

/** Normalize one immutable role version; storage owns optimistic concurrency. */
export function normalizeAgentSpec(input, { previous, registeredToolIds = PROVIDED_TOOL_IDS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw domainFailure('INVALID_AGENT_SPEC', '角色定义必须是对象。')
  input = JSON.parse(json(input))
  if (!validate(input)) throw domainFailure('INVALID_AGENT_SPEC', '角色名称、方法、工具或预算格式无效。', 400,
    [...new Set(validate.errors.map((error) => error.instancePath.slice(1) || 'input'))])
  const agentSpecId = identifier(input.agentSpecId ?? previous?.agentSpecId, 'agentSpecId')
  if (previous && previous.agentSpecId !== agentSpecId) throw domainFailure('AGENT_ID_IMMUTABLE', '编辑版本不能改变角色编号。', 409)
  const builtin = agents.find((agent) => agent.agentSpecId === agentSpecId)
  const base = previous ?? builtin ?? {
    agentSpecId, name: '', description: '', instructions: '', skillRefs: [], allowedTools: [...PROVIDED_TOOL_IDS],
    extensionSlots: [null, null], modelRef: null, limits: { ...DEFAULT_LIMITS }, plannedTools: [], origin: 'custom',
  }
  const fields = ['name', 'description', 'instructions', 'skillRefs', 'allowedTools', 'extensionSlots', 'modelRef']
  const spec = structuredClone({ ...base, ...Object.fromEntries(fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    agentSpecId, specVersion: previous ? previous.specVersion + 1 : 1,
    limits: { ...DEFAULT_LIMITS, ...base.limits, ...input.limits } })
  spec.name = spec.name.trim()
  spec.instructions = spec.instructions.trim()
  if (!spec.name || !spec.instructions) throw domainFailure('INVALID_AGENT_SPEC', '角色名称和调查方法不能为空。', 400, ['name', 'instructions'])
  if (spec.modelRef !== null && !spec.modelRef.trim()) throw domainFailure('INVALID_AGENT_SPEC', '模型引用须为非空名称或 null。', 400, ['modelRef'])
  const selectedSlots = spec.extensionSlots.filter((toolId) => toolId !== null)
  if (new Set(selectedSlots).size !== selectedSlots.length) throw domainFailure('DUPLICATE_TOOL_SLOT', '两个扩展槽不能重复引用同一个工具。')
  spec.allowedTools = [...new Set([...spec.allowedTools, ...selectedSlots])]
  const registered = new Set(registeredToolIds)
  const forbidden = spec.allowedTools.filter((toolId) => !registered.has(toolId))
  if (forbidden.length) throw domainFailure('TOOL_NOT_REGISTERED', '工具许可和扩展槽只能引用实际注册的处理器。', 400, forbidden)
  const skillKeys = spec.skillRefs.map(({ skillId, version }) => `${skillId}:${version}`)
  const knownSkills = new Set(skills.map(({ skillId, version }) => `${skillId}:${version}`))
  if (new Set(skillKeys).size !== skillKeys.length || skillKeys.some((key) => !knownSkills.has(key))) {
    throw domainFailure('SKILL_NOT_REGISTERED', '调查方法引用必须是目录中已登记且不重复的版本。', 400, ['skillRefs'])
  }
  // Availability is a capability statement, never a user-granted permission.
  spec.plannedTools = [...(builtin?.plannedTools ?? [])]
  spec.origin = builtin ? 'builtin' : 'custom'
  spec.availability = spec.plannedTools.length ? 'partial' : 'provided-materials'
  delete spec.createdAt
  return spec
}
