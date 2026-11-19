/** These fields are status only; the API key never belongs in a view model. */
export function courseProviderPresentation(value = {}) {
  const configured = value.configured === true
  const activeRuns = Number.isSafeInteger(value.activeRuns) && value.activeRuns >= 0 ? value.activeRuns : null
  const activeWatchers = Number.isSafeInteger(value.activeWatchers) && value.activeWatchers >= 0 ? value.activeWatchers : null
  const keySource = ['environment', 'session', 'none'].includes(value.keySource) ? value.keySource : 'none'
  const canUpdate = value.canUpdate === true && activeRuns === 0 && activeWatchers === 0
  const blockers = [activeRuns > 0 ? `${activeRuns} 个正在执行或排队的任务` : '', activeWatchers > 0 ? `${activeWatchers} 个持续监听的任务` : ''].filter(Boolean)
  return { configured, activeRuns, activeWatchers, canUpdate, provider: 'DeepSeek',
    label: configured ? '服务器已配置 API Key' : '尚未配置 API Key',
    sourceLabel: configured ? keySource === 'session' ? '来源：本次后台进程中保存' : keySource === 'environment' ? '来源：服务端环境变量' : '来源未记录' : '请填写你自己的 DeepSeek API Key',
    taskState: `正在执行或排队：${activeRuns ?? '未取得'}；持续监听：${activeWatchers ?? '未取得'}。`,
    actionHint: blockers.length ? `当前有${blockers.join('、')}。更换 Key 前，请先对这些旧任务点击“停止跟踪”，再刷新连接状态。` : activeRuns === null || activeWatchers === null ? '任务或监听状态尚未取得，请刷新状态后再保存。' : !canUpdate ? '当前服务暂不允许更新连接。' : '保存后供后续真实任务使用，已有任务不会自动重跑或由旧监听计划唤醒。',
    verificationHint: '已配置只表示服务器保存了凭据，不代表账户有余额或模型连接已经验证。' }
}

export function courseProviderError(error = {}) {
  if (error.status === 409) return '仍有正在运行、排队或持续监听的旧任务，原连接继续使用。请先停止这些旧任务的跟踪，刷新状态后重新输入并保存。'
  if (error.status === 400) return 'Key 格式未通过检查，请核对后重新输入。'
  if (error.status === 401) return '当前请求没有更新模型连接的权限。'
  if (error.status === 404) return '当前后台版本尚未提供模型连接设置，请更新后台后重新读取。'
  return '模型连接未能保存，原连接保留。请稍后重新读取状态再试。'
}

/** Clear the DOM before transmission, including both success and failure paths. */
export async function saveCourseProviderKey(input, request) {
  let apiKey = input.value.trim()
  input.value = ''
  if (!apiKey) throw Object.assign(new Error('请先输入 DeepSeek API Key。'), { code: 'EMPTY_API_KEY' })
  try { return await request({ apiKey }) }
  finally { apiKey = ''; input.value = '' }
}
