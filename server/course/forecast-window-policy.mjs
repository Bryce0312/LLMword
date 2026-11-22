export const FORECAST_WINDOW_POLICY = 'sealed-forecast-window-v1'
const number = value => {
  if (/^\d+$/u.test(value)) return Number(value)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value === '十') return 10
  if (value.includes('十')) { const [a, b] = value.split('十'); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0) }
  return digits[value]
}
const enabled = request => request?.forecastWindowPolicy === FORECAST_WINDOW_POLICY
const targetOf = (request, time) => time?.targetAtUtc || request.tradingHorizon?.targetAt || request.normalized?.targetAt
function failure(path, declaration, request, time) {
  return { code: 'INTAKE_TARGET_MISMATCH', path, declaration,
    message: `本题期限已封存为${targetOf(request, time)}（${time?.targetAtLocalLabel || request.timezone}）` +
      `${request.tradingHorizon ? `，所选${request.tradingHorizon.tradingDays}个交易日` : ''}。${path}另行声明了“${declaration}”，不能把原问的“未来”改成其他窗口。请同时重写题意、解释、假设和研究员任务，所有预测只针对该截止；历史回看可以保留并明确标为历史。targetAt必须原样回显服务端值，不改概率或偷偷替换日期。` }
}

/** Narrow forecast declarations only; source quotations and limitations are not scanned. */
export function forecastWindowTextIssue(entries, request, time) {
  if (!enabled(request)) return null
  const target = targetOf(request, time), at = Date.parse(target), start = Date.parse(request.createdAt)
  if (!Number.isFinite(at) || !Number.isFinite(start)) return failure('timeContext', '服务端期限缺失', request, time)
  const targetDates = new Set([target.slice(0, 10), time?.targetAtLocalLabel?.slice(0, 10)].filter(Boolean))
  const firstDate = [request.createdAt.slice(0, 10), time?.windowStartsAtLocalLabel?.slice(0, 10)].filter(Boolean).sort()[0]
  const finalDate = [...targetDates].sort().at(-1)
  const hours = (at - start) / 3600000
  for (const { path, text } of entries) {
    if (typeof text !== 'string') continue
    const durations = [
      ...text.matchAll(/(?:未来|未來|今后|今後|窗口(?:设为|設為|为|為|是)|期限(?:为|為|是))\s*([零〇一二两兩三四五六七八九十\d]+)\s*(?:个|個)?\s*(交易日|小时|小時|天|日|周|星期|个月|個月|月|年)(?:内|內|以内|以內|之内|之內|期间|期間)?/gu),
      ...text.matchAll(/\b(?:within(?:\s+the\s+next)?|over\s+the\s+next|in\s+the\s+next|next|forecast\s+(?:window|horizon)\s*(?:is|:)?|window\s*(?:is|:))\s*(\d+)\s*(trading\s+days?|hours?|days?|weeks?|months?|years?)\b/giu),
    ]
    for (const match of durations) {
      const count = number(match[1]), unit = match[2].toLowerCase()
      if (!Number.isFinite(count) || count <= 0) continue
      if (/历史|歷史|回看|回溯|过去|過去|曾|historical|past|previous/iu.test(text.slice(Math.max(0, match.index - 18), match.index)) && !/未来|未來|今后|今後|next|forecast/iu.test(match[0])) continue
      const clause = text.slice(0, match.index).split(/[。；;，,\n]/u).at(-1) + text.slice(match.index).split(/[。；;，,\n]/u)[0]
      // A company's guidance horizon is source context, not this forecast's
      // horizon. Only an explicit window declaration overrides that exemption.
      if (/指引|回购|回購|债券|債券|锁定|鎖定|guidance|buyback|repurchase|bond|lock[- ]up/iu.test(clause) && !/窗口|预测期限|預測期限|forecast\s+(?:window|horizon)|prediction\s+horizon/iu.test(clause)) continue
      if (/年/u.test(unit) && count >= 1900) continue
      if (/交易日|trading/u.test(unit)) {
        if (request.tradingHorizon && count !== request.tradingHorizon.tradingDays) return failure(path, match[0], request, time)
      } else {
        const scale = /小时|小時|hour/u.test(unit) ? 1 : /年|year/u.test(unit) ? 8766 : /月|month/u.test(unit) ? 730.5 : /周|星期|week/u.test(unit) ? 168 : 24
        if (Math.abs(count * scale - hours) > 24) return failure(path, match[0], request, time)
      }
    }
    for (const match of text.matchAll(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/gu)) {
      const before = text.slice(Math.max(0, match.index - 100), match.index).split(/[。；;，,\n]/u).at(-1), after = text.slice(match.index + match[0].length, match.index + match[0].length + 8)
      if (!/(?:窗口|目标|目標|预测|預測|观察|觀察|期限|截止|截至|within|until|deadline|target|至|到)[^。；;\n]{0,30}$/iu.test(before) && !/^\s*(?:前|之前|以前)/u.test(after)) continue
      if (/回购|回購|股东|股東|债券|債券|锁定|鎖定|buyback|repurchase|bond|lock[- ]up/iu.test(before) && !/预测窗口|預測窗口|观察窗口|觀察窗口/u.test(before)) continue
      const date = match[0].replaceAll('/', '-').split('-').map((part, index) => index ? part.padStart(2, '0') : part).join('-')
      if (date < firstDate) continue
      const explicitEnd = /(?:目标(?:时点|日期)?(?:为|為|是)?|目標(?:時點|日期)?(?:為|是)?|截止(?:时间|時間|日期)?(?:为|為|是|到)?|截至|deadline(?:\s+is)?|target(?:\s+is)?|until|至|到)[\s:：]*$/iu.test(before)
      if (!explicitEnd && date >= firstDate && date <= finalDate) continue
      if (!targetDates.has(date)) return failure(path, match[0], request, time)
    }
  }
  return null
}

export function intakeWindowIssue(args, request, time) {
  if (!enabled(request)) return null
  if (args?.targetAt !== targetOf(request, time)) return failure('targetAt', args?.targetAt || '未回显截止时间', request, time)
  return forecastWindowTextIssue([
    ...['question', 'object', 'interpretation'].map(path => ({ path, text: args[path] })),
    ...(args.defaultAssumptions || []).map((text, index) => ({ path: `defaultAssumptions/${index}`, text })),
    ...(args.assignments || []).flatMap((item, index) => ['objective', 'reason'].map(key => ({ path: `assignments/${index}/${key}`, text: item[key] }))),
  ], request, time)
}
