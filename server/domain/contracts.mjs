import { createHash } from 'node:crypto'
import Ajv from 'ajv'

const ajv = new Ajv({ strict: true, allErrors: true })
const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,120}$' }
const short = { type: 'string', maxLength: 240 }
const long = { type: 'string', maxLength: 12000 }
const nullableDate = { type: ['string', 'null'], maxLength: 80 }
const sourceSchema = {
  type: ['object', 'null'], additionalProperties: false,
  properties: { kind: { type: 'string', maxLength: 80 }, url: { type: 'string', maxLength: 2000 } },
}
const predictionFields = {
  type: { enum: ['binary', 'price_direction', 'categorical', 'numeric', 'ranked_list'] },
  question: { type: 'string', maxLength: 2000 },
  object: { type: 'string', maxLength: 1000 },
  options: {
    type: 'array', maxItems: 30, items: {
      type: 'object', additionalProperties: false,
      properties: { optionId: id, label: { type: 'string', minLength: 1, maxLength: 240 } },
      required: ['optionId', 'label'],
    },
  },
  candidateUniverseRule: { type: 'string', maxLength: 2000 },
  timezone: { type: 'string', maxLength: 80 },
  forecastClosesAt: nullableDate, targetAt: nullableDate,
  resolutionRuleVersion: { type: 'integer', minimum: 1 },
  resolutionRule: { type: 'string', maxLength: 4000 },
  resolutionSource: sourceSchema,
  unresolvablePolicy: { type: 'string', maxLength: 1000 },
  status: { enum: ['draft', 'ready', 'active', 'paused', 'closed', 'resolved', 'void'] },
}
const validatePrediction = ajv.compile({ type: 'object', properties: predictionFields })
const topicFields = {
  title: short, background: long, sourceMode: { enum: ['provided', 'live', 'replay'] },
}
const validateTopic = ajv.compile({ type: 'object', properties: topicFields })
const evidenceFields = {
  title: { type: 'string', minLength: 1, maxLength: 240 }, text: { type: 'string', minLength: 1, maxLength: 4000 },
  url: { type: 'string', maxLength: 2000 }, source: short, publishedAt: nullableDate,
  predictionIds: { type: 'array', maxItems: 100, uniqueItems: true, items: id },
  sourceGroupId: { type: 'string', maxLength: 240 }, locator: { type: 'string', maxLength: 2000 },
  sourceMode: { enum: ['provided', 'live', 'replay'] }, archiveAsOf: nullableDate,
}
const validateEvidence = ajv.compile({ type: 'object', properties: evidenceFields, required: ['title', 'text'] })
const validateId = ajv.compile(id)

export function domainFailure(code, message, status = 400, fields) {
  return Object.assign(new Error(message), { code, status, retryable: false, ...(fields ? { fields } : {}) })
}

export function identifier(value, field = 'id') {
  if (!validateId(value)) throw domainFailure('INVALID_IDENTIFIER', `${field} 格式无效。`, 400, [field])
  return value
}

export function json(value) {
  try {
    const data = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error()
      return item
    })
    if (data === undefined) throw new Error()
    return data
  } catch {
    throw domainFailure('INVALID_JSON_VALUE', '资料必须是合法 JSON，数字必须有限。')
  }
}

export function digest(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
  }
  return createHash('sha256').update(JSON.stringify(sort(JSON.parse(json(value))))).digest('hex')
}

function parsedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw domainFailure('INVALID_INPUT', '请求必须是 JSON 对象。')
  return JSON.parse(json(value))
}

function checkSchema(validate, value, code) {
  if (!validate(value)) {
    const fields = [...new Set(validate.errors.map((error) => error.instancePath.slice(1).replaceAll('/', '.') || error.params.missingProperty || 'input'))]
    throw domainFailure(code, '字段格式不符合要求。', 400, fields)
  }
}

function pick(fields, input) {
  return Object.fromEntries(Object.keys(fields).filter((field) => input[field] !== undefined).map((field) => [field, input[field]]))
}

export function validDate(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second] = match
  const nominal = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
  return nominal.getUTCFullYear() === Number(year) && nominal.getUTCMonth() + 1 === Number(month) &&
    nominal.getUTCDate() === Number(day) && nominal.getUTCHours() === Number(hour) &&
    nominal.getUTCMinutes() === Number(minute) && nominal.getUTCSeconds() === Number(second) && Number.isFinite(Date.parse(value))
}

function checkedDate(value, field) {
  if (value !== null && value !== '' && !validDate(value)) throw domainFailure('INVALID_DATE', '日期须为带时区的有效 ISO 时间。', 400, [field])
}

export function validUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function normalizeTopic(input, { previous } = {}) {
  input = parsedRecord(input)
  checkSchema(validateTopic, input, 'INVALID_TOPIC')
  const topic = { title: '', background: '', sourceMode: 'provided', ...pick(topicFields, previous || {}), ...pick(topicFields, input) }
  topic.title = topic.title.trim()
  if (!topic.title) throw domainFailure('INVALID_TOPIC', '请输入关注主题。', 400, ['title'])
  return topic
}

