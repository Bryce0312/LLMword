import { createHash } from 'node:crypto'
import { resolveModelEndpoints } from './model-endpoint.mjs'

function safeTokenUsage(value) {
  if (!value || !Number.isSafeInteger(value.total_tokens) || value.total_tokens < 0) return undefined
  return Object.fromEntries(['total_tokens', 'prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']
    .filter((key) => Number.isSafeInteger(value[key]) && value[key] >= 0).map((key) => [key, value[key]]))
}

export class RuntimeError extends Error {
  constructor(code, message, { retryable = false, status, retryAfterMs, actionRequired = false, usage } = {}) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
    this.retryable = retryable
    this.status = status
    this.httpStatus = status
    this.retryAfterMs = retryAfterMs
    this.actionRequired = actionRequired
    const tokens = safeTokenUsage(usage)
    if (tokens) this.usage = tokens
  }
}

export function checkCancelled(signal) {
  if (signal?.aborted) throw new RuntimeError('CANCELLED', '运行已取消。')
}

// Injected handlers may ignore their AbortSignal. Race their response as well.
export async function abortable(operation, signal) {
  checkCancelled(signal)
  if (!signal) return await operation()
  let listener
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(new RuntimeError('CANCELLED', '运行已取消。'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => { checkCancelled(signal); return operation() }), interrupted])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Check a saved credential with the model list endpoint: no generation tokens; the body is consumed but never used. */
export async function verifyModelCredentials(env = process.env, request = fetch, timeoutMs = 8000) {
  const key = env.WORLD_API_KEY
  if (!key) throw new RuntimeError('MODEL_CONFIG', '需要配置服务端凭据。')
  let endpoints
  try { endpoints = resolveModelEndpoints(env) } catch (error) { throw new RuntimeError('MODEL_CONFIG', error.message) }
  const response = await request(endpoints.modelsUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  // Consume and discard the body so the connection can be released. Its content is never
  // parsed, logged or returned; only the HTTP status decides the result.
  try { await response.text?.() } catch {}
  return { connected: response.ok, status: response.status }
}

export function createModelProvider(env = process.env, request = fetch) {
  const key = env.WORLD_API_KEY
  const model = env.WORLD_MODEL_NAME
  if (!key || !model) throw new RuntimeError('MODEL_CONFIG', '需要配置模型名称和服务端凭据。')
  let endpoints
  try { endpoints = resolveModelEndpoints(env) } catch (error) { throw new RuntimeError('MODEL_CONFIG', error.message) }
  const timeoutMs = Number(env.WORLD_MODEL_TIMEOUT_MS ?? 60000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RuntimeError('MODEL_CONFIG', '模型超时须为有效正整数毫秒。')
  const endpoint = endpoints.chatCompletionsUrl
  const protocol = endpoints.protocol
  if (!['deepseek', 'openai'].includes(protocol)) throw new RuntimeError('MODEL_CONFIG', '模型协议须为 deepseek 或 openai。')
  const thinking = env.WORLD_MODEL_THINKING ?? 'disabled'
  if (!['enabled', 'disabled'].includes(thinking)) throw new RuntimeError('MODEL_CONFIG', '思考开关须为 enabled 或 disabled。')
  const reasoningEffort = env.WORLD_MODEL_REASONING_EFFORT || (thinking === 'enabled' ? 'high' : null)
  if (reasoningEffort !== null && !['low', 'high', 'max'].includes(reasoningEffort)) throw new RuntimeError('MODEL_CONFIG', '思考强度须为 low、high 或 max。')
  if (protocol !== 'deepseek' && (thinking === 'enabled' || reasoningEffort !== null)) throw new RuntimeError('MODEL_CONFIG', '当前思考参数仅用于 DeepSeek 协议；其他兼容服务默认不发送私有参数。')
  if (thinking === 'disabled' && reasoningEffort !== null) throw new RuntimeError('MODEL_CONFIG', '启用思考后才能设置思考强度。')
  const configuredOutput = env.WORLD_MODEL_MAX_OUTPUT_TOKENS === undefined ? null : Number(env.WORLD_MODEL_MAX_OUTPUT_TOKENS)
  if (configuredOutput !== null && (!Number.isInteger(configuredOutput) || configuredOutput < 1 || configuredOutput > 393216)) throw new RuntimeError('MODEL_CONFIG', '模型输出上限须为 1 至 393216 的整数。')
  const settings = Object.freeze({ protocol, thinking: protocol === 'deepseek' ? thinking : null,
    reasoningEffort, maxOutputTokens: configuredOutput ?? 2048, outputCapConfigured: configuredOutput !== null, timeoutMs })

  return {
    model,
    settings,
    configurationId: createHash('sha256').update(JSON.stringify({ model, endpoint, ...settings })).digest('hex'),
    async complete({ messages, tools, signal, maxTokens = settings.maxOutputTokens, reasoningEffortOverride, thinkingOverride }) {
      if (thinkingOverride !== undefined && (protocol !== 'deepseek' || thinkingOverride !== 'disabled')) throw new RuntimeError('MODEL_CONFIG', '本次思考覆盖仅允许 DeepSeek 禁用思考。')
      if (reasoningEffortOverride !== undefined && (protocol !== 'deepseek' || thinking !== 'enabled' || !['low', 'high', 'max'].includes(reasoningEffortOverride))) throw new RuntimeError('MODEL_CONFIG', '本次思考配置无效。')
      const callThinking = thinkingOverride ?? thinking
      const effort = callThinking === 'enabled' ? reasoningEffortOverride ?? reasoningEffort : null
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 393216) throw new RuntimeError('MODEL_CONFIG', '输出 token 上限无效。')
      const outputTokens = configuredOutput === null ? maxTokens : Math.min(maxTokens, configuredOutput)
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        return await abortable(async () => {
          const response = await request(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            signal: combined,
            body: JSON.stringify({
              // Entire assistant protocol messages, including reasoning_content,
              // are replayed verbatim. They remain private checkpoints, not UI data.
              model, messages: structuredClone(messages), tools,
              ...(protocol === 'deepseek' && callThinking === 'enabled' ? {} : { tool_choice: 'auto' }),
              ...(protocol === 'deepseek' ? { thinking: { type: callThinking }, ...(effort ? { reasoning_effort: effort } : {}) } : {}),
              max_tokens: outputTokens, stream: false,
            }),
          })
          if (!response.ok) {
            // Classify from status only. Upstream bodies may contain credentials,
            // account information or request details and must never be echoed.
            const status = response.status
            const hard = {
              402: ['MODEL_BALANCE_REQUIRED', '模型服务余额不足，请确认账户额度后手动重试。'],
              401: ['MODEL_AUTH_FAILED', '模型服务鉴权失败，请检查服务端凭据后手动重试。'],
              403: ['MODEL_ACCESS_DENIED', '模型服务拒绝访问，请检查凭据、模型权限或服务设置后手动重试。'],
            }[status]
            const [code, message] = hard || (status === 429
              ? ['MODEL_RATE_LIMITED', '模型服务请求过于频繁，请稍后重试。']
              : status === 408 || status >= 500
                ? ['MODEL_SERVICE_UNAVAILABLE', '模型服务暂时不可用，请稍后重试。']
                : ['MODEL_HTTP', `模型服务拒绝请求（HTTP ${status}），请检查请求或服务配置。`])
            const header = response.headers?.get('retry-after')
            const seconds = Number(header)
            const retryAfter = header && Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : undefined
            throw new RuntimeError(code, message, {
              status: response.status,
              retryable: !hard && (status === 408 || status === 429 || status >= 500),
              actionRequired: Boolean(hard),
              retryAfterMs: !hard && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 30000) : undefined,
            })
          }
          const payload = await response.json()
          const choice = payload.choices?.[0]
          const message = choice?.message
          if (!message || message.role !== 'assistant' || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
            throw new RuntimeError('MODEL_INCOMPLETE', '模型没有返回完整的工具动作或报告。', { usage: payload.usage })
          }
          if (message.tool_calls !== undefined && message.tool_calls !== null && (!Array.isArray(message.tool_calls) || !message.tool_calls.length)) {
            throw new RuntimeError('MODEL_PROTOCOL', '模型工具调用格式无效。', { usage: payload.usage })
          }
          if (choice.finish_reason === 'tool_calls' && !message.tool_calls?.length) {
            throw new RuntimeError('MODEL_PROTOCOL', '模型缺少工具调用。', { usage: payload.usage })
          }
          checkCancelled(combined)
          return { message: structuredClone(message), finishReason: choice.finish_reason, usage: payload.usage ?? null, model: payload.model ?? model }
        }, combined)
      } catch (error) {
        checkCancelled(signal)
        if (timeout.aborted) throw new RuntimeError('MODEL_TIMEOUT', '模型请求超时。', { retryable: true })
        if (error instanceof RuntimeError) throw error
        throw new RuntimeError('MODEL_NETWORK', '模型连接或响应读取失败。', { retryable: true })
      }
    },
  }
}
