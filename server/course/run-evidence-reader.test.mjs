import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunEvidenceReader } from './run-evidence-reader.mjs'

const NOW = '2026-11-22T10:05:00.000Z', OBTAINED = '2026-11-22T09:59:49.430Z'
const context = { runId: 'current-run', assignmentId: 'verification-followup', toolCallId: 'review-call' }
const source = () => ({ evidenceId: 'saved-hkex', runId: 'current-run', topicId: 'topic', predictionId: 'prediction',
  title: 'TENCENT (700)', url: 'https://www.hkex.com.hk/Market-Data/Equities-Quote?sym=700',
  text: 'TENCENT (700)\nHKD344.000\nPREV. CLOSE HKD348.400\nUpdated: 20 Nov 2026 16:08 HKT\nInformation is delayed by at least 15 minutes.',
  obtainedAt: OBTAINED, publishedAt: null, contentHash: 'sha256:original', sourceMode: 'live', evidenceKind: 'page_content',
  referenceable: true, readBy: ['market-initial'], readObservations: [{ readerId: 'market-initial', obtainedAt: OBTAINED }] })
function fixture(overrides = {}) {
  const record = source(), reads = [], lookups = []
  const tool = createRunEvidenceReader({ runId: context.runId, assignmentId: context.assignmentId, now: () => NOW,
    getEvidence(id, ownContext) { lookups.push({ id, context: ownContext }); return record },
    onRead(value, ownContext) { reads.push({ value, context: ownContext }); return value }, ...overrides })
  return { record, tool, reads, lookups }
}

test('explicit same-run review records the new reader and returns the original ID, text and observation time', async () => {
  const { tool, record, reads } = fixture()
  const before = structuredClone(record), value = await tool.execute({ evidenceId: record.evidenceId }, context)
  assert.equal(value.status, 'ok'); assert.deepEqual(value.evidenceIds, [record.evidenceId])
  assert.equal(reads.length, 1); assert.deepEqual(reads[0].value, before)
  assert.equal(reads[0].context.runId, context.runId); assert.equal(reads[0].context.assignmentId, context.assignmentId)
  assert.equal(reads[0].context.revisitedAt, NOW)
  assert.equal(value.data.text, record.text); assert.equal(value.data.url, record.url)
  assert.equal(value.observedAt, OBTAINED); assert.equal(value.data.obtainedAt, OBTAINED)
  assert.equal(value.data.originalObservationAt, OBTAINED); assert.equal(value.data.revisitedAt, NOW)
  assert.equal(value.data.publishedAt, null); assert.equal(value.data.sameRunReview, true)
  assert.equal(value.data.nonNetwork, true); assert.equal(value.data.newEvidence, false)
  assert.equal(value.usage.providerRequests, 0); assert.equal(value.data.contentHash, 'sha256:original')
  assert.deepEqual(record, before, 'Reader hooks receive a copy; the original archived record is unchanged')
  assert(value.data.citationHints.every(quote => record.text.includes(quote)))
})

test('foreign, absent and unscoped saved material never grants citation rights or leaks its content', async () => {
  for (const record of [undefined, { ...source(), runId: 'other-run', text: 'PRIVATE_FOREIGN_SOURCE' }, { ...source(), runId: undefined }]) {
    let registrations = 0
    const { tool } = fixture({ getEvidence: () => record, onRead() { registrations++; return 'saved-hkex' } })
    const result = await tool.execute({ evidenceId: 'saved-hkex' }, context)
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'RUN_EVIDENCE_SCOPE')
    assert.deepEqual(result.evidenceIds, []); assert.equal(registrations, 0)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FOREIGN_SOURCE/)
  }
})

test('registration receives a defensive copy without changing the returned archived snapshot', async () => {
  const record = source(), original = structuredClone(record)
  const { tool } = fixture({ getEvidence: () => record, onRead(value) {
    value.text = 'MUTATED_CALLBACK_TEXT'; value.obtainedAt = NOW
    return value.evidenceId
  } })
  const result = await tool.execute({ evidenceId: record.evidenceId }, context)
  assert.equal(result.data.text, original.text); assert.equal(result.data.obtainedAt, OBTAINED)
  assert.deepEqual(record, original)
})

test('execution scope and input shape are checked before store lookup', async () => {
  const value = fixture()
  for (const ownContext of [{ ...context, runId: 'foreign' }, { ...context, assignmentId: 'other-reader' }, {}]) {
    assert.equal((await value.tool.execute({ evidenceId: 'saved-hkex' }, ownContext)).error.code, 'RUN_EVIDENCE_SCOPE')
  }
  for (const args of [{ evidenceId: 'saved-hkex', text: 'PRIVATE_INPUT' }, { evidenceId: '' }, { evidenceId: 7 }]) {
    const result = await value.tool.execute(args, context)
    assert.equal(result.error.code, 'INVALID_ARGUMENTS'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT/)
  }
  assert.equal(value.lookups.length, 0); assert.equal(value.reads.length, 0)
})

test('unread candidates, empty bodies and explicitly nonreferenceable material cannot be reviewed into evidence', async () => {
  for (const patch of [{ readBy: [] }, { readBy: 'not-a-read-record' }, { text: ' ' }, { referenceable: false }]) {
    let registrations = 0
    const { tool } = fixture({ getEvidence: () => ({ ...source(), ...patch }), onRead() { registrations++; return 'saved-hkex' } })
    const result = await tool.execute({ evidenceId: 'saved-hkex' }, context)
    assert.equal(result.error.code, 'RUN_EVIDENCE_UNREAD'); assert.equal(registrations, 0)
    assert.deepEqual(result.evidenceIds, [])
  }
})