export function normalizePrediction(input, { previous } = {}) {
  input = parsedRecord(input)
  if (input.type !== undefined && !['binary', 'price_direction'].includes(input.type)) {
    throw domainFailure('UNSUPPORTED_PREDICTION_TYPE', '当前支持是否发生和价格方向两类预测。', 400, ['type'])
  }
  if (input.status !== undefined && !['draft', 'ready'].includes(input.status)) {
    throw domainFailure('UNSUPPORTED_PREDICTION_STATUS', '当前编辑入口只能保存草稿或就绪题目，运行与结算状态须由专用动作产生。', 400, ['status'])
  }
  checkSchema(validatePrediction, input, 'INVALID_PREDICTION')
  const prediction = {
    type: 'binary', question: '', object: '', options: [], candidateUniverseRule: '',
    timezone: '', forecastClosesAt: null, targetAt: null, resolutionRuleVersion: 1,
    resolutionRule: '', resolutionSource: null, unresolvablePolicy: '', status: 'draft',
    ...pick(predictionFields, previous || {}), ...pick(predictionFields, input),
  }
  if (!['binary', 'price_direction'].includes(prediction.type)) {
    throw domainFailure('UNSUPPORTED_PREDICTION_TYPE', '当前支持是否发生和价格方向两类预测。', 400, ['type'])
  }
  if (!['draft', 'ready'].includes(prediction.status)) {
    throw domainFailure('UNSUPPORTED_PREDICTION_STATUS', '当前编辑入口只能保存草稿或就绪题目。', 400, ['status'])
  }
  prediction.question = prediction.question.trim()
  for (const field of ['forecastClosesAt', 'targetAt']) {
    checkedDate(prediction[field], field)
    if (prediction[field] === '') prediction[field] = null
  }
  if (prediction.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: prediction.timezone }).format() }
    catch { throw domainFailure('INVALID_TIMEZONE', '请选择有效时区。', 400, ['timezone']) }
  }
  if (prediction.resolutionSource?.url && !validUrl(prediction.resolutionSource.url)) {
    throw domainFailure('INVALID_SOURCE_URL', '结算来源必须是无账号信息的 HTTP(S) 链接。', 400, ['resolutionSource.url'])
  }
  if (new Set(prediction.options.map((option) => option.optionId)).size !== prediction.options.length ||
    prediction.options.some((option) => !option.label.trim())) {
    throw domainFailure('INVALID_OPTIONS', '候选编号须唯一，名称不能为空。', 400, ['options'])
  }
  if (prediction.options.length) {
    throw domainFailure('INVALID_OPTIONS', '此题型使用固定结果选项。', 400, ['options'])
  }
  const missingFields = []
  for (const field of ['question', 'timezone', 'forecastClosesAt', 'targetAt', 'resolutionRule', 'unresolvablePolicy']) {
    if (!prediction[field]?.trim()) missingFields.push(field)
  }
  if (!prediction.resolutionSource?.kind?.trim()) missingFields.push('resolutionSource.kind')
  if (!prediction.resolutionSource?.url?.trim()) missingFields.push('resolutionSource.url')
  if (prediction.forecastClosesAt && prediction.targetAt && Date.parse(prediction.forecastClosesAt) > Date.parse(prediction.targetAt)) {
    throw domainFailure('INVALID_WINDOW', '停止发布时间须不晚于目标时间。', 400, ['forecastClosesAt', 'targetAt'])
  }
  prediction.validation = { ready: !missingFields.length, missingFields }
  if (prediction.status !== 'draft' && missingFields.length) {
    throw domainFailure('PREDICTION_INCOMPLETE', '预测题仍缺少可执行或可结算字段。', 400, missingFields)
  }
  return prediction
}

export function normalizeEvidence(input, { receivedAt } = {}) {
  input = parsedRecord(input)
  checkSchema(validateEvidence, input, 'INVALID_EVIDENCE')
  const evidence = {
    url: '', source: '', publishedAt: null, predictionIds: [], sourceGroupId: '', locator: '',
    sourceMode: 'provided', archiveAsOf: null, ...pick(evidenceFields, input),
  }
  if (!evidence.title.trim() || !evidence.text.trim()) throw domainFailure('INVALID_EVIDENCE', '资料标题和正文不能为空。')
  if (evidence.url && !validUrl(evidence.url)) throw domainFailure('INVALID_SOURCE_URL', '资料来源必须是无账号信息的 HTTP(S) 链接。')
  checkedDate(evidence.publishedAt, 'publishedAt')
  checkedDate(evidence.archiveAsOf, 'archiveAsOf')
  evidence.publishedAt ||= null
  evidence.archiveAsOf ||= null
  evidence.firstSeenAt = receivedAt
  evidence.retrievedAt = receivedAt
  evidence.contentHash = `sha256:${createHash('sha256').update(evidence.text).digest('hex')}`
  evidence.scoringEligible = evidence.sourceMode !== 'replay'
  return evidence
}
