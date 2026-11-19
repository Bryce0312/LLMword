const restartMessage = '当前地址的服务未加载新版自动跟踪接口。请重启正在运行的当前服务，再点击“重新检查当前服务”。输入内容会保留；高级材料研读仍可使用。'
const unavailableMessage = '暂时无法检查当前服务的自动跟踪能力。请确认当前服务正在运行后重试；输入内容会保留。'

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
