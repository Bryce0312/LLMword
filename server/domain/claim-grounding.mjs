export const groundingPolicy = 'quoted-claims-v1'
export const groundedClaimSchema = { type: 'object', additionalProperties: false, properties: {
  claim: { type: 'string', minLength: 1, maxLength: 1500 }, evidenceIds: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 30, items: { type: 'string', minLength: 1 } },
  basis: { enum: ['fact', 'inference'] }, citations: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
    properties: { evidenceId: { type: 'string', minLength: 1 }, quote: { type: 'string', minLength: 8, maxLength: 600 } }, required: ['evidenceId', 'quote'] } },
}, required: ['claim', 'evidenceIds'] }
const normalize = (text) => String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
const decimalKey = (value) => { const [whole, fraction = ''] = value.split('.'); const integer = whole.replace(/^0+(?=\d)/, ''); const tail = fraction.replace(/0+$/, ''); return integer + (tail ? '.' + tail : '') }
const numbers = (text) => [...normalize(text).replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '').matchAll(/\d+(?:\.\d+)?/g)].map(([value]) => decimalKey(value))
function jsonTokens(text) {
  let content = '', quoted = false, escaped = false
  const positions = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted || !/\s/u.test(char)) { content += char; positions.push(index) }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
    else if (char === '"') quoted = true
  }
  return { content, positions }
}
function actualExcerpt(source, quote) {
  if (!source.weatherWarning?.completeSnapshot && source.evidenceFormat !== 'json') return normalize(source.text).includes(quote) ? quote : null
  if (source.text.includes(quote)) return quote
  const body = jsonTokens(source.text), wanted = jsonTokens(quote).content, index = body.content.indexOf(wanted)
  if (!wanted.includes('"') || index < 0) return null
  return source.text.slice(body.positions[index], body.positions[index + wanted.length - 1] + 1)
}
function numericBody(claim, sources, { readerId, asOf }) {
  const prefix = claim.match(/^截至(?:(\d{4}-\d{2}-\d{2})T)?(\d{2}:\d{2}:\d{2})Z快照[，,:：]?\s*/u)
  if (!prefix) return claim
  const matched = sources.some(source => {
    const observations = source.readObservations || [], own = observations.filter(observation => observation.readerId === readerId)
    const times = readerId ? observations.length ? own.map(item => item.obtainedAt) : [source.obtainedAt] : [source.obtainedAt, ...observations.map(item => item.obtainedAt)]
    return times.some(time => {
      const at = Date.parse(time)
      if (!Number.isFinite(at) || asOf && at > Date.parse(asOf)) return false
      const date = prefix[1] || new Date(at).toISOString().slice(0, 10), stated = Date.parse(date + 'T' + prefix[2] + 'Z')
      return Math.abs(stated - at) < 1000
    })
  })
  return matched ? claim.slice(prefix[0].length) : claim
}
/** Literal excerpt ownership + simple number coverage, not an entailment classifier. */
export function validateGroundedClaims(claims, evidence, { readerId, asOf } = {}) {
  if (!Array.isArray(claims) || !claims.length) throw new Error('结论须提供至少一条带原文片段的依据。')
  const resolved = []
  for (const [index, item] of claims.entries()) {
    if (!item || !['fact', 'inference'].includes(item.basis) || !item.evidenceIds?.length || !item.citations?.length) throw new Error('每条结论须标明fact或inference，并提供逐来源原文片段。')
    const covered = new Set(), excerpts = [], citations = []
    for (const citation of item.citations) {
      const source = evidence.find((value) => value.evidenceId === citation.evidenceId)
      if (!item.evidenceIds.includes(citation.evidenceId) || !source?.text || !source.readBy?.length || readerId && !source.readBy.includes(readerId) ||
        asOf && (Date.parse(source.obtainedAt) > Date.parse(asOf) || source.publishedAt && Date.parse(source.publishedAt) > Date.parse(asOf))) throw new Error('原文片段须属于本轮已读且时间有效的引用。')
      if (readerId && asOf && source.readObservations?.length && !source.readObservations.some(observation => observation.readerId === readerId && Date.parse(observation.obtainedAt) <= Date.parse(asOf))) throw new Error('引用须在本次报告时间前由本人实际读取。')
      const quote = source.weatherWarning?.completeSnapshot || source.evidenceFormat === 'json' ? String(citation.quote || '').trim() : normalize(citation.quote)
      const matched = actualExcerpt(source, quote)
      const hints = (source.citationHints || []).filter(hint => typeof hint === 'string' && hint.length >= 8 && hint.length <= 600 && source.text.includes(hint)).slice(0, 3)
      if (quote.length < 8 || quote.length > 600 || !matched) throw new Error(`第${index + 1}条引用${citation.evidenceId}的片段未出现在已读正文。JSON子集不能添上原位置不存在的右括号，也不能重排字段。` + (hints.length ? '可逐字复制的实际片段：' + JSON.stringify(hints) : '请从已读正文复制连续片段，不引用未读段落。'))
      covered.add(citation.evidenceId); excerpts.push(matched); citations.push({ evidenceId: citation.evidenceId, quote: matched })
    }
    if (item.evidenceIds.some((id) => !covered.has(id))) throw new Error('每个引用来源都须提供实际支持片段，不能附带无对应片段的引用。')
    const available = new Set(excerpts.flatMap(numbers))
    const factualBody = numericBody(item.claim, evidence.filter(source => item.evidenceIds.includes(source.evidenceId)), { readerId, asOf })
    const missing = numbers(factualBody).filter(number => !available.has(number))
    if (item.basis === 'fact' && missing.length) throw new Error(`第${index + 1}条直接事实含未被片段覆盖的数字：${[...new Set(missing)].slice(0, 8).join('、')}。请引用含该数值的实际片段；涉及契约目标时间、比较、计算的判断标inference并说明依据，不能把目标时间当原文内容。`)
    resolved.push({ ...item, citations })
  }
  return resolved
}
export const groundingInstruction = '\n证据策略quoted-claims-v1：support/counterevidence及最终findings或reasoningClaims每条只写一个主张，提供basis=fact(直接事实)或inference(推断/计算)，evidenceIds和citations:[{evidenceId,quote}]。每个来源都需8至600字符的逐字已读原文片段；不能引未读全文或搜索摘要。直接数字须出现在片段，换算/增长计算标inference并写方法。未来概率是推断，不要求未来结果已被证实。原文片段匹配不等于语义逻辑全部成立，核验席仍须检查主张与片段是否真正相符。'
