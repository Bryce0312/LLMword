export const MODEL_PRICING_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const MAX_PRICING_BODY_BYTES = 512 * 1024
const UNIT_TOKENS = 1000000
const failure = code => Object.assign(new Error(code), { code })

const textOf = html => html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
  .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/giu, '')
  .replace(/<[^>]+>/gu, ' ').replace(/&(?:nbsp|#160|#xA0);/giu, ' ')
  .replace(/&(?:dollar|#36|#x24);/giu, '$').replace(/&amp;/giu, '&').replace(/\s+/gu, ' ').trim()

// The published table uses row/col spans. Expand those before matching the exact
// model column, so a neighbouring model or another API's prices cannot be used.
function tableGrid(html) {
  const grid = []
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
  if (rows.length > 200) throw failure('PRICING_FORMAT_CHANGED')
  for (const [rowIndex, row] of rows.entries()) {
    grid[rowIndex] ||= []
    let column = 0
    for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/giu)) {
      while (grid[rowIndex][column] !== undefined) column++
      const span = name => {
        const match = cell[1].match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'iu'))
        const value = match ? Number(match[1]) : 1
        if (!Number.isInteger(value) || value < 1 || value > 30) throw failure('PRICING_FORMAT_CHANGED')
        return value
      }
      const rowSpan = span('rowspan'), colSpan = span('colspan')
      if (column + colSpan > 30 || rowIndex + rowSpan > 230) throw failure('PRICING_FORMAT_CHANGED')
      const text = textOf(cell[2])
      for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
        grid[r] ||= []
        for (let c = column; c < column + colSpan; c++) {
          if (grid[r][c] !== undefined) throw failure('PRICING_FORMAT_CHANGED')
          grid[r][c] = text
        }
      }
      column += colSpan
    }
  }
  return grid
}

function parsePriceTable(html, model) {
  let modelFound = false
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
    const grid = tableGrid(table[1])
    const header = grid.find(row => row.includes('MODEL') && row.includes(model))
    if (!header) continue
    modelFound = true
    const column = header.indexOf(model)
    const rateTiers = { offPeak: {}, peak: {} }
    for (const row of grid) {
      if (!row.some(cell => /^PRICING\b/u.test(cell))) continue
      const metric = row.includes('1M INPUT TOKENS (CACHE HIT)') ? 'inputCacheHit'
        : row.includes('1M INPUT TOKENS (CACHE MISS)') ? 'inputCacheMiss'
          : row.includes('1M OUTPUT TOKENS') ? 'output' : null
      const period = row.includes('OFF-PEAK') ? 'offPeak' : row.includes('PEAK') ? 'peak' : null
      if (!metric || !period) continue
      const price = /^\$\s*(\d+(?:\.\d+)?)$/u.exec(row[column] || '')
      if (!price || !Number.isFinite(Number(price[1])) || rateTiers[period][metric] !== undefined) throw failure('PRICING_FORMAT_CHANGED')
      rateTiers[period][metric] = Number(price[1])
    }
    if (!['offPeak', 'peak'].every(period => ['inputCacheHit', 'inputCacheMiss', 'output'].every(metric => Number.isFinite(rateTiers[period][metric])))) throw failure('PRICING_FORMAT_CHANGED')
    const schedule = textOf(html).match(/Peak hours are\s+(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})\s+and\s+(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})\s+UTC,\s*Monday through Friday,\s*excluding Chinese public holidays/iu)
    if (!schedule) throw failure('PRICING_FORMAT_CHANGED')
    return { rateTiers, schedule: `UTC 周一至周五 ${schedule[1]}–${schedule[2]}、${schedule[3]}–${schedule[4]} 为高峰时段（中国法定节假日除外）；其余时间为空闲时段。未自动判断节假日，实际扣费以服务商账单为准。` }
  }
  throw failure(modelFound ? 'PRICING_FORMAT_CHANGED' : 'MODEL_PRICE_NOT_LISTED')
}

async function readLimitedBody(response, signal) {
  const length = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(length) && length > MAX_PRICING_BODY_BYTES) throw failure('PRICING_BODY_TOO_LARGE')
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []; let bytes = 0
    const stop = () => { Promise.resolve(reader.cancel()).catch(() => {}) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_PRICING_BODY_BYTES) { await reader.cancel(); throw failure('PRICING_BODY_TOO_LARGE') }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally { signal.removeEventListener('abort', stop); reader.releaseLock() }
  }
  if (typeof response.text !== 'function') throw failure('PRICING_FORMAT_CHANGED')
  const body = await response.text()
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_PRICING_BODY_BYTES) throw failure('PRICING_BODY_TOO_LARGE')
  return body
}

