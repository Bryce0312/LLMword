import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No paid provider is contacted: the keyless phase refuses work, and the saved
// key is only checked through public configuration.
test('live entry starts without a key, refuses actions, then accepts a session key', { timeout: 20000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-live-keyless-'))
  const model = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}')
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelUrl = `http://127.0.0.1:${model.address().port}`
  const child = spawn(process.execPath, ['server/app.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env,
    WORLD_ENV: 'live', PORT: '0', WORLD_API_KEY: '', WORLD_MODEL_NAME: 'deepseek-v4-pro', WORLD_BASE_URL: modelUrl,
    WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_MODEL_THINKING: 'disabled', WORLD_MODEL_REASONING_EFFORT: '',
    WORLD_MONITOR: 'off', WORLD_WORKBENCH: 'on', WORLD_RUNTIME: 'probe', WORLD_COURSE: 'on',
    WORLD_SEARCH_PROVIDER: 'deepseek', WORLD_COURSE_POLL_MS: '3600000',
    WORLD_STATE_PATH: join(folder, 'legacy.json'), WORLD_COURSE_PATH: join(folder, 'course.sqlite'),
    WORLD_DOMAIN_PATH: join(folder, 'domain.sqlite'), WORLD_RUNTIME_PATH: join(folder, 'runtime.sqlite') } })
  const exited = once(child, 'exit'); let diagnostics = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited; await new Promise(resolve => model.close(resolve)); await rm(folder, { recursive: true, force: true })
  })
  const base = await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) resolve(match[0])
    })
    exited.then(() => reject(new Error(diagnostics)), reject)
  })

  const config = await fetch(base + '/api/v1/course/config').then(response => response.json())
  assert.equal(config.modelMode, 'live')
  assert.equal(config.sources.mode, 'unavailable')
  assert.equal(config.sources.available, false)

  const connection = await fetch(base + '/api/v1/course/provider-connection').then(response => response.json())
  assert.equal(connection.configured, false)
  assert.equal(connection.canUpdate, true)
  assert.equal(connection.locked, false)

  const refused = await fetch(base + '/api/v1/course/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '无 Key 时不应创建调查' }),
  })
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).error.code, 'MODEL_NOT_CONFIGURED')
  assert.deepEqual((await fetch(base + '/api/v1/course/requests').then(response => response.json())).requests, [])

  const key = 'TEST_LIVE_SESSION_KEY_0001'
  const saved = await fetch(base + '/api/v1/course/provider-connection', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }),
  })
  assert.equal(saved.status, 200)
  const connected = await saved.json()
  assert.equal(connected.configured, true)
  assert.equal(connected.keySource, 'session')
  assert.equal(connected.connection, 'connected')
  assert(!JSON.stringify(connected).includes(key))

  const after = await fetch(base + '/api/v1/course/config').then(response => response.json())
  assert.equal(after.sources.mode, 'live')
})
