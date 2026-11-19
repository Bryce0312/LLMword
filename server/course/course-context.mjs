import { getAgentCatalog } from '../domain/agent-catalog.mjs'

export const COURSE_ROLE_IDS = Object.freeze(getAgentCatalog().map((role) => role.agentSpecId))
export const requiresWeatherObservation = (request) => request.mode !== 'strict' && /下雨|降雨|降水|\brain(?:fall)?\b/i.test(request.question || '')
export const roleCatalogue = () => getAgentCatalog().map(({ agentSpecId, name, instructions }) => ({ roleId: agentSpecId, name, focus: instructions,
  availability: 'web-materials', specializedToolsAvailable: false }))
export function suggestedRoles(question) {
  if (/比特币|BTC|ETH|以太|股价|价格|股票|黄金|金价|白银|银价|price|bitcoin|\b(?:gold|silver)\b/i.test(question)) return ['market', 'statistics', 'verification']
  if (/推特|发帖|社交|twitter|tweet|elonmusk|马斯克/i.test(question)) return ['social', 'people', 'verification']
  if (/CEO|担任|任职|管理层|辞职/i.test(question)) return ['people', 'official', 'verification']
  if (/政策|关税|许可|制裁|policy|tariff/i.test(question)) return ['official', 'industry', 'verification']
  return ['official', 'timeline', 'verification']
}
const iso = (value) => new Date(value).toISOString()
export function hasTodayCalendarDeadline(question = '') {
  if (!/今天|今日|\btoday\b/i.test(question)) return false
  // Only the unqualified calendar word is deterministic here. Explicit clocks,
  // dates and other day qualifiers remain on the existing model/strict path.
  return !/20\d\d[-/年]\d{1,2}|\d{1,2}月\d{1,2}|\d{1,2}[:：]\d{2}|[零〇一二两三四五六七八九十\d]{1,3}\s*(?:点|時|时)(?!间|候)|\b\d{1,2}\s*(?:am|pm)\b|上午|下午|晚上|凌晨|中午|早上|明天|后天|昨天|\btomorrow\b|\byesterday\b/i.test(question)
}
function zonedDayEnd(createdAt, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const fields = (at) => Object.fromEntries(formatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  const date = fields(createdAt)
  const wallClock = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day), 23, 59, 59, 999)
  let instant = wallClock
  // Intl supplies the IANA offset at the candidate instant, including DST.
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = fields(instant)
    const offset = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second)) - Math.floor(instant / 1000) * 1000
    const adjusted = wallClock - offset
    if (adjusted === instant) return iso(instant)
    instant = adjusted
  }
  return iso(instant)
}
export function resolveRequestDeadline(request, { preserveContract = true } = {}) {
  if (request.strict?.targetAt) return iso(request.strict.targetAt)
  if (preserveContract && request.normalized?.targetAt) return iso(request.normalized.targetAt)
  if (hasTodayCalendarDeadline(request.question)) return zonedDayEnd(request.createdAt, request.strict?.timezone || request.timezone || 'Asia/Shanghai')
  return new Date(Date.parse(request.createdAt) + request.horizonHours * 3_600_000).toISOString()
}
function localTime(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const offset = fields.timeZoneName.replace('GMT', 'UTC')
  return { offset, label: `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second} (${timezone}, ${offset})` }
}
export function makeTimeContext({ now, createdAt, targetAt, forecastClosesAt = targetAt, timezone = 'Asia/Shanghai' }) {
  const local = localTime(targetAt, timezone)
  return { nowUtc: iso(now), nowLocalLabel: localTime(now, timezone).label, windowStartsAtUtc: iso(createdAt),
    windowStartsAtLocalLabel: localTime(createdAt, timezone).label, targetAtUtc: iso(targetAt), targetAtLocalLabel: local.label,
    forecastClosesAtUtc: iso(forecastClosesAt), forecastClosesAtLocalLabel: localTime(forecastClosesAt, timezone).label,
    timezone, utcOffset: local.offset, authority: 'UTC instant is authoritative; local labels are server-generated and display-only.' }
}
export function requestTime(request, now) {
  const targetAt = resolveRequestDeadline(request)
  return makeTimeContext({ now, createdAt: request.createdAt, targetAt, forecastClosesAt: request.normalized?.forecastClosesAt || targetAt,
    timezone: request.normalized?.timezone || request.strict?.timezone || request.timezone })
}
export const timedQuestion = (question, context, temporalPolicy) => `${question}（${temporalPolicy === 'at_target' ? '判定时点' : '观察至'}：${context.targetAtLocalLabel}）`
export function presetAssumptions(question, context) {
  const assumptions = [`默认观察窗口从本次创建 ${context.windowStartsAtLocalLabel} 至 ${context.targetAtLocalLabel}；用户明确指定的条件优先。`]
  if (/马斯克|elon\s*musk|elonmusk/i.test(question) && /推特|发帖|tweet|post/i.test(question)) assumptions.push('“马斯克发推特”默认指 Elon Musk 的 X 公开账号 @elonmusk；包括原创、回复、引用及转发，私信不计。身份和实际动态仍需联网核验。')
  if (/比特币|BTC|bitcoin/i.test(question) && /回升|上涨|涨|rise|recover|up/i.test(question)) assumptions.push('“回升”默认指目标时点 BTC-USD 价格高于本轮实际取得的最近可验证现价，不另设任意涨幅阈值；拿不到数值基准时只作有资料依据的条件性方向估计，不计分。')
  return assumptions
}
