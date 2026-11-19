import { courseAssignments, normalizeCourseRole } from './course-team.mjs'
import { isCourseTerminal, courseStatusLabel } from './course-status.mjs'

export function courseRunBelongsToRequest(data, run) {
  const owner = data?.requestId ?? data?.id
  return Boolean(owner && run?.runId && run.requestId === owner && (!data.predictionId || !run.predictionId || run.predictionId === data.predictionId))
}

export function courseRuns(data = {}) {
  const records = [...(data.runs ?? []), data.run, data.latestRun].filter((run) => courseRunBelongsToRequest(data, run))
  return [...new Map(records.map((run) => [run.runId, run])).values()]
}

/** Count actual researcher assignments, excluding the chair and duplicate follow-ups. */
export function courseResearcherCount(run) {
  return new Set(courseAssignments(run).map((assignment) => normalizeCourseRole(assignment.roleId ?? assignment.agentSpecId ?? assignment.role)).filter((id) => id && id !== 'supervisor')).size
}

export function isCourseListeningCheck(run) {
  return courseResearcherCount(run) === 0 && (run?.triage?.kind === 'no_change' || run?.phase === 'watch_check' || run?.trigger === 'watch')
}

/** Auto follows the answer; explicit choices are pinned. The caller validates explicit URL ownership. */
export function selectCourseRoomRun(data, { selectedRunId = null, pinned = false } = {}) {
  if (pinned && selectedRunId) return selectedRunId
  const runs = courseRuns(data)
  const forecastRun = runs.find((run) => run.runId === data.forecast?.runId)
  if (forecastRun) return forecastRun.runId
  const active = runs.find((run) => run.runId === data.activeRunId)
  if (active) return active.runId
  return [...runs].reverse().find((run) => courseResearcherCount(run) > 0)?.runId ?? runs.at(-1)?.runId ?? null
}

export function courseRunLabel(run, index = 0) {
  const prefix = '第 ' + (index + 1) + ' 轮 · '
  if (run.status === 'failed') return prefix + '失败'
  if (run.status === 'cancelled') return prefix + '已取消'
  const kind = isCourseListeningCheck(run) ? run.triage?.kind === 'no_change' ? '监听检查 · 无变化' : '监听检查' : run.triage?.kind === 'local' ? '局部复核' : courseResearcherCount(run) > 0 ? '研判' : '研判准备'
  if (run.status === 'insufficient') return prefix + kind + ' · 资料不足'
  return prefix + kind + (isCourseTerminal(run) ? '' : ' · ' + courseStatusLabel(run.status))
}

export function courseAnswerProvenance(data = {}) {
  const runs = courseRuns(data)
  const forecastRun = runs.find((run) => run.runId === data.forecast?.runId)
  const researchRuns = runs.filter((run) => courseResearcherCount(run) > 0)
  const researchNumber = forecastRun ? researchRuns.findIndex((run) => run.runId === forecastRun.runId) + 1 : 0
  const workerCount = forecastRun ? courseResearcherCount(forecastRun) : null
  const latest = runs.find((run) => run.runId === data.latestRun?.runId) ?? runs.find((run) => run.runId === data.latestRunId) ?? runs.at(-1)
  const check = [...runs].reverse().find(isCourseListeningCheck)
  let summary = !data.forecast ? '尚未发布预测；房间显示当前调查或最近有实际派工的轮次。' : forecastRun && researchNumber > 0 ? '当前答案来自第 ' + researchNumber + ' 次研判，共 ' + workerCount + ' 位研究员参与。' : '当前答案的协作轮次暂未取得，参与人数尚不能确认。'
  if (data.forecast && latest && latest.runId !== forecastRun?.runId) {
    if (isCourseListeningCheck(latest) && latest.triage?.kind === 'no_change' && ['completed', 'finished'].includes(latest.status)) summary += '最近仅监听检查，沿用原判断。'
    else if (isCourseListeningCheck(latest) && !isCourseTerminal(latest)) summary += '最近正在监听检查，尚未发布新判断。'
    else if (isCourseListeningCheck(latest) && ['failed', 'insufficient'].includes(latest.status)) summary += '最近监听检查未完成，未产生新判断。'
    else if (courseResearcherCount(latest) > 0 && !isCourseTerminal(latest)) summary += '另有新一轮研判进行中，尚未替代当前答案。'
  }
  return { summary, forecastRunId: forecastRun?.runId ?? null, latestCheckRunId: check?.runId ?? null, researchNumber, workerCount }
}
