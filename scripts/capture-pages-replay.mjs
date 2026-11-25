// 抓取一次封存的模拟课程运行，生成 GitHub Pages 只读回放快照。
// 用法：node scripts/capture-pages-replay.mjs
// 数据目录固定为 .data/pages-capture，绝不读写 .data/mock 或 .data/live。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trimReplaySnapshot } from './pages-replay/trim.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const captureDir = join(root, '.data', 'pages-capture')
const output = join(root, 'scripts', 'pages-replay', 'snapshot.json')
const port = Number(process.env.PAGES_CAPTURE_PORT ?? 4199)
const origin = `http://127.0.0.1:${port}`
const api = `${origin}/api/v1`
const demoQuestion = '英伟达下一份财报发布后，盘后股价会高于财报发布前收盘价吗？'
const terminal = new Set(['completed', 'insufficient', 'failed', 'stopped', 'cancelled', 'void'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(path, options = {}) {
  const response = await fetch(api + path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 300)}`)
  return body
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('模拟服务提前退出。')
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {}
    await sleep(500)
  }
  throw new Error('模拟服务未在 30 秒内就绪。')
}

await rm(captureDir, { recursive: true, force: true })
await mkdir(captureDir, { recursive: true })

let stderr = ''
const child = spawn(process.execPath, ['server/app.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    WORLD_ENV: 'mock',
    PORT: String(port),
    WORLD_STATE_PATH: join(captureDir, 'world.json'),
    WORLD_MOCK_PACING: '0',
    WORLD_MONITOR: 'off',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

try {
  await waitForServer(child)
  const created = await call('/course/requests', {
    method: 'POST',
    body: { purpose: 'forecast', question: demoQuestion, mode: 'preset', watch: false, horizonHours: 48 },
    headers: { 'Idempotency-Key': randomUUID() },
  })
  const requestId = created.requestId
  const runIds = new Set((created.runs ?? []).map((run) => run.runId).filter(Boolean))
  if (created.latestRunId) runIds.add(created.latestRunId)

  let request
  for (let attempt = 0; attempt < 180; attempt++) {
    await sleep(1000)
    request = await call(`/course/requests/${encodeURIComponent(requestId)}`)
    for (const run of request.runs ?? []) if (run.runId) runIds.add(run.runId)
    if (request.latestRunId) runIds.add(request.latestRunId)
    if (terminal.has(request.status) && request.latestRunId) break
  }
  if (!request || request.status !== 'completed') throw new Error(`模拟运行未完成，最后状态：${request?.status ?? 'unknown'}`)

  const routes = []
  const record = async (method, path, body, search) => routes.push({ method, path, ...(search ? { search } : {}), status: 200, body })
  const paths = ['/topics', '/predictions', '/agents', '/tools', '/config', '/course/config', '/course/provider-connection', '/course/requests', '/course/settings', '/learning']
  for (const path of paths) record('GET', path, await call(path))
  record('GET', `/course/requests/${encodeURIComponent(requestId)}`, request)

  const runSnapshot = async (runId) => {
    record('GET', `/course/runs/${encodeURIComponent(runId)}`, await call(`/course/runs/${encodeURIComponent(runId)}`))
    record('GET', '/course/events', await call(`/course/events?afterSeq=0&runId=${encodeURIComponent(runId)}`), `afterSeq=0&runId=${encodeURIComponent(runId)}`)
  }
  for (const runId of runIds) {
    try { await runSnapshot(runId) } catch (error) { if (runId === request.latestRunId) throw error }
  }

  const latestRun = (request.runs ?? []).find((run) => run.runId === request.latestRunId) ?? request.latestRun
  const snapshot = {
    meta: {
      capturedAt: new Date().toISOString(),
      environment: 'mock',
      modelMode: 'mock',
      modelRef: latestRun?.modelRef ?? '',
      sourceMode: 'replay',
      notice: '封存的模拟运行回放：数据由 mock 环境产生，不代表真实模型结果或预测准确率。',
    },
    demo: { requestId, runId: request.latestRunId, question: demoQuestion, status: request.status },
    sync: {
      schemaVersion: 1,
      serverEpoch: latestRun?.events?.[0]?.serverEpoch ?? 'pages-replay',
      type: 'sync',
      payload: { reset: true, activeRuns: [], runs: [], snapshotVersion: 1, coveredThroughCursor: `${latestRun?.events?.[0]?.serverEpoch ?? 'pages-replay'}:0` },
    },
    routes,
  }
  await mkdir(join(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(trimReplaySnapshot(snapshot), null, 2))
  const forecast = request.forecast
  console.log(`captured ${requestId} (${request.status}); events=${latestRun?.events?.length ?? 0}; forecast=${forecast ? 'yes' : 'no'}`)
  console.log(`wrote ${output}`)
} catch (error) {
  if (stderr) console.error(stderr)
  throw error
} finally {
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill()
    setTimeout(resolve, 5000)
  })
}