test('review never refreshes, launders or admits future source timestamps', async () => {
  for (const patch of [{ obtainedAt: '2026-11-23T00:00:00Z' }, { publishedAt: '2026-11-23T00:00:00Z' }, { obtainedAt: 'invalid' }]) {
    const value = fixture({ getEvidence: () => ({ ...source(), ...patch }) })
    const result = await value.tool.execute({ evidenceId: 'saved-hkex' }, context)
    assert.equal(result.status, 'error'); assert.equal(value.reads.length, 0)
    assert.deepEqual(result.evidenceIds, [])
  }
  const replay = fixture({ getEvidence: () => ({ ...source(), sourceMode: 'replay', fixture: true, synthetic: true, scoringEligible: false,
    provenance: { provider: 'fixture', mode: 'replay' }, publishedAt: '2026-11-20T08:08:00Z' }) })
  const result = await replay.tool.execute({ evidenceId: 'saved-hkex' }, context)
  assert.equal(result.data.sourceMode, 'replay'); assert.equal(result.data.fixture, true); assert.equal(result.data.synthetic, true)
  assert.equal(result.data.scoringEligible, false); assert.deepEqual(result.data.provenance, { provider: 'fixture', mode: 'replay' })
  assert.equal(result.data.publishedAt, '2026-11-20T08:08:00Z'); assert.equal(result.observedAt, OBTAINED)
})

test('read registration must confirm the original ID and failure details never leak into feedback', async () => {
  for (const receipt of [undefined, 'different-evidence', { evidenceId: 'different-evidence' }]) {
    const { tool } = fixture({ onRead: () => receipt })
    const result = await tool.execute({ evidenceId: 'saved-hkex' }, context)
    assert.equal(result.error.code, 'RUN_EVIDENCE_READ_FAILED'); assert.deepEqual(result.evidenceIds, [])
  }
  for (const stage of ['getEvidence', 'onRead']) {
    const { tool } = fixture({ [stage]: () => { throw new Error('PRIVATE_STORAGE_OR_CREDENTIAL_DETAIL') } })
    const result = await tool.execute({ evidenceId: 'saved-hkex' }, context)
    assert.equal(result.status, 'error'); assert.deepEqual(result.evidenceIds, [])
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STORAGE_OR_CREDENTIAL_DETAIL/)
  }
})

test('cancellation stops read registration and never returns granted IDs', async () => {
  for (const stage of ['before', 'lookup', 'registration']) {
    const controller = new AbortController(); let reads = 0
    if (stage === 'before') controller.abort()
    const { tool } = fixture({ getEvidence() { if (stage === 'lookup') controller.abort(); return source() },
      onRead() { reads++; if (stage === 'registration') controller.abort(); return 'saved-hkex' } })
    const result = await tool.execute({ evidenceId: 'saved-hkex' }, { ...context, signal: controller.signal })
    assert.equal(result.error.code, 'TOOL_CANCELLED'); assert.deepEqual(result.evidenceIds, [])
    assert.equal(reads, stage === 'registration' ? 1 : 0)
  }
})

test('oversized saved bodies grant no read rights, while quality warnings do not hide permitted saved text', async () => {
  const text = '原始保存正文。'.repeat(1000)
  const large = fixture({ getEvidence: () => ({ ...source(), text }) })
  const result = await large.tool.execute({ evidenceId: 'saved-hkex' }, context)
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'RUN_EVIDENCE_TOO_LARGE')
  assert.deepEqual(result.evidenceIds, []); assert.equal(result.data, null); assert.equal(large.reads.length, 0)
  assert.match(result.summary, /fetch_page/)
  const footer = fixture({ getEvidence: () => ({ ...source(), text: '本免責聲明應受香港法律管限。\nAASTOCKS uses cookies to optimise and improve the website.' }) })
  const review = await footer.tool.execute({ evidenceId: 'saved-hkex' }, context)
  assert.equal(review.status, 'partial'); assert(review.data.qualityHints.length)
  assert.match(review.data.text, /免責聲明/); assert.deepEqual(review.evidenceIds, ['saved-hkex'])
  assert.equal(footer.reads.length, 1)
})

test('the review limit counts codepoints and permits the complete saved body at exactly 4000', async () => {
  const text = '数😀'.repeat(2000)
  assert.equal(Array.from(text).length, 4000); assert(text.length > 4000)
  const exact = fixture({ getEvidence: () => ({ ...source(), text }) })
  const value = await exact.tool.execute({ evidenceId: 'saved-hkex' }, context)
  assert.equal(value.status, 'ok'); assert.equal(value.data.text, text)
  assert.deepEqual(value.evidenceIds, ['saved-hkex']); assert.equal(exact.reads.length, 1)
  const oversized = fixture({ getEvidence: () => ({ ...source(), text: text + '字' }) })
  const rejected = await oversized.tool.execute({ evidenceId: 'saved-hkex' }, context)
  assert.equal(rejected.error.code, 'RUN_EVIDENCE_TOO_LARGE')
  assert.equal(oversized.reads.length, 0); assert.deepEqual(rejected.evidenceIds, [])
})
