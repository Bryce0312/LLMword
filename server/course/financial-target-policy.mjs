import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

export const FINANCIAL_TARGET_POLICY = 'listed-price-target-v1'

/** An explicit listing event is a different question from a current share price. */
export function isExplicitListingQuestion(question = '') {
  // Listing news as a price catalyst is still a price question. Never turn
  // "will the stock rise because of IPO rumours" into "will it list".
  if (/股价|股價|上涨|上漲|下跌|升值|涨|漲|跌|\b(?:price|rise\w*|fall\w*|increase\w*|decrease\w*|up|down)\b/iu.test(question)) return false
  if (/上市后|上市之後|上市之后|IPO\s*后|IPO之[后後]|post[- ]IPO|after.{0,12}(?:IPO|listing)/iu.test(question)) return false
  return /(?:会不会|會不會|是否|能否|可能|计划|計劃|会|會|能|什么时候|何时).{0,24}(?:上市|掛牌|挂牌)|(?:上市|掛牌|挂牌)[吗麼么？?]|\b(?:IPO|go public|public listing)\b/iu.test(question)
}

function targetAliases(question) {
  // This identifies a name, not its listing status. A block below requires a
  // current-Run, owned and quoted model fact, never a permanent status catalog.
  const entity = '(?:字节(?:跳动)?|字節(?:跳動)?|\\bByteDance\\b)'
  const directPriceTarget = new RegExp(entity + '\\s*(?:的\\s*)?(?:股票|股价|股價|证券|證券|走势|走勢|会涨|會漲|会跌|會跌|涨|漲|跌|\\bstocks?\\b|\\bshares?\\b|\\bprice\\b)', 'iu')
  const namedPriceTarget = new RegExp('\\b(?:stock|shares?|price)\\s+(?:of\\s+)?' + entity, 'iu')
  const bareName = new RegExp('^' + entity + '[\\s?？。！!]*$', 'iu')
  return directPriceTarget.test(question) || namedPriceTarget.test(question) || bareName.test(question.trim()) ? ['字节跳动', '字節跳動', '字节', '字節', 'bytedance'] : []
}
const namesTarget = (text, aliases) => aliases.some(alias => String(text).toLowerCase().includes(alias))
const unlistedWords = /未上市|非上市|尚未上市|暂未上市|暫未上市|私人公司|私人持有|\bprivate (?:company|firm)\b|\bunlisted (?:company|firm)\b|\bnot (?:publicly )?(?:listed|traded)\b|\bshares (?:are )?privately held\b/iu
const contradictedOrPast = text => /不再|并非|並非|不是|否认.{0,25}(?:未上市|私人)|否認.{0,25}(?:未上市|私人)|\b(?:no longer|not (?:a |an )?private|incorrect|not true)\b/iu.test(text) ||
  /曾经|曾經|当时|當時|此前|以前|过去|過去|\b(?:formerly|previously|historically|used to|was (?:a |an )?(?:private|unlisted))\b/iu.test(text) && !/目前|当前|當前|现在|現在|仍|\b(?:currently|now|remains?)\b/iu.test(text)
const privateStatement = (text, aliases) => !contradictedOrPast(text) && aliases.some(alias => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?:[（(][^）)]{0,40}[）)])?\\s*(?:目前|当前|當前|现在|現在|依然|仍然)?\\s*(?:是|为|為|仍|属于|屬於)\\s*(?:一家|一間)?\\s*(?:未上市|非上市|私人公司|私人持有)', 'iu').test(text) ||
    new RegExp(escaped + "(?:'s)?\\s+(?:is|remains?|currently is)\\s+(?:a |an )?(?:private|unlisted|not publicly (?:listed|traded))", 'iu').test(text) ||
    new RegExp(escaped + "(?:'s|’s|的)?\\s*(?:股份|股票|shares)[^，,。；;\\n]{0,30}(?:私人持有|privately held|非公开|非公開)", 'iu').test(text)
})
const listedStatement = (text, aliases) => !/未上市|非上市|不(?:是|再)|尚未|\b(?:not|never|used to|formerly|was)\b/iu.test(text) && aliases.some(alias => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?:[（(][^）)]{0,40}[）)])?\\s*(?:目前|当前|當前|现在|現在)?\\s*(?:已经上市|已經上市|已正式上市|已在[^，,。；;\\n]{0,25}上市|已於[^，,。；;\\n]{0,25}上市|已于[^，,。；;\\n]{0,25}上市|挂牌交易|掛牌交易)', 'iu').test(text) ||
    new RegExp(escaped + "(?:'s)?\\s+(?:is|now is|remains?)\\s+(?:a |an )?(?:publicly traded|publicly listed|listed company)", 'iu').test(text)
})

