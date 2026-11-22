export const DEFAULT_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_MODEL_NAME = 'deepseek-flash'
export const MODEL_CONNECTION_PRESETS = Object.freeze([
  Object.freeze({ id: 'official', label: 'DeepSeek 官方', url: DEFAULT_CHAT_COMPLETIONS_URL, model: DEFAULT_MODEL_NAME, protocol: 'deepseek' }),
  Object.freeze({ id: 'school', label: 'PolyU GenAI', url: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model: 'DeepSeek-V4-Flash', protocol: 'openai' }),
])

const configurationError = (message) => Object.assign(new Error(message), { code: 'MODEL_CONFIG' })
function httpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//iu.test(value.trim()) || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value) || /\s/u.test(value.trim()) || value.includes('\\')) {
    throw configurationError('模型地址必须是有效的完整 HTTP(S) 地址。')
  }
  let parsed
  try { parsed = new URL(value.trim()) } catch { throw configurationError('模型地址必须是有效的完整 HTTP(S) 地址。') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.includes('?') || parsed.href.includes('#')) {
    throw configurationError('模型地址必须使用 HTTP(S)，且不能包含账号、查询参数或片段。')
  }
  return parsed
}
const inferredProtocol = (url) => url.hostname === 'api.deepseek.com' ? 'deepseek' : 'openai'

/** Explicit completion URLs take priority; only legacy base URLs receive an appended path. */
export function resolveModelEndpoints(env = process.env) {
  const endpoint = env.WORLD_CHAT_COMPLETIONS_URL !== undefined
    ? httpUrl(env.WORLD_CHAT_COMPLETIONS_URL)
    : httpUrl(`${httpUrl(env.WORLD_BASE_URL || 'https://api.deepseek.com').href.replace(/\/+$/, '')}/chat/completions`)
  // Replace only the terminal operation, retaining every slash in the gateway prefix.
  const models = new URL(endpoint.href)
  models.pathname = /\/chat\/completions\/?$/u.test(endpoint.pathname)
    ? endpoint.pathname.replace(/chat\/completions\/?$/u, 'models')
    : `${endpoint.pathname.slice(0, endpoint.pathname.lastIndexOf('/') + 1)}models`
  return { chatCompletionsUrl: endpoint.href, modelsUrl: models.href,
    protocol: env.WORLD_MODEL_PROTOCOL || inferredProtocol(endpoint) }
}

/** Validate public connection settings without accepting or retaining credentials. */
export function validateModelConnection({ url, model } = {}) {
  const endpoint = httpUrl(url)
  if (typeof model !== 'string' || !model.trim() || model.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) throw configurationError('请输入有效的模型名称。')
  return { url: endpoint.href, model: model.trim(), protocol: inferredProtocol(endpoint) }
}
