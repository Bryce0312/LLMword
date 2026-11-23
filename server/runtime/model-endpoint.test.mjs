import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CHAT_COMPLETIONS_URL, DEFAULT_MODEL_NAME, MODEL_CONNECTION_PRESETS, resolveModelEndpoints, validateModelConnection } from './model-endpoint.mjs'

test('official defaults and both public presets preserve their exact model and endpoint', () => {
  assert.equal(DEFAULT_CHAT_COMPLETIONS_URL, 'https://api.deepseek.com/chat/completions')
  assert.equal(DEFAULT_MODEL_NAME, 'deepseek-flash')
  assert.deepEqual(resolveModelEndpoints({}), { chatCompletionsUrl: DEFAULT_CHAT_COMPLETIONS_URL, modelsUrl: 'https://api.deepseek.com/models', protocol: 'deepseek' })
  for (const preset of MODEL_CONNECTION_PRESETS) assert.deepEqual(validateModelConnection(preset), { url: preset.url, model: preset.model, protocol: preset.protocol })
  const school = MODEL_CONNECTION_PRESETS.find(item => item.id === 'school')
  assert.equal(school.url, 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions')
  assert.equal(school.model, 'DeepSeek-V4-Flash')
})

test('explicit complete URLs override legacy bases and retain gateway double slashes', () => {
  const url = 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions'
  assert.deepEqual(resolveModelEndpoints({ WORLD_CHAT_COMPLETIONS_URL: url, WORLD_BASE_URL: 'file:///ignored' }), {
    chatCompletionsUrl: url, modelsUrl: 'https://genai.comp.polyu.edu.hk/api/v1//models', protocol: 'openai',
  })
  assert.deepEqual(resolveModelEndpoints({ WORLD_BASE_URL: 'http://127.0.0.1:9999/v1///' }), {
    chatCompletionsUrl: 'http://127.0.0.1:9999/v1/chat/completions', modelsUrl: 'http://127.0.0.1:9999/v1/models', protocol: 'openai',
  })
  assert.equal(resolveModelEndpoints({ WORLD_CHAT_COMPLETIONS_URL: url, WORLD_MODEL_PROTOCOL: 'deepseek' }).protocol, 'deepseek')
})

test('custom complete HTTP endpoints are used as entered and model checks use the same directory', () => {
  for (const [url, modelsUrl] of [
    ['http://127.0.0.1:9999/api/invoke', 'http://127.0.0.1:9999/api/models'],
    ['https://gateway.example/api/v1//completion', 'https://gateway.example/api/v1//models'],
    ['https://gateway.example/api/invoke/', 'https://gateway.example/api/invoke/models'],
    ['https://gateway.example/', 'https://gateway.example/models'],
  ]) {
    assert.equal(validateModelConnection({ url, model: 'Custom-Model-V4' }).url, url)
    assert.equal(resolveModelEndpoints({ WORLD_CHAT_COMPLETIONS_URL: url }).modelsUrl, modelsUrl)
  }
})

test('invalid endpoint and model settings fail locally without silently falling back', () => {
  for (const url of ['', 'relative/path', 'https:gateway.example/chat/completions', 'file:///private', 'ftp://gateway.example/chat/completions',
    'https://user:pass@gateway.example/chat/completions', 'https://gateway.example/chat/completions?key=secret',
    'https://gateway.example/chat/completions?', 'https://gateway.example/chat/completions#',
    'https://gateway.example/chat/completions\n', 'https://gate way.example/chat/completions', 'https://gateway.example/' + 'x'.repeat(2048)]) {
    assert.throws(() => validateModelConnection({ url, model: 'DeepSeek-V4-Flash' }), { code: 'MODEL_CONFIG' })
    assert.throws(() => resolveModelEndpoints({ WORLD_CHAT_COMPLETIONS_URL: url }), { code: 'MODEL_CONFIG' })
  }
  for (const model of ['', ' ', null, 'x'.repeat(201), 'model\nprivate']) assert.throws(() => validateModelConnection({ url: DEFAULT_CHAT_COMPLETIONS_URL, model }), { code: 'MODEL_CONFIG' })
  assert.equal(validateModelConnection({ url: DEFAULT_CHAT_COMPLETIONS_URL, model: ' DeepSeek-V4-Flash ' }).model, 'DeepSeek-V4-Flash')
})
