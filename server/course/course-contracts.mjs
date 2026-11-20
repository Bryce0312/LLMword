import Ajv from 'ajv'
import { COURSE_ROLE_IDS } from './course-context.mjs'

const roles = COURSE_ROLE_IDS
const string = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength })
const ids = { type: 'array', uniqueItems: true, items: string(120), maxItems: 30 }
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })

export const definitions = {
  draft_and_delegate: ['第一步只整理题意和分工，不调查或预测。给待核验草稿及三位不同职责（含verification）的调查任务；来源、规则和基准交研究员实际取证。', object({
    question: string(1000), object: string(500), interpretation: string(1000),
    defaultAssumptions: { type: 'array', maxItems: 6, items: string(500) },
    assignments: { type: 'array', minItems: 3, maxItems: 3, items: object({ roleId: { enum: roles }, objective: string(2000), reason: string(500) }) },
  }, ['question', 'object', 'interpretation', 'assignments'])],
  normalize_prediction: ['规范二元题。preset须联网补全常见含义并明示假设，不因未写账号/阈值等细项拒绝；已有可读公开替代来源可作有限研究依据。strict锁已填条件。', object({
    question: string(), object: string(500), targetAt: string(80), forecastClosesAt: string(80), timezone: string(80),
    resolutionRule: string(4000), resolutionSourceUrl: string(2000), unresolvablePolicy: string(1000), watchQuery: string(128),
    interpretation: string(), defaultAssumptions: { type: 'array', maxItems: 8, items: string(1000) },
    sourceLimitations: { type: 'array', maxItems: 8, items: string(1000) },
  }, ['question', 'object', 'targetAt', 'forecastClosesAt', 'timezone', 'resolutionRule', 'resolutionSourceUrl', 'unresolvablePolicy', 'watchQuery'])],
  delegate_work: ['从十角色目录选本题需要的不同职责，初始三人含核验；局部更新两人。给任务与选择理由，不能每道题固定同队。', object({ assignments: { type: 'array', minItems: 2, maxItems: 3,
    items: object({ roleId: { enum: roles }, objective: string(3000), reason: string(1000) }) } })],
  triage_update: ['去重后的新正文分诊：普通增量local选相关+核验两人；重大/冲突team选本题团队三人；无关irrelevant不更新概率。', object({
    kind: { enum: ['local', 'team', 'irrelevant'] }, roleIds: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { enum: roles } }, reason: string(1500),
  })],
  request_followup: ['围绕实际报告中的具体争议，给一位相关研究员定向补查或答复。次数由本轮harness剩余预算决定，不编造争议，不重复全网研究。', object({ roleId: { enum: roles }, objective: string(3000), reason: string(1500), evidenceIds: ids })],
  propose_forecast: ['提交二元候选，发布由应用独立验证。已知结果请明确 outcomeKnown，不把结果伪装成预测。', object({
    probabilityYes: { type: 'number', minimum: 0, maximum: 1 }, summary: string(2000), evidenceIds: ids,
    evidenceAdequacy: { enum: ['adequate', 'limited'] }, dissent: { type: 'array', items: string(1000), maxItems: 10 },
    outcomeKnown: { type: 'boolean' }, outcome: { type: ['integer', 'null'], enum: [0, 1, null] },
    sourceLimitations: { type: 'array', maxItems: 12, items: string(1000) },
  }, ['probabilityYes', 'summary', 'evidenceIds', 'evidenceAdequacy', 'dissent', 'outcomeKnown', 'outcome'])],
  mark_insufficient: ['来源、题义或调查不足时停止，给可修改的缺口；不要编造 ready 或默认概率。', object({ message: string(2000), missingFields: { type: 'array', items: string(240), maxItems: 20 } })],
}

const ajv = new Ajv({ allErrors: true, strict: true })
export const validators = Object.fromEntries(Object.entries(definitions).map(([name, [, schema]]) => [name, ajv.compile(schema)]))
export const nativeTool = (name) => ({ type: 'function', function: { name, description: definitions[name][0], parameters: definitions[name][1] } })
