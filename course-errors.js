import { isPriceDirection } from './course-price-direction.js'
import { courseRuns } from './course-runs.js'
import { courseRequestProgress, isCourseTerminal } from './course-status.js'

const isDeletedRequest = (data) => data.deleted === true || Boolean(data.deletedAt)

const recovery = {
  MODEL_BALANCE_REQUIRED: ['本轮模型账户额度不足', '本轮模型调用因账户额度问题停止。', '额度恢复后可直接重试本次调查，不需要重填问题。', true],
  SOURCE_BALANCE_REQUIRED: ['本轮资料服务额度不足', '本轮搜索或取证因来源服务额度问题停止。', '额度恢复后可直接重试本次调查，不需要重填问题。', true],
  MODEL_AUTH_FAILED: ['模型服务鉴权失败', '模型服务未接受当前服务端凭据。', '请更新服务端凭据后重试，不需要重新输入问题。', true],
  SOURCE_AUTH_FAILED: ['资料服务鉴权失败', '资料服务未接受当前服务端凭据。', '请更新资料服务凭据后，手动重试。', true],
  MODEL_ACCESS_DENIED: ['模型服务拒绝访问', '当前账户或配置没有完成这次模型请求的访问权限。', '请确认模型权限与服务配置后，手动重试。', true],
  SOURCE_ACCESS_DENIED: ['资料服务拒绝访问', '本轮所需来源服务没有允许这次访问。', '请恢复来源访问权限后，手动重试。', true],
  MODEL_RATE_LIMITED: ['模型请求受到限流', '模型服务暂时限制了请求频率，本轮没有完成。', '请稍后手动重试本次调查。', false],
  MODEL_SERVICE_UNAVAILABLE: ['模型服务暂不可用', '模型服务未能完成这次请求。', '请稍后手动重试本次调查。', false],
  MODEL_TIMEOUT: ['模型响应超时', '本轮未在执行期限内取得完整模型响应。', '可手动重试；原问题和已有记录已保留。', false],
  MODEL_NETWORK: ['模型连接中断', '本轮未能取得完整模型响应。', '网络恢复后可手动重试，原问题不需要重填。', false],
  MODEL_INCOMPLETE: ['模型输出未完整结束', '本轮没有取得完整工具动作或报告，未据此发布概率。', '请检查服务端输出上限或上下文配置后，再手动重试；重复相同配置仍可能截断。', false],
  MODEL_NOT_CONFIGURED: ['尚未配置模型 Key', '真实环境需要在“模型连接”保存 DeepSeek API Key 后才能开始。', '打开“模型连接”保存 Key，然后重新提交。', true],
}

/** Only public safe codes select specific causes. Raw vendor bodies never reach the UI. */
export function courseErrorPresentation(error = {}) {
  const known = recovery[error.code]
  const [title, detail, nextStep, requiresAction] = known ?? ['本轮调查未完成', typeof error.message === 'string' && error.message.trim() ? error.message : '服务没有提供可区分的安全错误原因。', '问题和运行记录已保留，可手动重试本次调查。', error.actionRequired === true]
  return { title, detail, detailIsSystem: Boolean(known || !(typeof error.message === 'string' && error.message.trim())), nextStep, requiresAction, automaticRetry: false, ...(error.code === 'MODEL_RATE_LIMITED' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 && error.retryAfterMs <= 30000 ? { waitHint: '服务建议的重试间隔约 ' + Math.ceil(error.retryAfterMs / 1000) + ' 秒。' } : {}) }
}

export function courseRequestFailure(data = {}) {
  const progress = courseRequestProgress(data)
  const run = courseRuns(data).find((item) => item.runId === progress.runId)
  const runError = run?.budgetSummary?.recovered ? null : run?.error
  const error = runError ?? (!progress.active && data.watch?.status === 'paused_provider' ? data.watch.pauseReason : !progress.active && !run ? data.error : null)
  if (error) return courseErrorPresentation(error)
  return progress.errorMessage ? courseErrorPresentation({ message: progress.errorMessage }) : null
}

/** Recovery is an explicit POST, never a poll/automatic retry, even for non-retryable billing errors. */
export function courseRequestAction(data = {}, { now = Date.now() } = {}) {
  const runs = courseRuns(data)
  const latest = runs.find((run) => run.runId === data.latestRun?.runId) ?? runs.find((run) => run.runId === data.latestRunId) ?? runs.at(-1)
  const retry = (latest ? latest.status === 'failed' : data.status === 'failed') || data.watch?.status === 'paused_provider'
  const kind = retry ? 'retry' : 'check'
  const label = retry ? '重试本次调查' : '检查一次新资料'
  const disabled = (reason) => ({ enabled: false, kind, label, reason, automaticRetry: false })
  if (isDeletedRequest(data)) return disabled('这项预测记录已从历史列表移除，仅供查看。')
  if (isPriceDirection(data)) return disabled('此三分类任务保留供回看。若需重新调查，请创建新的二元预测。')
  if (['stopped', 'closed'].includes(data.status)) return disabled('本题已停止或到期。')
  if (data.result) return disabled('本题已有结果记录。')
  if (data.activeRunId || runs.some((run) => !isCourseTerminal(run))) return disabled('本题已有调查进行中。')
  const deadline = data.normalized?.forecastClosesAt ?? data.prediction?.forecastClosesAt ?? data.strict?.targetAt
  if (deadline && Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= now) return disabled('固定目标已到期，不能继续发布预测。')
  if (latest?.budgetSummary) return { enabled: true, kind: 'retry', label: '重新调查', reason: '开启新一轮调查，保留本轮阶段性结果。', automaticRetry: false }
  if (retry && data.resolutionPolicy && latest?.phase === 'review' && ['MODEL_INCOMPLETE', 'COURSE_BUDGET'].includes(latest.error?.code) && !latest.usage?.unknownUsage) return latest.summaryResumeCount ? disabled('此短窗口预测的汇总恢复已用完，原资料保留。') : { enabled: true, kind: 'resume-summary', label: '只恢复预测汇总', reason: '复用已有报告，仍受原期限和预算限制。', automaticRetry: false }
  if (retry && data.purpose === 'research' && latest?.phase === 'review' && (latest.error?.code === 'MODEL_INCOMPLETE' || latest.summaryRequestNotSent) && !latest.usage?.unknownUsage) return latest.summaryResumeCount >= 2 && !latest.summaryRequestNotSent
    ? { enabled: true, kind: 'assemble-report', label: '生成研究员资料整理版', reason: '程序整理已有报告，无需模型调用；主Agent裁决未完成。', automaticRetry: false }
    : { enabled: true, kind: 'resume-summary', label: '继续整理已有报告', reason: '只续写汇总，不重跑研究员。', automaticRetry: false }
  if (retry) return { enabled: true, kind, label, reason: '', automaticRetry: false }
  if (!data.predictionId || data.status === 'needs_clarification') return disabled('题目尚未准备完成。')
  return { enabled: true, kind, label, reason: '', automaticRetry: false }
}

/** Failure ends one run, not the user's ability to stop the request's watcher. */
export function courseRequestCanStop(data = {}, { busy = false } = {}) {
  return Boolean((data.requestId ?? data.id) && !busy && !isDeletedRequest(data) && !['stopped', 'closed'].includes(data.status))
}
