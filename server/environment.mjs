import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { DEFAULT_MODEL_NAME, MODEL_CONNECTION_PRESETS, resolveModelEndpoints } from './runtime/model-endpoint.mjs'

const dataRoot = fileURLToPath(new URL('../.data/', import.meta.url))

/** Refuse to open a database that already contains runs from the opposite mode. */
export function assertEnvironmentRuns(environment, runs = []) {
  if (!['mock', 'live'].includes(environment)) return
  const modes = new Set(runs.map(run => run?.modelMode).filter(mode => mode === 'mock' || mode === 'live'))
  if (environment === 'mock' && modes.has('live')) throw new Error('模拟数据目录中存在真实运行记录。请改用 npm run start:live，或换一个空的模拟数据目录。')
  if (environment === 'live' && modes.has('mock')) throw new Error('真实数据目录中存在模拟运行记录。请改用 npm run start:mock，或换一个空的真实数据目录。')
}

/** Force one environment's defaults so a stale shell variable cannot mix mock and live data. */
export function configureEnvironment(env, name) {
  if (!['mock', 'live'].includes(name)) throw new Error('WORLD_ENV 必须是 mock 或 live')
  const next = { ...env, WORLD_ENV: name }
  const defaultDir = join(dataRoot, name)
  const otherDir = join(dataRoot, name === 'mock' ? 'live' : 'mock')
  const dataDir = next.WORLD_DATA_DIR ? resolve(next.WORLD_DATA_DIR) : defaultDir
  if (dataDir === resolve(dataRoot)) throw new Error('数据目录不能直接使用 .data 根目录，请指定 .data 下的独立子目录。')
  if (dataDir === resolve(otherDir) || dataDir.startsWith(resolve(otherDir) + sep)) throw new Error(`${name} 环境不能使用另一模式的数据目录。`)
  next.WORLD_DATA_DIR = dataDir
  next.WORLD_STATE_PATH = join(dataDir, 'world.json')
  if (name === 'mock') {
    if (next.WORLD_MODEL === 'openai') throw new Error('模拟环境不能使用真实模型配置，请改用 npm run start:live。')
    next.WORLD_MODEL = 'mock'
    next.PORT = next.PORT || '4173'
    next.WORLD_SEARCH_PROVIDER = 'fixture'
    next.WORLD_MOCK_PACING = next.WORLD_MOCK_PACING ?? '0'
    next.WORLD_MONITOR = 'off'
    delete next.WORLD_API_KEY
    delete next.WORLD_SEARCH_API_KEY
    delete next.WORLD_DOMAIN_PATH
    delete next.WORLD_COURSE_PATH
    delete next.WORLD_RUNTIME_PATH
    delete next.WORLD_MONITOR_PATH
    return next
  }
  if (!next.WORLD_API_KEY) delete next.WORLD_API_KEY
  next.WORLD_MODEL = 'openai'
  next.PORT = next.PORT || '4174'
  next.WORLD_SEARCH_PROVIDER = 'deepseek'
  const endpoint = resolveModelEndpoints(next)
  // Keep only explicit search credentials here. The gateway can reuse the current
  // official model key without freezing an automatically copied startup key.
  delete next.WORLD_DOMAIN_PATH
  delete next.WORLD_COURSE_PATH
  delete next.WORLD_RUNTIME_PATH
  delete next.WORLD_MONITOR_PATH
  next.WORLD_MODEL_NAME = next.WORLD_MODEL_NAME || MODEL_CONNECTION_PRESETS.find(item => item.url === endpoint.chatCompletionsUrl)?.model || DEFAULT_MODEL_NAME
  next.WORLD_BASE_URL = next.WORLD_BASE_URL || 'https://api.deepseek.com'
  next.WORLD_MODEL_PROTOCOL = next.WORLD_MODEL_PROTOCOL || endpoint.protocol
  next.WORLD_MODEL_THINKING = next.WORLD_MODEL_THINKING || (next.WORLD_MODEL_PROTOCOL === 'deepseek' ? 'enabled' : 'disabled')
  if (next.WORLD_MODEL_PROTOCOL === 'deepseek' && next.WORLD_MODEL_THINKING === 'enabled') next.WORLD_MODEL_REASONING_EFFORT = next.WORLD_MODEL_REASONING_EFFORT || 'high'
  next.WORLD_MODEL_MAX_OUTPUT_TOKENS = next.WORLD_MODEL_MAX_OUTPUT_TOKENS || '32768'
  next.WORLD_MODEL_TIMEOUT_MS = next.WORLD_MODEL_TIMEOUT_MS || '180000'
  return next
}