const reasons = {
  INVALID_PRICING_CONNECTION: '模型连接地址无效，无法核验定价。',
  MODEL_PRICE_NOT_LISTED: '官方公开价目未列出这个精确模型名称，未套用其他模型价格。',
  PRICING_FORMAT_CHANGED: '官方价目格式或计价规则无法可靠识别，暂不显示价格。',
  PRICING_BODY_TOO_LARGE: '公开价格页超过读取大小上限，暂不显示价格。',
  PRICING_REDIRECTED: '公开价格页发生重定向，未继续转发请求或使用旧价格。',
  PRICING_CONTENT_TYPE: '公开价格来源未返回 HTML 价目，暂不显示价格。',
  PRICING_TIMEOUT: '获取官方最新价格超时，暂不显示价格。',
  PRICING_UNAVAILABLE: '无法读取官方最新价格，暂不显示价格。',
}

/** Public list pricing only. This function never accepts or sends account keys,
 * never calls the model, and never falls back to remembered or hardcoded prices. */
export async function fetchModelPricing({ url, model } = {}, { request = fetch, now = () => new Date(), timeoutMs = 8000 } = {}) {
  const timestamp = typeof now === 'function' ? now() : now
  const checkedAt = new Date(timestamp).toISOString()
  const result = { status: 'unavailable', model: typeof model === 'string' ? model.trim() : '', currency: null, unitTokens: UNIT_TOKENS,
    inputCacheHit: null, inputCacheMiss: null, output: null, ratePeriod: null, ratePeriodLabel: null,
    rateTiers: null, schedule: null, sourceUrl: null, checkedAt, freshness: 'unavailable', reason: null }
  const unavailable = (code, reason = reasons[code] || reasons.PRICING_UNAVAILABLE) => ({ ...result, reasonCode: code, reason })
  let endpoint
  try {
    endpoint = new URL(url)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !result.model || result.model.length > 200) throw failure('INVALID_PRICING_CONNECTION')
  } catch { return unavailable('INVALID_PRICING_CONNECTION') }
  if (endpoint.origin !== 'https://api.deepseek.com') {
    return unavailable('PRICING_NOT_PUBLISHED', endpoint.hostname === 'genai.comp.polyu.edu.hk'
      ? '校园网关没有已核验的公开收费来源；DeepSeek 官方价目不能代表校园实际收费，请向学校服务方确认。'
      : '这个自定义服务没有已核验的公开收费来源，不能套用 DeepSeek 官方价格。')
  }
  result.sourceUrl = MODEL_PRICING_SOURCE_URL
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof request !== 'function') return unavailable('PRICING_UNAVAILABLE')
  const controller = new AbortController()
  let timer, timedOut = false
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(failure('PRICING_TIMEOUT')) }, timeoutMs)
    })
    const html = await Promise.race([Promise.resolve().then(async () => {
      const response = await request(MODEL_PRICING_SOURCE_URL, { method: 'GET', headers: { Accept: 'text/html' }, redirect: 'error', signal: controller.signal })
      if (response?.redirected || response?.url && response.url !== MODEL_PRICING_SOURCE_URL || response?.status >= 300 && response?.status < 400) throw failure('PRICING_REDIRECTED')
      if (!response || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) throw failure('PRICING_UNAVAILABLE')
      const type = response.headers?.get?.('content-type')
      if (type && !/^(?:text\/html|application\/xhtml\+xml)\b/iu.test(type)) throw failure('PRICING_CONTENT_TYPE')
      return await readLimitedBody(response, controller.signal)
    }), timeout])
    const parsed = parsePriceTable(html, result.model)
    return { ...result, status: 'available', currency: 'USD', ratePeriod: 'tiered', ratePeriodLabel: '分时计价', ...parsed, freshness: 'fresh', reason: null, reasonCode: null }
  } catch (error) {
    return unavailable(timedOut ? 'PRICING_TIMEOUT' : reasons[error?.code] ? error.code : 'PRICING_UNAVAILABLE')
  } finally { clearTimeout(timer); controller.abort() }
}
