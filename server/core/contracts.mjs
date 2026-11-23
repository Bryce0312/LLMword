import Ajv from 'ajv'

const ajv = new Ajv({ strict: true, allErrors: true })
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,120}$' }
const probeSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    topicId: identifier, predictionId: identifier,
    objective: { type: 'string', minLength: 1, maxLength: 8000 },
    evidence: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          evidenceId: identifier,
          title: { type: 'string', minLength: 1, maxLength: 240 },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
          url: { type: 'string', maxLength: 2000 },
        },
        required: ['evidenceId', 'title', 'text'],
      },
    },
  },
  required: ['objective', 'evidence'],
}
const validateProbe = ajv.compile(probeSchema)

export function runtimeFailure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status, retryable: false })
}

export function parseProbe(input) {
  if (!validateProbe(input)) {
    throw runtimeFailure('INVALID_PROBE', '请输入调查目标和一至十二份带编号、标题、正文的材料。')
  }
  if (!input.objective.trim() || input.evidence.some((item) => !item.title.trim() || !item.text.trim())) {
    throw runtimeFailure('INVALID_PROBE', '目标和资料正文不能只有空白。')
  }
  if (new Set(input.evidence.map((item) => item.evidenceId)).size !== input.evidence.length) {
    throw runtimeFailure('DUPLICATE_EVIDENCE', '本轮材料编号不能重复。')
  }
  for (const item of input.evidence) {
    if (!item.url) continue
    let url
    try { url = new URL(item.url) } catch { throw runtimeFailure('INVALID_SOURCE_URL', '材料链接必须是有效的 HTTP(S) 地址。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw runtimeFailure('INVALID_SOURCE_URL', '材料链接必须是无账号信息的 HTTP(S) 地址。')
    }
  }
  return structuredClone({ topicId: 'topic_runtime_probe', predictionId: 'prediction_runtime_probe', ...input })
}
