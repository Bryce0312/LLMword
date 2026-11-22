import test from 'node:test'
import assert from 'node:assert/strict'
import { configureEnvironment, assertEnvironmentRuns } from './environment.mjs'

const key = 'TEST_SESSION_KEY_NOT_REAL'

test('mock environment forces its own port, data file and fixture sources', () => {
  const config = configureEnvironment({ PORT: '9999', WORLD_STATE_PATH: 'elsewhere.json', WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_API_KEY: key, WORLD_COURSE_PATH: 'live.sqlite', WORLD_MONITOR: 'demo' }, 'mock')
  assert.equal(config.WORLD_ENV, 'mock')
  assert.equal(config.WORLD_MODEL, 'mock')
  assert.equal(config.PORT, '9999')
  assert.match(config.WORLD_STATE_PATH, /[\\/]mock[\\/]world\.json$/)
  assert.match(config.WORLD_DATA_DIR, /[\\/]mock$/)
  assert.equal(configureEnvironment({}, 'mock').PORT, '4173')
  assert.equal(config.WORLD_SEARCH_PROVIDER, 'fixture')
  assert.equal(config.WORLD_MONITOR, 'off')
  assert.equal(config.WORLD_COURSE_PATH, undefined)
  assert.equal(config.WORLD_API_KEY, undefined)
  assert.equal(config.WORLD_SEARCH_API_KEY, undefined)
})

test('mock environment refuses a real-model setting instead of silently mixing', () => {
  assert.throws(() => configureEnvironment({ WORLD_MODEL: 'openai' }, 'mock'), /模拟环境不能使用真实模型配置/)
})

test('live environment starts without a key so the browser can save one later', () => {
  const keyless = configureEnvironment({}, 'live')
  assert.equal(keyless.WORLD_ENV, 'live')
  assert.equal(keyless.WORLD_MODEL, 'openai')
  assert.equal(keyless.PORT, '4174')
  assert.equal(keyless.WORLD_API_KEY, undefined)
  assert.equal(keyless.WORLD_SEARCH_API_KEY, undefined)
  assert.equal(keyless.WORLD_SEARCH_PROVIDER, 'deepseek')
  assert.equal(keyless.WORLD_MODEL_NAME, 'deepseek-flash')
  const config = configureEnvironment({ WORLD_API_KEY: key, PORT: '9999', WORLD_STATE_PATH: 'elsewhere.json', WORLD_SEARCH_PROVIDER: 'fixture', WORLD_DOMAIN_PATH: 'mock.sqlite' }, 'live')
  assert.equal(config.WORLD_ENV, 'live')
  assert.equal(config.WORLD_MODEL, 'openai')
  assert.equal(config.PORT, '9999')
  assert.match(config.WORLD_STATE_PATH, /[\\/]live[\\/]world\.json$/)
  assert.match(config.WORLD_DATA_DIR, /[\\/]live$/)
  assert.equal(configureEnvironment({}, 'live').PORT, '4174')
  assert.equal(config.WORLD_SEARCH_PROVIDER, 'deepseek')
  assert.equal(config.WORLD_SEARCH_API_KEY, undefined)
  assert.equal(config.WORLD_DOMAIN_PATH, undefined)
  assert.equal(config.WORLD_MODEL_NAME, 'deepseek-flash')
  assert.equal(config.WORLD_BASE_URL, 'https://api.deepseek.com')
  assert.equal(config.WORLD_MODEL_PROTOCOL, 'deepseek')
  assert.equal(config.WORLD_MODEL_THINKING, 'enabled')
})

test('unknown environment names fail before any service starts', () => {
  assert.throws(() => configureEnvironment({}, 'auto'), /mock 或 live/)
})

test('a second instance can use its own port and data directory', () => {
  const config = configureEnvironment({ PORT: '5173', WORLD_DATA_DIR: 'instance-b' }, 'mock')
  assert.equal(config.PORT, '5173')
  assert.match(config.WORLD_STATE_PATH, /instance-b[\\/]world\.json$/)
})

test('a data directory cannot cross modes or fall back to the shared root', () => {
  assert.throws(() => configureEnvironment({ WORLD_DATA_DIR: '.data/live' }, 'mock'), /另一模式/)
  assert.throws(() => configureEnvironment({ WORLD_DATA_DIR: '.data/mock' }, 'live'), /另一模式/)
  assert.throws(() => configureEnvironment({ WORLD_DATA_DIR: '.data' }, 'mock'), /根目录/)
})

test('database guard refuses opposite-mode history but allows clean or legacy auto mode', () => {
  assert.throws(() => assertEnvironmentRuns('mock', [{ modelMode: 'live' }]), /真实运行记录/)
  assert.throws(() => assertEnvironmentRuns('live', [{ modelMode: 'mock' }]), /模拟运行记录/)
  assert.doesNotThrow(() => assertEnvironmentRuns('mock', [{ modelMode: 'mock' }, { status: 'completed' }]))
  assert.doesNotThrow(() => assertEnvironmentRuns('live', [{ modelMode: 'live' }]))
  assert.doesNotThrow(() => assertEnvironmentRuns('mock', []))
  assert.doesNotThrow(() => assertEnvironmentRuns('auto', [{ modelMode: 'live' }, { modelMode: 'mock' }]))
})


test('campus defaults use its exact endpoint and model without reusing its key for official search', () => {
  const url = 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions'
  const config = configureEnvironment({ WORLD_CHAT_COMPLETIONS_URL: url, WORLD_API_KEY: key }, 'live')
  assert.equal(config.WORLD_CHAT_COMPLETIONS_URL, url)
  assert.equal(config.WORLD_MODEL_NAME, 'DeepSeek-V4-Flash')
  assert.equal(config.WORLD_MODEL_PROTOCOL, 'openai')
  assert.equal(config.WORLD_MODEL_THINKING, 'disabled')
  assert.equal(config.WORLD_MODEL_REASONING_EFFORT, undefined)
  assert.equal(config.WORLD_SEARCH_API_KEY, undefined)
  const separate = configureEnvironment({ WORLD_CHAT_COMPLETIONS_URL: url, WORLD_API_KEY: key, WORLD_SEARCH_API_KEY: 'SEPARATE_OFFICIAL_SOURCE_KEY' }, 'live')
  assert.equal(separate.WORLD_SEARCH_API_KEY, 'SEPARATE_OFFICIAL_SOURCE_KEY')
})
