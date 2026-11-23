import { readFileSync } from 'node:fs'
import { domainFailure } from '../domain/contracts.mjs'

export const TRADING_DAY_OPTIONS = Object.freeze([1, 3, 5, 20])
export const DEFAULT_TRADING_MARKET = 'HK'
export const TRADING_DAY_CAPABILITIES = Object.freeze({ options: TRADING_DAY_OPTIONS, default: 5, defaultMarket: DEFAULT_TRADING_MARKET })
let bundledCalendars
const calendars = () => bundledCalendars ||= JSON.parse(readFileSync(new URL('./calendars/market-holidays.json', import.meta.url), 'utf8'))
const fail = (code, message) => domainFailure(code, message, 400)
const labels = { CN: 'A股', HK: '港股', US: '美股（NYSE日历）' }
const genericSymbols = new Set(['ETF','LOF','FOF','QDII','QFII','REIT','REITS','USD','CNY','RMB','HKD','CN','HK','US','USA','NYSE','NASDAQ','AMEX','SSE','SZSE','HKEX','SH','SZ','SS','SEHK','XSHG','XSHE','XHKG','XNYS','XNAS','BTC','ETH','A','B','C','D','E','I','R','EPS','NAV','PE','PB','ROE','ROA','ROI','CAGR','EBIT','EBITDA','GDP','CPI','PPI','IPO','AI'])

// A deliberately narrow calendar hint, not a general entity resolver. Unknown
// names and multi-company comparisons keep the existing ambiguity/default rules.
function issuerCalendarHint(question) {
  const name = /英伟达|苹果(?:公司)?|\bNVIDIA(?:\s+Corporation)?\b|\bApple(?:\s+Inc\.?)?\b/giu
  if (!name.test(question)) return null
  const remainder = question.replace(name, '')
    .replace(/请|帮我|预测|分析|研究|看看|看一下|公司|普通股|股票|股价|走势|趋势|未来|交易日|上涨|下跌|涨跌|会不会|是否|能否|会|涨|跌|的|吗|如何|怎么样/gu, '')
    .replace(/\b(?:will|the|stock|price|trend|forecast|outlook|rise|fall|up|down|next|trading|days?|weeks?)\b/giu, '')
    .replace(/[\p{N}\p{P}\p{Z}\s一二三四五六七八九十个天日周月]+/gu, '')
  return remainder ? null : 'US'
}

/** The symbol selects a calendar only; it does not verify a security's identity or listing. */
export function identifyTradingMarket(question = '', market) {
  if (market !== undefined && !Object.hasOwn(labels, market)) throw fail('INVALID_TRADING_MARKET', '市场上下文须为CN、HK或US。')
  const explicit = new Set()
  if (/(?<![A-Za-z])A\s*股|沪深|上交所|深交所|上海证券|深圳证券|\b(?:SSE|SZSE|XSHG|XSHE)\b|\b(?:CN|SH|SZ)\s*[:：]\s*\d{6}\b|\b(?:SH|SZ)\d{6}\b|\b\d{6}\.(?:SH|SZ|SS)\b/iu.test(question)) explicit.add('CN')
  if (/港股|香港|港交所|联交所|\b(?:HKEX|SEHK|XHKG)\b|\bHK\s*[:：]?\s*\d{1,5}\b|\b\d{1,5}\.HK\b/iu.test(question)) explicit.add('HK')
  if (/美股|美国(?:市场|股票|证券)|纽交所|纳斯达克|\b(?:NYSE|NASDAQ|NYSEARCA|AMEX|XNYS|XNAS)\b|\bUS\s*[:：]\s*[A-Z]|\b[A-Z][A-Z0-9.-]{0,9}\.US\b/iu.test(question)) explicit.add('US')
  if (/(?<![A-Za-z0-9_])(?:AAPL|NVDA)(?![A-Za-z0-9_])/iu.test(question)) explicit.add('US')
  // Codes remain signals even beside a market name, so conflicting listings cannot silently win.
  if (/(?<!\d)\d{6}(?!\d)/u.test(question)) explicit.add('CN')
  if (/^\d{4,5}$/u.test(question.trim())) explicit.add('HK')
  const symbols = [...question.matchAll(/(?<![\p{L}\p{N}_])[A-Z]{1,5}(?:[.-][A-Z])?(?![\p{L}\p{N}_])/gu)].map(match => match[0]).filter(symbol => !genericSymbols.has(symbol))
  if (symbols.length || /^[a-z]{1,5}$/u.test(question.trim()) && !genericSymbols.has(question.trim().toUpperCase())) explicit.add('US')
  if (explicit.size > 1) throw fail('TRADING_MARKET_CONFLICT', '标的包含多个市场，请只保留一个上市市场或明确单一证券代码。')
  const detected = [...explicit][0]
  if (detected && market && detected !== market) throw fail('TRADING_MARKET_CONFLICT', '标的明确市场与重试市场上下文不一致，请按目标市场新建任务。')
  // Explicit market context outranks a name-only hint. In particular, a user
  // selecting HK must not be silently rewritten because the name says NVIDIA.
  const nameHint = !detected && !market ? issuerCalendarHint(question) : null
  const selected = detected || market || nameHint || DEFAULT_TRADING_MARKET
  const assumptions = [detected ? `按标的中明确的市场或代码选择${labels[selected]}交易日历；证券身份和上市地仍需核验。`
    : market ? `标的未明确交易所，沿用${labels[selected]}市场上下文；这不是上市地已经核验的结论。`
      : nameHint ? '按苹果／Apple或英伟达／NVIDIA名称线索选择美股交易日历；这只是日历线索，证券代码、身份和上市地仍需研究员核验。'
      : '标的未明确市场，按用户选择的默认港股日历计算；跨市场上市名称不据此视为已确认具体证券。']
  return { market: selected, selection: detected ? 'identified' : market ? 'retry-context' : nameHint ? 'name-hint' : 'default', assumptions }
}
export function tradingMarketTimezone(question, market, data = calendars()) {
  const selected = identifyTradingMarket(question, market)
  const calendar = data.markets?.[selected.market]
  if (!calendar) throw fail('TRADING_CALENDAR_UNAVAILABLE', '该市场尚无已核验的交易日历。')
  return calendar.timezone
}
function dateParts(at, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]))
}
const localDate = (at, timezone) => { const parts = dateParts(at, timezone); return `${parts.year}-${parts.month}-${parts.day}` }
function sessionClose(date, close, timezone) {
  if (!/^\d{2}:\d{2}$/u.test(close || '')) throw fail('TRADING_CALENDAR_INVALID', '日历收盘时间格式无效。')
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = close.split(':').map(Number)
  const wall = Date.UTC(year, month - 1, day, hour, minute), expected = `${date} ${close}`
  let instant = wall
  for (let i = 0; i < 5; i++) {
    const parts = dateParts(instant, timezone)
    const offset = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant
    const adjusted = wall - offset
    if (adjusted === instant) break
    instant = adjusted
  }
  const parts = dateParts(instant, timezone)
  if (`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` !== expected) throw fail('TRADING_CALENDAR_INVALID', '日历收盘时刻无法对应到市场时区。')
  return new Date(instant).toISOString()
}

