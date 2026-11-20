/** These fields are status only; the API key never belongs in a view model. */
export function courseProviderPresentation(value = {}) {
  const configured = value.configured === true
  const activeRuns = Number.isSafeInteger(value.activeRuns) && value.activeRuns >= 0 ? value.activeRuns : null
  const activeWatchers = Number.isSafeInteger(value.activeWatchers) && value.activeWatchers >= 0 ? value.activeWatchers : null
  const keySource = ['environment', 'session', 'none'].includes(value.keySource) ? value.keySource : 'none'
  const locked = value.locked === true
  const connection = ['connected', 'failed', 'unknown'].includes(value.connection) ? value.connection : 'unknown'
  const connectionLabel = connection === 'connected' ? '已连接' : connection === 'failed' ? '已配置，未连接' : '已配置，待校验'
  const known = Number.isSafeInteger(activeRuns) && Number.isSafeInteger(activeWatchers)
  const canUpdate = known && (!configured || (activeRuns === 0 && activeWatchers === 0)) && (locked || value.canUpdate === true)
  return { configured, connection, activeRuns, activeWatchers, canUpdate, locked, provider: 'DeepSeek',
    label: locked ? '模拟环境（不可保存真实 Key）' : configured ? `API Key ${connectionLabel}` : '尚未配置 API Key',
    sourceLabel: locked ? '模拟环境不会读取或保存真实 Key；请使用 npm run start:live。' : configured ? keySource === 'session' ? '来源：本次后台进程中保存' : keySource === 'environment' ? '来源：服务端环境变量' : '来源未记录' : '请填写你自己的 DeepSeek API Key',
    taskState: locked ? '可以输入，但保存会被拒绝；当前进程不会接收真实 API Key。' : `正在执行或排队：${activeRuns ?? '未取得'}；持续监听：${activeWatchers ?? '未取得'}。`,
    actionHint: locked ? '模拟环境只使用 fixture 资料；输入 Key 会触发配置失败提示，真实接入请使用 npm run start:live。' : activeRuns > 0 ? `保存将被拒绝，原 Key 保持不变：当前有 ${activeRuns} 个正在执行或排队的任务，请先停止。` : activeWatchers > 0 ? configured ? `保存将被拒绝，原 Key 保持不变：当前有 ${activeWatchers} 个持续监听的任务，请先停止。` : `当前有 ${activeWatchers} 个持续监听的任务；这是首次配置，保存后这些计划会按新凭据继续。` : activeRuns === null || activeWatchers === null ? '任务或监听状态尚未取得，请刷新状态后再保存。' : !canUpdate ? '当前服务暂不允许更新连接。' : '保存后供后续真实任务使用，已有任务不会自动重跑或由旧监听计划唤醒。',
    verificationHint: '已连接表示 /models 校验成功；余额或模型权限仍可能影响实际任务。' }
}

export function courseProviderError(error = {}) {
  if (error.code === 'MODE_LOCKED') return '模拟环境配置失败：当前进程不会接收或保存真实 API Key。请改用 npm run start:live。'
  if (error.code === 'PROVIDER_UPDATE_BUSY') return '保存已拒绝：仍有正在运行、排队或持续监听的任务，原 API Key 保持不变。请先停止这些任务，刷新状态后重新输入并保存。'
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
