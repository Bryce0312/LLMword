/** UI metadata formatting only; never parse or rewrite user/model prose. */
export function formatUiDate(raw, { locale = 'zh-CN', timezone, kind = 'date-time' } = {}) {
  const english = locale === 'en'
  if (!raw || Number.isNaN(new Date(raw).valueOf())) return english ? 'Not set' : '尚未设置'
  const options = kind === 'date' ? { dateStyle: 'medium' } : kind === 'time' ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }
  if (timezone) options.timeZone = timezone
  try { return new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', options).format(new Date(raw)) + (timezone ? ' (' + timezone + ')' : '') }
  catch { return String(raw) }
}
