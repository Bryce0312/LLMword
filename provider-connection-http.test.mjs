import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Checks configuration only: no question, forecast, or external model request.
test('the local UI connection endpoint enables a real provider from a keyless demo without writing the key to application data', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-connection-'))
  const key = 'TEST_CONNECTION_NOT_A_REAL_KEY'
  const child = spawn(process.execPath, ['server/app.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env,
    PORT: '0', WORLD_MODEL: 'mock', WORLD_API_KEY: '', WORLD_MODEL_NAME: '', WORLD_MODEL_THINKING: '', WORLD_MODEL_REASONING_EFFORT: '',
    WORLD_BASE_URL: 'http://127.0.0.1:1',
    WORLD_MONITOR: 'off', WORLD_WORKBENCH: 'on', WORLD_RUNTIME: 'probe', WORLD_COURSE: 'on', WORLD_SEARCH_PROVIDER: 'fixture',
    WORLD_STATE_PATH: join(folder, 'state.json'), WORLD_RUNTIME_PATH: join(folder, 'runtime.sqlite'),
    WORLD_DOMAIN_PATH: join(folder, 'domain.sqlite'), WORLD_COURSE_PATH: join(folder, 'course.sqlite'),
  } })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; await rm(folder, { recursive: true, force: true }) })
  const base = await new Promise((resolve, reject) => {
    let log = ''
    child.stdout.setEncoding('utf8').on('data', part => { log += part; const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]) })
    exited.then(() => reject(new Error(stderr)), reject)
  })
  const path = base + '/api/v1/course/provider-connection'
  assert.equal((await fetch(path).then(r => r.json())).configured, false)
  const cross = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: JSON.stringify({ apiKey: key }) })
  assert.equal(cross.status, 403)
  const result = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ apiKey: key }) })
  assert.equal(result.status, 200)
  const configured = await result.json()
  assert.equal(configured.modelMode, 'live')
  assert.equal(configured.keySource, 'session')
  assert.equal(configured.connection, 'failed')
  assert(!JSON.stringify(configured).includes(key))
  const capability = await fetch(base + '/api/v1/course/config').then(r => r.json())
  assert.equal(capability.modelMode, 'live')
  assert.equal(capability.sourceMode, 'live')
  assert(!JSON.stringify(capability).includes(key))
  assert.deepEqual((await fetch(base + '/api/v1/course/requests').then(r => r.json())).requests, [])
  for (const file of await readdir(folder)) assert(!(await readFile(join(folder, file))).includes(Buffer.from(key)), 'Key must not be saved in ' + file)
  assert(!stderr.includes(key))
})
