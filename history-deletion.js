import { mergeDeletedHistoryMetadata } from './room-shell-navigation.js'

const TERMINAL_RUNS = new Set(['completed', 'finished', 'insufficient', 'failed', 'cancelled'])
const INACTIVE_WATCHES = new Set(['off', 'closed', 'stopped', 'paused_provider', 'failed', 'cancelled', 'inactive', 'completed'])
const requestId = record => record?.requestId ?? record?.id
const latestRunId = record => record?.latestRunId ?? record?.latestRun?.runId ?? record?.run?.runId

export function historyRecordDeleteVisible(record) {
  if (!record || record.deleted || record.deletedAt || record.purpose === 'research' || record.researchReport || record.status === 'stopped') return false
  const status = record.latestRun?.status ?? record.run?.status ?? record.status
  return status === 'failed' || status === 'insufficient' || Boolean(record.forecast && ['completed', 'finished', 'closed'].includes(status))
}

export function historyRecordCanDelete(record) {
  if (!historyRecordDeleteVisible(record)) return false
  if (typeof requestId(record) !== 'string' || !requestId(record) || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || typeof latestRunId(record) !== 'string' || !latestRunId(record)) return false
  const watch = record.watch
  const legacyIdleWatch = watch && typeof watch === 'object' && !Array.isArray(watch) && watch.status == null && watch.nextDueAt == null
  if (record.activeRunId || watch === true || (watch && !legacyIdleWatch && !INACTIVE_WATCHES.has(watch.status))) return false
  const runs = [record.latestRun, record.run, ...(record.runs ?? [])].filter(Boolean)
  if (runs.some(run => !TERMINAL_RUNS.has(run.status))) return false
  const status = record.latestRun?.status ?? record.run?.status ?? record.status
  return status === 'failed' || status === 'insufficient' || Boolean(record.forecast && ['completed', 'finished', 'closed'].includes(status))
}

export function createHistoryDeletionAction(record, { confirm, request, getRecord = () => record, isActive = () => true }) {
  let pending = false
  return async function deleteRecord() {
    if (pending) return { deleted: false, busy: true }
    if (!isActive()) return { deleted: false, cancelled: true }
    const current = getRecord()
    if (!historyRecordCanDelete(current)) throw Object.assign(new Error('History record cannot be deleted.'), { code: 'REQUEST_IN_USE' })
    const id = requestId(current), guard = { confirmed: true, expectedUpdatedAt: current.updatedAt, expectedLatestRunId: latestRunId(current) }
    pending = true
    try {
      const name = current.question?.trim() || current.normalized?.question || current.prediction?.question || '这条预测记录'
      let approved
      try { approved = await confirm('确认删除预测记录“' + name + '”？\n\n删除后，这条记录将从预测历史列表移除。原始运行、判断和证据保留供追溯；不会自动重新调查。') }
      catch { return { deleted: false, cancelled: true } }
      if (approved !== true || !isActive()) return { deleted: false, cancelled: true }
      const latest = getRecord()
      if (!historyRecordCanDelete(latest)) throw Object.assign(new Error('History record is in use.'), { code: 'REQUEST_IN_USE' })
      if (latest.updatedAt !== guard.expectedUpdatedAt || latestRunId(latest) !== guard.expectedLatestRunId) throw Object.assign(new Error('History record changed.'), { code: 'REQUEST_DELETE_CONFLICT' })
      const result = await request('/course/requests/' + encodeURIComponent(id), { method: 'DELETE', body: guard })
      if (result?.deleted !== true || result.requestId !== id || typeof result.deletedAt !== 'string' || !Number.isFinite(Date.parse(result.deletedAt))) throw Object.assign(new Error('History deletion was not confirmed.'), { code: 'REQUEST_DELETE_UNCONFIRMED' })
      return result
    } finally { pending = false }
  }
}

export function applyHistoryDeletion(cache, receipt, record) {
  const predictionId = receipt.predictionId ?? record?.predictionId
  mergeDeletedHistoryMetadata(cache, { deletedRequestIds: [receipt.requestId], deletedPredictionIds: predictionId ? [predictionId] : [] })
}

export function historyDeletionError(error = {}) {
  if (error.code === 'REQUEST_IN_USE') return '调查或持续预测仍在进行，暂不能删除记录。请先停止后重试。'
  if (error.code === 'REQUEST_DELETE_CONFLICT') return '记录状态已变化，未能删除。请刷新历史记录后重试。'
  if (error.code === 'REQUEST_DELETE_UNCONFIRMED') return '服务未确认删除结果，当前记录保留。请刷新历史记录核对。'
  if (error.status === 401 || error.status === 403) return '没有删除这条预测记录的权限，记录保留。'
  if (error.status === 404) return '暂时无法删除这条记录，请刷新历史记录；若服务尚未更新，请重启当前服务。'
  return '删除记录失败，当前记录保留。请稍后重试。'
}
