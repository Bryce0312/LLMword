/**
 * Conservative admission estimates, not provider billing or a model tokenizer.
 * Include tool schemas and protocol overhead: max_tokens limits completion only.
 * Actual provider usage remains the authoritative accounting record.
 */
export function estimateModelInputTokens(messages, tools = []) {
  if (!Array.isArray(messages) || !Array.isArray(tools)) throw new TypeError('Model messages and tools must be arrays.')
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8')
  return Math.ceil(bytes / 2) + 128 + messages.length * 12 + tools.length * 24
}

export function planModelCall({ messages, tools = [], maxTotalTokens = null, usedTotalTokens = 0,
  maxOutputTokens = 4096, reserveTokens = 0, minOutputTokens = 256 } = {}) {
  for (const [name, value] of Object.entries({ usedTotalTokens, maxOutputTokens, reserveTokens, minOutputTokens })) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxOutputTokens' || name === 'minOutputTokens' ? 1 : 0)) {
      throw new TypeError(`Invalid model budget ${name}.`)
    }
  }
  if (maxTotalTokens !== null && (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1)) throw new TypeError('Invalid model total token budget.')
  const inputTokens = estimateModelInputTokens(messages, tools)
  const remainingTokens = maxTotalTokens === null ? null : Math.max(0, maxTotalTokens - usedTotalTokens)
  const available = remainingTokens === null ? maxOutputTokens : Math.max(0, remainingTokens - inputTokens - reserveTokens)
  const maxTokens = Math.min(maxOutputTokens, available)
  const canCall = maxTokens >= minOutputTokens
  return { canCall, inputTokens, maxTokens, estimatedRequestTokens: inputTokens + maxTokens,
    remainingTokens, reservedTokens: reserveTokens,
    reason: canCall ? null : remainingTokens !== null && remainingTokens <= inputTokens + reserveTokens ? 'INPUT_BUDGET' : 'OUTPUT_BUDGET' }
}

function excerpt(value, length) {
  const points = Array.from(value)
  return points.length <= length ? value : points.slice(0, length).join('')
}

/** Compact a genuine receipt for a new working context; never grant new evidence. */
export function compactToolReceipt(entry, { textCharacters = 1800 } = {}) {
  const compact = (value, depth = 0, key = '') => {
    if (typeof value === 'string') return excerpt(value, ['text', 'quote'].includes(key) ? textCharacters : 500)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (depth > 5) return '[omitted from working context; retained in original receipt]'
    if (Array.isArray(value)) return value.slice(0, 4).map((item) => compact(item, depth + 1, key))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([name]) => !['rawCandles', 'candles', 'rawResponse', 'body', 'html'].includes(name))
      .slice(0, 35).map(([name, item]) => [name, compact(item, depth + 1, name)]))
    return undefined
  }
  const result = entry.result || {}
  const search = ['search_web', 'search_news', 'list_provided_sources'].includes(entry.toolId)
  return { toolId: entry.toolId, toolCallId: entry.toolCallId, status: result.status,
    evidenceIds: result.status === 'error' ? [] : [...(result.evidenceIds || [])],
    summary: excerpt(result.summary || '', 500), observedAt: result.observedAt,
    error: result.error ? { code: result.error.code, message: excerpt(result.error.message || '', 700) } : null,
    ...(!search && result.data !== undefined ? { data: compact(result.data) } : {}),
    workingExcerpt: true, archiveUnchanged: true }
}
