export const isCourseTerminal = (run) => ['completed', 'finished', 'insufficient', 'failed', 'cancelled'].includes(run?.status)
export const courseStatusLabel = (value) => ({ queued: '排队中', preparing: '准备题目与来源', normalizing: '整理问题', researching: '调查中', running: '调查中', active: '跟踪中', watching: '等待新证据', ready: '已准备', completed: '本轮已完成', failed: '本轮未完成', stopped: '跟踪已停止', closed: '已到期', needs_clarification: '需要修改问题', insufficient: '暂未判断', blocked: '来源有缺口', cancelled: '本轮已取消' })[value] ?? value ?? '等待状态'
const text = (value) => typeof value === 'string' ? value.trim() : ''
const errorText = (value) => text(typeof value === 'string' ? value : value?.message)

/** A request retains previous-round messages; only the identified active run owns current progress. */
export function courseRequestProgress(data = {}) {
  const owner = data.requestId ?? data.id
  const candidates = [data.latestRun, data.run, ...(data.runs ?? [])].filter((run) => run?.runId && (!owner || !run.requestId || run.requestId === owner))
  const current = data.activeRunId ? candidates.find((run) => run.runId === data.activeRunId) : null
  if (data.status === 'stopped') return { label: '跟踪已停止', message: '', errorMessage: '', active: false, runId: current?.runId ?? null }
  if (data.activeRunId && (!current || !isCourseTerminal(current))) {
    const label = !current ? '正在读取本轮进度' : current.status === 'running' ? coursePhaseLabel(current) : courseStatusLabel(current.status)
    return { label, message: text(current?.summary), errorMessage: errorText(current?.error), active: true, runId: data.activeRunId }
  }
  const latest = current ?? [data.latestRun, data.run].find((run) => candidates.includes(run)) ?? candidates.at(-1)
  const status = latest?.status ?? data.status
  const label = latest?.directionOutlook ? '已给出暂定走势' : latest?.budgetSummary?.recovered ? '预算用尽，已整理材料' : latest?.budgetSummary ? '本轮已提前收尾' : status === 'insufficient' ? '本轮资料不足，暂未判断' : status === 'failed' ? '本轮调查失败' : status === 'cancelled' ? '本轮已取消' : isCourseTerminal(latest) ? data.watch?.status === 'active' ? '本轮完成，等待新证据' : '本轮已结束' : courseStatusLabel(status)
  const message = text(latest?.summary) || (!latest ? text(data.message) : '')
  const errorMessage = latest?.budgetSummary ? '' : errorText(latest?.error) || (!latest ? errorText(data.error) : '') || (['failed', 'needs_clarification', 'blocked'].includes(status) ? message || '题目或来源还需要核对，可修改问题后重新跟踪。' : '')
  return { label, message, errorMessage, active: false, runId: latest?.runId ?? null }
}

/** Public capability metadata describes current execution settings, never a historical run's settings. */
export function courseReasoningLabel(value) {
  const config = value?.capabilities ?? value
  if (config?.modelMode !== 'live' || config.reasoningSettings?.thinking !== 'enabled') return null
  return '深度研判' + (/(?:^|[-_/])pro(?:$|[-_/])/i.test(config.modelRef ?? '') ? ' / Pro' : '')
}
import { coursePhaseLabel } from './course-workflow.js'
