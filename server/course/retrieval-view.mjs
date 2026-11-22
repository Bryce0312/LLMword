/** Local lexical selection only. Offsets and quotes always refer to unchanged stored text. */
export function terms(query) {
  const value = String(query || '').normalize('NFKC').toLowerCase()
  const words = value.match(/[a-z0-9]{2,}/g) || []
  for (const run of value.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = Array.from(run)
    if (chars.length === 1) words.push(run)
    for (let i = 0; i + 1 < chars.length; i++) words.push(chars[i] + chars[i + 1])
  }
  return [...new Set(words)].slice(0, 80)
}
export function evidenceView(record, query, { limit = 1200 } = {}) {
  if (typeof record?.text !== 'string' || record.text.length <= limit || record.evidenceKind !== 'page_content') return structuredClone(record)
  const body = record.text, keywords = terms(query), width = Math.floor(limit / 3)
  const windows = []
  for (let start = 0; start < body.length; start += width) {
    // Do not split UTF-16 surrogate pairs. Return exact slices, never normalized quotes.
    if (start && /[\uDC00-\uDFFF]/.test(body[start])) start++
    let end = Math.min(body.length, start + width)
    if (end < body.length && /[\uDC00-\uDFFF]/.test(body[end])) end--
    const text = body.slice(start, end), normalized = text.normalize('NFKC').toLowerCase()
    windows.push({ start, end, text, score: keywords.filter(word => normalized.includes(word)).length })
  }
  // Keep the lead and two relevant distant windows: lexical relevance is not stance classification.
  const picked = [windows[0], ...windows.slice(1).sort((a,b) => b.score-a.score || a.start-b.start).slice(0, 2)].sort((a,b) => a.start-b.start)
  return { ...structuredClone(record), text: picked.map(w => w.text).join('\n[省略；可用fetch_page的focus展开]\n'),
    excerpts: picked.map(({start,end}) => ({ start, end })), modelView: 'lexical-excerpts-v1',
    storedCharacters: body.length, modelViewPartial: true,
    expansion: 'fetch_page(url, focus): 返回定位词附近的已保存原文；不要跨省略标记引用。' }
}
export function requestReservation(input) {
  // Conservative admission bound, NOT measured model tokens (especially for CJK).
  return Buffer.byteLength(JSON.stringify(input.messages || []), 'utf8') + Buffer.byteLength(JSON.stringify(input.tools || []), 'utf8') + (input.maxTokens || 0) + 2048
}

export function focusedEvidenceView(record, focus, limit = 1200) {
  const at = record.text.toLowerCase().indexOf(focus.toLowerCase())
  if (at < 0) return null
  let start = Math.max(0, at - 200), end = Math.min(record.text.length, start + limit)
  if (/[\uDC00-\uDFFF]/.test(record.text[start])) start++
  if (end < record.text.length && /[\uDC00-\uDFFF]/.test(record.text[end])) end--
  return { ...record, text: record.text.slice(start, end), modelView: 'focused-excerpt-v1', modelViewPartial: start > 0 || end < record.text.length, excerpts: [{start,end}], cached: true }
}
