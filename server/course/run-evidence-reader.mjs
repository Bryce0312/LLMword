import { selectPageExcerpt, unreadablePageReason } from './page-excerpt.mjs'

const inputSchema = { type: 'object', additionalProperties: false,
  properties: { evidenceId: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['evidenceId'] }
const resultSchema = { type: 'object', properties: {
  status: { enum: ['ok', 'partial', 'error'] }, data: {}, evidenceIds: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' }, observedAt: { type: 'string' }, error: { type: ['object', 'null'] }, usage: { type: 'object' },
}, required: ['status', 'data', 'evidenceIds', 'summary', 'observedAt', 'error', 'usage'] }
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const fail = (code, message, observedAt) => ({ status: 'error', data: null, evidenceIds: [], summary: message,
  observedAt, error: { code, message, retryable: false }, usage: { providerRequests: 0 } })

function qualityHints(source, excerpt) {
  const hints = []
  if (unreadablePageReason(excerpt.text, source.title || '')) hints.push('保存内容可能为访问提示页，不能据此确认页面标题所述事实。')
  if (/免責聲明|免责声明|privacy preference center|cookie policy|uses cookies/i.test(excerpt.text.slice(0, 350))) {
    hints.push('保存正文可能主要为免责声明或Cookie说明；标题不等于已取得报价、财报或事件正文。')
  }
  if (!excerpt.citationHints.length) hints.push('保存片段没有足够长的引用提示；只能使用确实存在的原文，不能凑词或编造引文。')
  return hints
}

/**
 * Explicit same-Run handoff for follow-up readers. Registration is controlled by
 * the caller; initial independent workers must not receive this tool. The hooks
 * read the application's evidence store and record a read, never fetch a page.
 * onRead(originalRecord, context) must return its original evidenceId (or record).
 */
export function createRunEvidenceReader({ runId, assignmentId, getEvidence, onRead, now = () => new Date(), maxCharacters = 4000 } = {}) {
  if (typeof runId !== 'string' || !runId || typeof assignmentId !== 'string' || !assignmentId ||
    typeof getEvidence !== 'function' || typeof onRead !== 'function' || typeof now !== 'function' ||
    !Number.isSafeInteger(maxCharacters) || maxCharacters < 240 || maxCharacters > 4000) {
    throw new TypeError('Run evidence reader requires a bound run, reader, store hooks and a bounded excerpt limit.')
  }
  return { toolId: 'read_run_evidence', version: 1, timeoutMs: 2000,
    description: `显式复阅本轮已保存证据，供补查核验。输入本轮evidenceId，登记本人实际读取后才可引用；返回保存正文、URL及原取得/发布时间。超过${maxCharacters}字符的保存正文不授予复阅权限，须改用fetch_page有界读取所需片段。不是联网搜索，不产生新证据，不提高来源独立性或新鲜度。引用须复制8至600字符原文，不能只填短报价。`,
    inputSchema: structuredClone(inputSchema), resultSchema: structuredClone(resultSchema),
    async execute(args, context = {}) {
      const revisitedAt = new Date(now()).toISOString()
      const reject = (code, message) => fail(code, message, revisitedAt)
      const cancelled = () => context.signal?.aborted
      if (context.runId !== runId || context.assignmentId !== assignmentId) return reject('RUN_EVIDENCE_SCOPE', '复阅请求不属于当前运行或当前研究员。')
      if (!args || typeof args.evidenceId !== 'string' || !args.evidenceId.trim() || args.evidenceId.length > 160 ||
        Object.keys(args).some(key => key !== 'evidenceId')) return reject('INVALID_ARGUMENTS', '复阅仅接受当前运行的evidenceId。')
      if (cancelled()) return reject('TOOL_CANCELLED', '本次保存证据复阅已取消。')
      let source
      try { source = await getEvidence(args.evidenceId, { ...context, runId, assignmentId }) }
      catch { return reject('RUN_EVIDENCE_UNAVAILABLE', '本轮保存证据暂不可读取；未登记本人引用权限。') }
      if (cancelled()) return reject('TOOL_CANCELLED', '本次保存证据复阅已取消。')
      if (!source || source.evidenceId !== args.evidenceId || source.runId !== runId) return reject('RUN_EVIDENCE_SCOPE', '材料不在当前运行的已保存证据范围内。')
      if (typeof source.text !== 'string' || !source.text.trim() || !Array.isArray(source.readBy) ||
        !source.readBy.some(reader => typeof reader === 'string' && reader.trim()) || source.referenceable === false) {
        return reject('RUN_EVIDENCE_UNREAD', '材料尚无实际已读正文，搜索摘要或未读候选不能通过复阅变成证据。')
      }
      if (Array.from(source.text).length > maxCharacters) return reject('RUN_EVIDENCE_TOO_LARGE', '保存正文超过本次复阅上限，未登记本人读取或授予引用权限；请改用fetch_page有界读取所需片段。')
      let url
      try { url = new URL(source.url) } catch { return reject('RUN_EVIDENCE_INVALID', '保存证据缺少有效来源链接，未登记复阅。') }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !validTime(source.obtainedAt) ||
        source.publishedAt != null && !validTime(source.publishedAt)) return reject('RUN_EVIDENCE_INVALID', '保存证据的来源或原始时间无效，未登记复阅。')
      if (Date.parse(source.obtainedAt) > Date.parse(revisitedAt) || source.publishedAt && Date.parse(source.publishedAt) > Date.parse(revisitedAt)) {
        return reject('RUN_EVIDENCE_FUTURE', '材料的原取得或发布时间晚于当前复阅，不能用于本次判断。')
      }
      const original = structuredClone(source)
      const excerpt = selectPageExcerpt(original.text, undefined, maxCharacters)
      const hints = qualityHints(original, excerpt)
      if (cancelled()) return reject('TOOL_CANCELLED', '本次保存证据复阅已取消。')
      let receipt
      try { receipt = await onRead(structuredClone(original), { ...context, runId, assignmentId, revisitedAt }) }
      catch { return reject('RUN_EVIDENCE_READ_FAILED', '本人复阅记录未保存；不能把其他研究员的已读记录当成本人引用权限。') }
      if (cancelled()) return reject('TOOL_CANCELLED', '本次保存证据复阅已取消。')
      if ((typeof receipt === 'string' ? receipt : receipt?.evidenceId) !== original.evidenceId) {
        return reject('RUN_EVIDENCE_READ_FAILED', '复阅登记没有确认原证据编号；本次不授予引用权限。')
      }
      const truncated = excerpt.truncated || Boolean(original.truncated)
      return { status: truncated || hints.length ? 'partial' : 'ok', evidenceIds: [original.evidenceId],
        data: { evidenceId: original.evidenceId, runId, readerId: assignmentId, title: original.title || '', url: original.url,
          text: excerpt.text, citationHints: excerpt.citationHints, obtainedAt: original.obtainedAt, publishedAt: original.publishedAt ?? null,
          revisitedAt, sameRunReview: true, nonNetwork: true, newEvidence: false, originalObservationAt: original.obtainedAt,
          sourceMode: original.sourceMode ?? null, evidenceKind: original.evidenceKind ?? null,
          fixture: Boolean(original.fixture), synthetic: Boolean(original.synthetic), contentHash: original.contentHash ?? null,
          provenance: original.provenance ?? null, scoringEligible: original.scoringEligible ?? null,
          excerptStart: excerpt.excerptStart, savedCharacters: excerpt.originalCharacters, truncated, qualityHints: hints },
        // A new read does not make the underlying snapshot a new observation.
        observedAt: original.obtainedAt, error: null, usage: { providerRequests: 0 },
        summary: '已显式复阅本轮保存正文并登记给当前研究员；未联网、未生成新材料，原取得及发布时间保持不变。' +
          (truncated ? ' 未取得或未展示的原文部分不可引用。' : '') + (hints.length ? ' ' + hints.join(' ') : '') }
    } }
}