/** Refuse a price contract only after actual research contradicts tradability.
 * Old requests without this version remain immutable; explicit IPO events pass.
 */
export function financialTargetIssue(request, assignments, evidence, { runId, asOf } = {}) {
  if (request?.financialTargetPolicy !== FINANCIAL_TARGET_POLICY || request.mode !== 'preset' ||
    (request.purpose || 'forecast') !== 'forecast' || isExplicitListingQuestion(request.question)) return null
  if (!request.tradingHorizon && request.horizonTradingDays === undefined && !/股票|股价|股價|证券|證券|\b(?:stock|shares?|price)\b/iu.test(request.question || '')) return null
  const aliases = targetAliases(request.question || '')
  if (!aliases.length || !runId || !Number.isFinite(Date.parse(asOf))) return null
  // Let the real workers establish identity first. An ambiguous name alone is
  // not a claim that a company is unlisted; after investigation it still needs
  // an affirmative, owned source for a public security before a price forecast.
  if (!(assignments || []).some(item => item.runId === runId && ['completed', 'failed', 'cancelled'].includes(item.status))) return null
  const facts = [], currentListingFacts = []
  for (const item of assignments || []) {
    if (item.runId !== runId || !item.assignmentId) continue
    for (const report of [item.report, item.partialReport]) {
      if (!report || !['complete', 'insufficient'].includes(report.status) || report.generatedBy || report.completionMode || report.delivery?.modelGenerated === false) continue
      for (const claim of [...(report.support || []), ...(report.counterevidence || [])]) {
        if (claim.basis !== 'fact' || !namesTarget(claim.claim, aliases)) continue
        const ownSources = (evidence || []).filter(source => source.runId === runId && source.readBy?.includes(item.assignmentId) &&
          source.referenceable !== false && source.evidenceKind !== 'search_snippet' && Number.isFinite(Date.parse(source.obtainedAt)) &&
          Date.parse(source.obtainedAt) <= Date.parse(asOf) && (!source.publishedAt || Number.isFinite(Date.parse(source.publishedAt)) && Date.parse(source.publishedAt) <= Date.parse(asOf)))
        try {
          const [verified] = validateGroundedClaims([claim], ownSources, { readerId: item.assignmentId, asOf })
          if (listedStatement(verified.claim, aliases) && verified.citations.some(citation => {
            const source = ownSources.find(item => item.evidenceId === citation.evidenceId)
            return listedStatement(citation.quote, aliases) && (!source.publishedAt || Date.parse(asOf) - Date.parse(source.publishedAt) <= 30 * 86400000)
          })) currentListingFacts.push(verified)
          if (unlistedWords.test(verified.claim) && privateStatement(verified.claim, aliases) &&
            verified.citations.some(citation => privateStatement(citation.quote, aliases))) facts.push(verified)
        } catch { /* An unvalidated allegation cannot block or redefine a target. */ }
      }
    }
  }
  if (currentListingFacts.length) return null
  return { code: 'PUBLIC_PRICE_TARGET_UNAVAILABLE', originalQuestion: request.question,
    message: (facts.length ? '本轮已读资料包含字节跳动未上市、股份非公开交易的明确描述，但尚未核验其当前公开可交易的证券身份；旧新闻不能单独证明现在的上市状态。' : '本轮调查尚未核验“字节”所指公司的当前公开可交易证券身份，不能仅凭名称假定存在公开股价。') +
      '因此原题尚不能定义可核验的股价涨跌概率。请选择明确可交易的证券名称或代码；若想预测上市，请另建“字节跳动未来是否上市”的事件题。本次不会改成快手、科技指数或上市概率。',
    evidenceIds: [...new Set(facts.flatMap(claim => claim.evidenceIds))], facts,
    nextActions: ['选择明确可交易的证券名称或代码。', '如需预测上市，明确输入上市事件并新建任务。'] }
}
