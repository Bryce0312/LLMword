const restartMessage = '当前地址的服务未加载新版自动跟踪接口。请重启正在运行的当前服务，再点击“重新检查当前服务”。输入内容会保留；高级材料研读仍可使用。'
const unavailableMessage = '暂时无法检查当前服务的自动跟踪能力。请确认当前服务正在运行后重试；输入内容会保留。'

export function environmentPresentation(config = {}, connection = {}) {
  const mode = config.modelMode
  if (!['mock', 'live'].includes(mode)) return null
  const live = mode === 'live'
  const configured = live && connection?.configured === true
  const state = ['connected', 'failed', 'unknown'].includes(connection?.connection) ? connection.connection : 'unknown'
  const dot = !configured ? 'idle' : state === 'connected' ? 'ready' : 'warning'
  const detail = !configured ? '当前AI模型未配置，请先在“模型连接”保存 API Key。'
    : state === 'connected' ? config.sources?.available === false ? 'AI模型已配置且连接校验通过；官方搜索与网页读取尚未配置。' : 'AI模型已配置且连接校验通过，实际任务仍受余额与权限影响。'
      : state === 'failed' ? 'AI模型已配置，但连接校验未通过；请检查 Key、账户权限或网络。' : 'AI模型已配置，连接状态待校验。'
  return { mode, configured, connection: state, dot,
    text: live ? `真实环境 · AI模型${configured ? '已配置' : '未配置'}` : '模拟环境 · 未配置',
    title: '显示当前运行环境和AI模型配置状态。' + (live ? detail : '本地协议模拟与历史 / 测试快照；不能作为真实预测证据，也不会接收真实 Key。') }
}

export function isMissingCourseApi(error = {}) {
  return [404, 405, 501].includes(error.status) || ['COURSE_DISABLED', 'RUNTIME_DISABLED'].includes(error.code)
}

export function unavailableCourseCapability(kind = 'temporarily-unavailable') {
  return { available: false, kind, message: kind === 'restart-required' ? restartMessage : unavailableMessage }
}

export function assessCourseCapability({ ok, status, body } = {}) {
  const detail = body?.error && typeof body.error === 'object' ? body.error : body
  if (!ok) {
    if (isMissingCourseApi({ status, code: detail?.code })) return unavailableCourseCapability('restart-required')
    if ([401, 403].includes(status)) return { available: false, kind: 'access-denied', message: '当前服务拒绝了能力检查，请确认访问权限后重试。输入内容会保留。' }
    return unavailableCourseCapability()
  }
  const capabilities = body?.capabilities ?? body
  if (capabilities?.supervisor !== true || capabilities?.forecastPublishing !== true || capabilities?.nativeToolProtocol !== true) {
    return unavailableCourseCapability('restart-required')
  }
  return { available: true, kind: 'available', message: '当前服务支持自动跟踪。', config: body }
}

/** Probe only the current origin. No alternative ports, redirects, POSTs or model calls. */
export async function probeCourseCapability({ fetcher = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher('/api/v1/course/config', { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: controller.signal })
    const body = await response.json().catch(() => null)
    return assessCourseCapability({ ok: response.ok, status: response.status, body })
  } catch {
    return unavailableCourseCapability()
  } finally { clearTimeout(timer) }
}

/** Keep writes behind a fresh check, including native Enter/programmatic form submission. */
export async function guardCourseSubmission(check, submit) {
  const capability = await check()
  if (!capability?.available) {
    const current = capability ?? unavailableCourseCapability()
    throw Object.assign(new Error(current.message), { code: 'COURSE_CAPABILITY_REQUIRED', capability: current })
  }
  return submit()
}
