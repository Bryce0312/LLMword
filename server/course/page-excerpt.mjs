// Select only contiguous source text. Location hints never synthesize quotes or
// turn a search snippet into evidence; the caller still persists the excerpt.
const chars = (value) => Array.from(value)
const clip = (value, max) => chars(value).slice(0, max).join('')
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function boilerplate(value) {
  // Match only obvious interface/promotion prefixes. The original body remains
  // untouched, including any lines excluded from these optional citation hints.
  const plain = value.replace(/^[^\p{L}\p{N}]+/u, '')
  return /^(?:black friday|cyber monday)\b.*\b(?:off|sale|discount|deal)\b/i.test(plain) ||
    /^(?:skip to (?:main )?content|log ?in|sign (?:in|up)|register|open app|download (?:the )?app|see all stories|menu|navigation|home)\s*(?:[|·:—-].*)?$/i.test(plain) ||
    /^(?:subscribe(?: now| for| to continue| to get)?\b|subscription (?:plans|options)|get (?:real[- ]time )?alerts\b|don.t miss out\b|cookie (?:policy|settings|preferences)|privacy preference center|manage (?:cookies|consent preferences)|we use cookies\b|this (?:website|site) uses cookies\b|when you visit any website, it may store|by clicking .accept all)/i.test(plain) ||
    /^(?:登录|登入|注册|立即订阅|订阅以|下载(?:客户端|应用)|打开应用|跳至(?:主要)?内容|返回首页|隐私偏好设置|管理(?:Cookie|饼干|同意偏好)|(?:本网站|本站)使用\s*(?:Cookie|饼干))/i.test(plain)
}

function citationHintsFor(text, focusAt) {
  const candidates = [], seen = new Set()
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    if (boilerplate(line[0].trim())) continue
    // Sentence boundaries retain the actual punctuation. Decimal points do not
    // split prices, and every selected value remains a contiguous source slice.
    const pieces = [...line[0].matchAll(/[\s\S]*?(?:[。！？]+|[.!?]+(?=\s|$)|$)/gu)].filter(part => part[0].trim())
    for (const part of pieces) {
      const raw = part[0], leading = raw.length - raw.trimStart().length
      let value = raw.trim(), start = line.index + part.index + leading
      if (boilerplate(value)) continue
      if (chars(value).length > 240 && focusAt !== null && focusAt >= start && focusAt < start + value.length) {
        const offset = Math.max(0, focusAt - start - 60)
        value = value.slice(offset); start += offset
      }
      value = clip(value, 240)
      const key = value.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()
      if (chars(value).length < 8 || seen.has(key)) continue
      const numericCount = (value.match(/\d+(?:[.,]\d+)*/g) || []).length
      if (!/[\p{L}]/u.test(value) && numericCount < 2) continue
      seen.add(key)
      const assetValue = numericCount && /\b(?:USD|USDT|NASDAQ|NYSE|NVDA|BTC|ETH|price|close|revenue|earnings)\b|[$€£¥￥]|股价|收盘|营收|收入|利润/i.test(value)
      const sentence = /[。！？.!?][”’"']?\s*$/.test(value)
      const distance = focusAt === null ? Infinity : focusAt < start ? start - focusAt : Math.max(0, focusAt - start - value.length)
      const score = (assetValue ? 50 : numericCount >= 3 ? 45 : sentence ? 30 : numericCount ? 20 : 10) +
        (focusAt !== null && distance === 0 ? 45 : 0) + Math.max(0, 24 - Math.floor(distance / 20))
      candidates.push({ value, start, score })
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 3).map(item => item.value)
}

export function unreadablePageReason(text, title = '') {
  const head = text.trim().slice(0, 1600)
  const caption = title.trim()
  if (/^(?:your )?browser (?:is )?(?:unsupported|not supported)\b/i.test(caption) ||
    /^(?:your )?browser (?:is )?(?:unsupported|not supported)\b/i.test(head)) return 'unsupported-browser'
  if (/^(?:just a moment|access denied|verify (?:that )?you are human|checking your browser|captcha)\b/i.test(caption) && head.length < 1600 ||
    /^(?:please )?enable javascript(?: and cookies)? (?:to continue|to view)/i.test(head) ||
    /^(?:please )?(?:verify (?:that )?you are human|complete the captcha)\b/i.test(head)) return 'access-barrier'
  return null
}

export function selectPageExcerpt(completeText, focus, maxCharacters = 4000) {
  let matchAt = focus ? completeText.toLowerCase().indexOf(focus.toLowerCase()) : 0
  let focusMatch = focus ? 'exact' : 'not-requested'
  // A provider may keep line breaks where a query contains spaces. Match their
  // positions without changing any character in the resulting evidence text.
  if (focus && matchAt < 0 && /\s/.test(focus)) {
    const normalized = escape(focus.trim()).replace(/\s+/g, '\\s+')
    const found = new RegExp(normalized, 'i').exec(completeText)
    if (found) { matchAt = found.index; focusMatch = 'whitespace' }
  }
  const focusMatched = !focus || matchAt >= 0
  let excerptStrategy = focus ? 'focused' : 'start'
  if (!focusMatched) {
    focusMatch = 'not-found'
    const terms = [...new Set(focus.match(/[A-Za-z0-9][A-Za-z0-9.$%-]{1,}|[\u3400-\u9fff]{2,}/g) || [])]
    const candidates = terms.map(term => completeText.toLowerCase().indexOf(term.toLowerCase())).filter(at => at >= 0)
    matchAt = candidates.length ? Math.min(...candidates) : 0
    excerptStrategy = candidates.length ? 'keyword-fallback' : 'start-fallback'
  }
  const excerptStart = Math.max(0, matchAt - 300)
  const text = clip(completeText.slice(excerptStart), maxCharacters)
  const originalCharacters = chars(completeText).length
  const citationHints = citationHintsFor(text, focus && focusMatched ? matchAt - excerptStart : null)
  return { text, originalCharacters, excerptStart, focus: focus || null, focusMatched,
    focusMatch, excerptStrategy, citationHints, truncated: excerptStart > 0 || chars(text).length < originalCharacters }
}
