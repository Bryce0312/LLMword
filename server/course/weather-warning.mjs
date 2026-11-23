import { createHash } from 'node:crypto'
export const WARNING_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en'
export const WARNING_POLICY = 'hko-red-fire-observation-v1'
export const WARNING_RULE = '以目标时点后5分钟内首次成功取得的香港天文台warnsum完整快照为准：WFIRE的code为WFIRER且actionCode不是CANCEL则Yes，否则No；未在观察窗口取得有效快照则不结算。此规则使用有界首次观察，不声称精确秒级历史状态。'
const fail = (code) => Object.assign(new Error(code), { warningCode: code })
export function parseWarnings(raw, obtainedAt) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isFinite(Date.parse(obtainedAt))) throw fail('WARNING_INVALID')
  for (const [id, item] of Object.entries(raw)) {
    if (!/^W[A-Z0-9]{1,15}$/.test(id) || !item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.code !== 'string' ||
      !['ISSUE', 'REISSUE', 'EXTEND', 'UPDATE', 'CANCEL'].includes(item.actionCode) || !Number.isFinite(Date.parse(item.updateTime)) || Date.parse(item.updateTime) > Date.parse(obtainedAt) + 5000 ||
      item.issueTime && (!Number.isFinite(Date.parse(item.issueTime)) || Date.parse(item.issueTime) > Date.parse(item.updateTime))) throw fail('WARNING_INVALID')
  }
  const fire = raw.WFIRE
  if (fire && !['WFIRER', 'WFIREY'].includes(fire.code)) throw fail('WARNING_INVALID')
  return { redFireActive: Boolean(fire && fire.code === 'WFIRER' && fire.actionCode !== 'CANCEL'), warnings: raw }
}
export async function readWarnings({ request = fetch, now = () => new Date(), mode = 'live', fixtureWarnings, signal } = {}) {
  const timeout = AbortSignal.timeout(10000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let raw
  if (mode !== 'live') {
    const at = new Date(now()).toISOString()
    raw = fixtureWarnings ? typeof fixtureWarnings === 'function' ? fixtureWarnings() : fixtureWarnings : { WFIRE: { name: 'Fire Danger Warning', code: 'WFIRER', type: 'Red', actionCode: 'ISSUE', issueTime: at, updateTime: at } }
  } else {
    const response = await request(WARNING_URL, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'error', signal: combined })
    if (!response.ok) { await response.body?.cancel?.(); throw fail('WARNING_HTTP') }
    if (Number(response.headers?.get?.('content-length')) > 32768) { await response.body?.cancel?.(); throw fail('WARNING_TOO_LARGE') }
    let text = '', size = 0
    if (response.body?.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 32768) { await reader.cancel(); throw fail('WARNING_TOO_LARGE') }; text += decoder.decode(chunk.value, { stream: true }) }; text += decoder.decode() } finally { reader.releaseLock() }
    } else text = await response.text()
    if (Buffer.byteLength(text) > 32768) throw fail('WARNING_TOO_LARGE')
    try { raw = JSON.parse(text) } catch { throw fail('WARNING_INVALID') }
  }
  const obtainedAt = new Date(now()).toISOString(), parsed = parseWarnings(raw, obtainedAt)
  if (combined.aborted) throw fail('WARNING_CANCELLED')
  const rawJson = JSON.stringify(raw), text = 'HKO warnsum complete JSON snapshot:\n' + rawJson
  return { title: mode === 'live' ? '香港天文台警告摘要（完整JSON）' : '【虚构】天文台警告协议样例', url: WARNING_URL, text, rawJson,
    obtainedAt, publishedAt: null, sourceMode: mode === 'live' ? 'live' : 'replay', fixture: mode !== 'live', referenceable: true,
    contentHash: createHash('sha256').update(text).digest('hex'), language: 'en', weatherWarning: { ...parsed, completeSnapshot: true, observationMeaning: 'system-retrieval-time' } }
}
export function createWeatherWarningTool({ request, now, mode, onEvidence, fixtureWarnings } = {}) {
  return { toolId: 'get_weather_warning', version: 1, timeoutMs: 12000, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    description: '读取香港天文台当前完整警告JSON并保存原文。当前状态不是未来结果；只支持固定官方URL，无须API Key，不可读取任意地址。',
    async execute(args, context = {}) {
      try {
        if (!args || Object.keys(args).length || typeof onEvidence !== 'function') throw fail('WARNING_ARGUMENTS')
        const record = await readWarnings({ request, now, mode, fixtureWarnings, signal: context.signal })
        if (context.signal?.aborted) throw fail('WARNING_CANCELLED')
        const receipt = await onEvidence(record, context), evidenceId = typeof receipt === 'string' ? receipt : receipt?.evidenceId
        if (context.signal?.aborted) throw fail('WARNING_CANCELLED')
        if (!evidenceId) throw fail('WARNING_SAVE_FAILED')
        return { status: 'ok', data: { ...record, evidenceId }, evidenceIds: [evidenceId], observedAt: record.obtainedAt, summary: '完整警告快照已保存；仅代表取得时状态，不代表未来结果。', error: null, usage: { providerRequests: 0, publicRequests: mode === 'live' ? 1 : 0 } }
      } catch (error) {
        return { status: 'error', data: null, evidenceIds: [], observedAt: new Date(now?.() || new Date()).toISOString(), summary: '未取得有效警告原文，不能将失败判为没有警告。', error: { code: error.warningCode || 'WARNING_UNAVAILABLE', message: '警告来源不可核验。', retryable: false }, usage: null }
      }
    } }
}
