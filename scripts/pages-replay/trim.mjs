/* 快照裁剪：只保留只读回放实际需要的字段。
 * 裁剪不会改变回放语义：
 * - /course/requests 列表只保留卡片/侧栏需要的字段，移除内嵌的完整 run 列表。
 * - /course/requests/:id 保留完整 run，但移除内嵌的 events / collaboration；
 *   研究室需要时会重新请求 /course/runs/:id（该路由保留完整数据）。
 * - run / latestRun 只保留进度与列表展示会读到的字段。
 * - 未使用的 /course/events 聚合路由整条移除。 */

const LIST_FIELDS = [
  'requestId', 'purpose', 'question', 'status', 'createdAt', 'updatedAt',
  'normalized', 'forecast', 'forecasts', 'watch', 'watchEnabled', 'researchReport',
  'activeRunId', 'latestRunId', 'predictionId', 'predictionVersion',
  'deleted', 'deletedAt',
]

const SLIM_RUN_FIELDS = [
  'runId', 'requestId', 'status', 'phase', 'trigger', 'summary', 'error',
  'directionOutlook', 'budgetSummary', 'triage', 'createdAt', 'updatedAt',
]

const EMBEDDED_RUN_FIELDS = [...SLIM_RUN_FIELDS, 'team', 'assignments', 'usage', 'budget', 'predictionId', 'harnessVersion']

function pick(source, fields) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}

function slimRun(run) {
  return pick(run, EMBEDDED_RUN_FIELDS)
}

function slimLatest(run) {
  return pick(run, SLIM_RUN_FIELDS)
}

function slimListRecord(record) {
  const out = pick(record, LIST_FIELDS)
  if (Array.isArray(record.runs)) out.runs = record.runs.map(slimRun)
  if (record.latestRun) out.latestRun = slimLatest(record.latestRun)
  return out
}

function slimDetailRecord(record) {
  const out = { ...record }
  const runs = Array.isArray(record.runs) ? record.runs.map(slimRun) : record.runs
  const byId = new Map((runs || []).map((run) => [run.runId, run]))
  // 重复的 run / latestRun 必须与 runs 中的同一条保持同样完整度：
  // 前端用 Map 去重时后者覆盖前者，若这里留成精简版会丢掉 assignments。
  const collapse = (run) => (run ? byId.get(run.runId) ?? slimLatest(run) : run)
  if (runs) out.runs = runs
  if (record.run) out.run = collapse(record.run)
  if (record.latestRun) out.latestRun = collapse(record.latestRun)
  return out
}

export function trimReplaySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.routes)) return snapshot
  const routes = []
  for (const route of snapshot.routes) {
    if (route.path === '/course/events') continue
    if (route.path === '/course/requests') {
      const body = route.body ?? {}
      routes.push({ ...route, body: { ...body, requests: Array.isArray(body.requests) ? body.requests.map(slimListRecord) : body.requests } })
      continue
    }
    if (route.path.startsWith('/course/requests/')) {
      routes.push({ ...route, body: slimDetailRecord(route.body ?? {}) })
      continue
    }
    routes.push(route)
  }
  return { ...snapshot, routes }
}
