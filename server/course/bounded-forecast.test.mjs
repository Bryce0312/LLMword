import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedForecastBudget, effectiveRoleReports, reportScorecard, boundedMainMessages, assembleForecastCandidate, partialForecastSummary } from './bounded-forecast.mjs'

const originalText = '实际读取的完整原文片段'
const evidenceFor = (...items) => items.map(item => ({ evidenceId: item.report.evidenceIds[0], text: originalText, readBy: [item.assignmentId] }))

const report = (role, probability, followUp = false) => ({ roleId: role, assignmentId: role + (followUp ? '_repair' : '_initial'), followUp, status: 'completed',
  report: { status: 'complete', summary: role, probability, evidenceIds: ['e_' + role], missingEvidence: [],
    support: [{ claim: '已读事实', basis: 'fact', evidenceIds: ['e_' + role], citations: [{ evidenceId: 'e_' + role, quote: originalText }] }], counterevidence: [] } })
test('budget allocates real worker report reserve and caps coordinator output', () => {
  const budget = boundedForecastBudget({ maxTokens: 32768, worker: { maxTokens: 32768 } }, 100000)
  assert.equal(budget.maxTotalTokens, 100000); assert(budget.worker.reserveReportTokens > 0)
  assert(budget.worker.maxTotalTokens * 3 + budget.mainReserveTokens < 100000)
  assert.equal(budget.mainRequests, 6); assert.equal(budget.maxTokens, 8192)
  assert.equal(boundedForecastBudget({ maxTokens: 32768, worker: { maxTokens: 32768 } }, null).maxTotalTokens, null)
})
test('valid follow-up replaces same role and never creates extra independent role', () => {
  assert.equal(effectiveRoleReports([report('market', .4), report('market', .5, true)]).length, 1)
  assert.equal(effectiveRoleReports([{ ...report('market', .4), status: 'failed', report: null }, report('market', .5, true)])[0].followUp, true)
})
test('zero-call fallback uses distinct validated roles and discloses median, not invented scores', () => {
  const a = report('market', .4), b = report('verification', .6)
  const evidence = evidenceFor(a, b)
  const value = assembleForecastCandidate([a, b], evidence)
  assert.equal(value.probabilityYes, .5); assert.equal(value.publicationMode, 'bounded-report-aggregation')
  assert.equal(assembleForecastCandidate([a, report('market', .7, true)], evidence), null)
  assert.equal(assembleForecastCandidate([a, { ...b, report: { ...b.report, probability: null } }], evidence), null)
  assert.equal(partialForecastSummary([a], evidence, 'budget').probabilityYes, null)
})

test('fallback never counts a role with forged, foreign or undeclared citations as a probability contributor', () => {
  const a = report('market', .4), b = report('verification', .6)
  const check = mutate => {
    const changed = structuredClone(b), evidence = evidenceFor(a, changed)
    mutate(changed, evidence)
    assert.equal(assembleForecastCandidate([a, changed], evidence), null)
  }
  check(item => { item.report.support[0].citations[0].quote = '伪造的一段未读取过的来源原文' })
  check(item => { item.report.support[0].citations[0].evidenceId = a.report.evidenceIds[0] })
  check((item, evidence) => {
    const claim = item.report.support[0]
    claim.evidenceIds = ['undeclared']; claim.citations[0].evidenceId = 'undeclared'
    evidence.push({ evidenceId: 'undeclared', text: originalText, readBy: [item.assignmentId] })
  })
  check(item => { item.report.support[0].claim = '已核验增长率是99%。' })
})

test('fallback does not strip a missing source from a multi-source claim and preserve its unsupported wording', () => {
  const a = report('market', .4), b = report('verification', .6)
  b.report.support[0].evidenceIds.push('unread')
  b.report.support[0].citations.push({ evidenceId: 'unread', quote: originalText })
  assert.equal(assembleForecastCandidate([a, b], evidenceFor(a, b)), null)
})