/** Called once inside request creation; persisted sessions never change on resume or calendar updates. */
export function buildTradingHorizon({ question, market, tradingDays, createdAt }, data = calendars()) {
  if (!TRADING_DAY_OPTIONS.includes(tradingDays)) throw fail('INVALID_TRADING_HORIZON', '交易日窗口须为1、3、5或20。')
  if (!Number.isFinite(Date.parse(createdAt))) throw fail('INVALID_TRADING_HORIZON', '交易日窗口缺少有效创建时间。')
  const selected = identifyTradingMarket(question, market), calendar = data.markets?.[selected.market]
  if (!calendar?.timezone || !calendar.close) throw fail('TRADING_CALENDAR_UNAVAILABLE', '该市场尚无已核验的交易日历。')
  const anchorSessionDate = localDate(createdAt, calendar.timezone)
  let cursor = Date.parse(`${anchorSessionDate}T00:00:00.000Z`)
  const sessions = [], sourceYears = new Set()
  while (sessions.length < tradingDays) {
    cursor += 86400000
    const date = new Date(cursor).toISOString().slice(0, 10), year = date.slice(0, 4), schedule = calendar.years?.[year]
    if (!schedule || schedule.coverage && (date < schedule.coverage.from || date > schedule.coverage.to)) throw fail('TRADING_CALENDAR_COVERAGE', `${calendar.label || selected.market}交易日历未覆盖${date}，无法可靠计算该窗口；不能以自然日或仅跳周末替代。`)
    sourceYears.add(year)
    if ([0, 6].includes(new Date(cursor).getUTCDay()) || schedule.closedDates.includes(date)) continue
    const close = schedule.earlyCloses?.[date] || calendar.close
    sessions.push({ date, close, closeAt: sessionClose(date, close, calendar.timezone), earlyClose: Boolean(schedule.earlyCloses?.[date]) })
  }
  const target = sessions.at(-1)
  return { tradingDays, market: selected.market, marketLabel: calendar.label, marketSelection: selected.selection, timezone: calendar.timezone,
    anchorAt: new Date(createdAt).toISOString(), anchorSessionDate, targetSessionDate: target.date, targetAt: target.closeAt, forecastClosesAt: target.closeAt,
    countingRule: 'next-session-excludes-creation-date', countingRuleLabel: `从创建时市场日期之后的下一开市日起计${tradingDays}个交易日，不含创建当日；目标为第${tradingDays}日收盘。`,
    calendarVersion: data.version, calendarSources: [...new Set([...sourceYears].flatMap(year => calendar.years[year].sources || []))], calendarScope: calendar.scope || data.scope || '',
    assumptions: [...selected.assumptions, '仅提供金融标的时，默认研判目标交易日收盘相对本轮可核验基准是否上涨；下跌问法按原文。代码、上市地、证券或基金类型及基准仍需核验，无价格或净值基准仅作不计分条件估计，不编造行情。', calendar.scope || data.scope || '', '已公布的市场日历不核验个股停牌、基金净值估值日或之后临时宣布的停市安排。'].filter(Boolean), sessions }
}