test('all contributing role estimates retain at least one real claim despite a verbose first report', () => {
  const a = report('market', .2), b = report('verification', .6), c = report('industry', .7)
  a.report.support = Array.from({ length: 8 }, (_, index) => ({ ...a.report.support[0], claim: `market statement ${String.fromCharCode(65 + index)}` }))
  const candidate = assembleForecastCandidate([a, b, c], evidenceFor(a, b, c))
  assert.equal(candidate.probabilityYes, .6)
  assert.equal(candidate.reasoningClaims.length, 6)
  assert(candidate.reasoningClaims.some(claim => claim.evidenceIds.includes('e_verification')))
  assert(candidate.reasoningClaims.some(claim => claim.evidenceIds.includes('e_industry')))
  assert.match(candidate.summary, /3个不同职责/)
})

test('same source read by distinct roles is disclosed as overlapping evidence, not additional source independence', () => {
  const a = report('market', .2), b = report('verification', .8)
  b.report.evidenceIds = ['e_market']
  b.report.support[0].evidenceIds = ['e_market']; b.report.support[0].citations[0].evidenceId = 'e_market'
  const candidate = assembleForecastCandidate([a, b], [{ evidenceId: 'e_market', text: originalText, readBy: [a.assignmentId, b.assignmentId] }])
  assert.equal(candidate.probabilityYes, .5)
  assert.equal(candidate.evidenceIds.length, 1)
  assert.match(candidate.sourceLimitations.join(' '), /不能把.*重复来源当作统计独立证据/)
})

test('out of range estimates and harness receipts cannot introduce a fallback probability', () => {
  const a = report('market', .4), b = report('verification', -1)
  assert.equal(reportScorecard([b])[0].probabilityYes, null)
  assert.equal(assembleForecastCandidate([a, b], evidenceFor(a, b)), null)
  for (const marker of ['generatedBy', 'completionMode']) {
    const receipt = { ...b, report: { ...b.report, probability: .5, [marker]: 'harness' } }
    assert.equal(effectiveRoleReports([a, receipt]).length, 1)
    assert.equal(assembleForecastCandidate([a, receipt], evidenceFor(a, receipt)), null)
  }
})

test('coordinator compaction preserves correction protocol, parseable real receipts and current follow-up metadata', () => {
  const first = { phase: 'review', instruction: 'initial', reports: [], followUpDone: false, evidence: [] }
  const latest = { ...first, instruction: 'correct this tool call', followUpDone: true,
    evidence: [{ evidenceId: 'real', title: 'Read source', url: 'https://example.com', contentHash: 'original-hash', text: 'not required in this projection' }] }
  const assistant = { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'propose_forecast', arguments: '{}' } }] }
  const messages = [{ role: 'system', content: 'coordinator' }, { role: 'user', content: JSON.stringify(first) }, assistant,
    { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ status: 'error', error: { code: 'CLAIM_GROUNDING', message: 'Use actual excerpts. '.repeat(150) }, data: null, evidenceIds: [] }) },
    { role: 'user', content: JSON.stringify(latest) }]
  const compacted = boundedMainMessages(messages)
  assert.equal(compacted.length, 4)
  const context = JSON.parse(compacted[1].content), receipt = JSON.parse(compacted[3].content)
  assert.equal(context.followUpDone, true); assert.equal(context.evidence[0].contentHash, 'original-hash')
  assert.match(context.instruction, /^correct this tool call/)
  assert.deepEqual(compacted[2], assistant); assert.equal(compacted[3].tool_call_id, 'call-1')
  assert.equal(receipt.status, 'error'); assert.equal(receipt.error.code, 'CLAIM_GROUNDING')
  assert.deepEqual(receipt.evidenceIds, []); assert.equal(receipt.workingExcerpt, true)
  assert.equal(messages[3].content.length > compacted[3].content.length, true)
})
