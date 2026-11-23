import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMemorySnapshot, MEMORY_POLICY_V2 } from './memory-policy.mjs'

const AS_OF = '2026-11-19T12:00:00.000Z'
const DAY = 86_400_000
const ago = (days, milliseconds = 0) => new Date(Date.parse(AS_OF) - days * DAY + milliseconds).toISOString()
const scope = { requestId: 'request_a', predictionVersion: 1, asOf: AS_OF }
function record(suffix, days = 0.5, patch = {}) {
  const runId = `run_${suffix}`, evidenceId = `evidence_${suffix}`
  const run = { requestId: scope.requestId, runId, predictionId: 'prediction_a', predictionVersion: 1,
    status: 'completed', phase: 'finished', modelMode: 'live', sourceMode: 'live',
    createdAt: ago(days, -60_000), updatedAt: ago(days), ...patch }
  return {
    runs: [run],
    assignments: [{ runId, assignmentId: `assignment_${suffix}`, roleId: 'verification', status: 'completed',
      createdAt: ago(days, -50_000), updatedAt: ago(days, -1000), report: { status: 'complete',
        summary: `公开调查摘要 ${suffix}`, evidenceIds: [evidenceId], missingEvidence: [`未解决因素 ${suffix}`] } }],
    forecasts: [{ requestId: run.requestId, runId, predictionVersion: run.predictionVersion, forecastId: `forecast_${suffix}`,
      probabilityYes: 0.35, summary: `判断理由 ${suffix}`, issuedAt: ago(days, -500), publishedAt: ago(days, -500),
      modelMode: 'live', modelRef: 'test-model', sourceMode: 'live', dissent: [`反对意见 ${suffix}`] }],
    evidence: [{ runId, predictionVersion: run.predictionVersion, evidenceId, title: `来源 ${suffix}`,
      url: `https://example.test/${suffix}`, contentHash: `hash_${suffix}`, obtainedAt: ago(days, -30_000),
      publishedAt: ago(days, -120_000), sourceMode: 'live', text: 'PRIVATE ARCHIVED BODY' }],
    relations: [{ runId, predictionVersion: run.predictionVersion, predictionId: 'prediction_a',
      assignmentId: `assignment_${suffix}`, relationId: `relation_${suffix}`, claimId: `claim_${suffix}`,
      claim: `影响假设 ${suffix}`, relation: 'supports', evidenceId, createdAt: ago(days, -1000) }],
  }
}
function history(...parts) {
  return Object.fromEntries(['runs', 'assignments', 'forecasts', 'relations', 'evidence'].map((key) => [key, parts.flatMap((part) => part[key] || [])]))
}

test('four real judgments survive many no-change checks, with probability/reason/factors carried from each run', () => {
  const real = Array.from({ length: 6 }, (_, index) => record(`research_${index}`, 0.1 + index))
  const checks = { runs: Array.from({ length: 20 }, (_, index) => ({ ...record(`check_${index}`, 0.01 + index / 1000).runs[0], trigger: 'watch', state: { triage: { kind: 'no_change' } } })) }
  const memory = buildMemorySnapshot({ ...scope, ...history(checks, ...real) })
  assert.deepEqual(memory.sourceRunIds, real.slice(0, 4).map((item) => item.runs[0].runId))
  assert.equal(memory.shortTerm.recentJudgments.length, 4)
  assert.equal(memory.previousForecast.forecastId, 'forecast_research_0')
  for (const judgment of memory.recentJudgments) {
    assert.equal(judgment.probabilityYes, 0.35)
    assert(judgment.summary.startsWith('判断理由'))
    assert.equal(judgment.factors.length, 1)
    assert(judgment.unresolvedFactors[0].startsWith('未解决因素'))
    assert.equal(judgment.factors[0].interpretation, 'evidence-claim-relation-not-causality')
  }
  assert.equal(memory.policy.maxJudgments, 4)
  assert.equal(memory.policy.shortTermDays, 7)
})

test('scope rejects other requests/versions/current runs and incomplete, failed or cancelled runs', () => {
  const valid = record('valid')
  const foreign = record('foreign', 0.01, { requestId: 'request_b' })
  const version = record('version', 0.02, { predictionVersion: 2 })
  const failed = record('failed', 0.03, { status: 'failed' })
  const cancelled = record('cancelled', 0.04, { status: 'cancelled' })
  const running = record('running', 0.05, { status: 'running' })
  const excluded = record('excluded', 0.06)
  const memory = buildMemorySnapshot({ ...scope, excludeRunId: 'run_excluded',
    ...history(foreign, version, failed, cancelled, running, excluded, valid) })
  assert.deepEqual(memory.sourceRunIds, ['run_valid'])
  assert.deepEqual(memory.longTerm.sourceRunIds, ['run_valid'])
  assert(memory.reports.every((item) => item.sourceRunId === 'run_valid'))
  assert(memory.previousEvidence.every((item) => item.sourceRunId === 'run_valid'))
  assert.equal(memory.policy.crossRequestRetrieval, false)
})

test('the seven/90-day retrieval windows leave archives untouched and retain old useful relations separately', () => {
  const recent = record('recent', 1), shortBoundary = record('boundary_7', 7)
  const long = record('long', 30), old = record('old', 91)
  const input = { ...scope, ...history(recent, shortBoundary, long, old) }
  const original = structuredClone(input)
  const memory = buildMemorySnapshot(input)
  assert.deepEqual(memory.sourceRunIds, ['run_recent', 'run_boundary_7'])
  assert(memory.longTerm.relations.some((item) => item.sourceRunId === 'run_long'))
  assert(!JSON.stringify(memory).includes('run_old'))
  assert.equal(memory.longTerm.archiveRetention, 'no-automatic-deletion')
  assert.equal(memory.policy.retrievalIsNotDeletion, true)
  assert.equal(memory.policy.longTermDays, 90)
  assert.deepEqual(input, original)
})

test('future reports, forecasts, source bodies and graph updates cannot enter a prior cutoff', () => {
  const base = record('base')
  const futureEnd = record('future_end', -0.01)
  const futureReport = record('future_report', 0.01)
  futureReport.assignments[0].updatedAt = ago(-0.1)
  futureReport.forecasts = []
  const futureForecast = record('future_forecast', 0.02)
  futureForecast.forecasts[0].publishedAt = ago(-0.1)
  futureForecast.assignments = []
  const futureEvidence = record('future_evidence', 0.03)
  futureEvidence.evidence[0].obtainedAt = ago(-0.1)
  const futurePublication = record('future_publication', 0.04)
  futurePublication.evidence[0].publishedAt = ago(-0.1)
  const futureRelation = record('future_relation', 0.05)
  futureRelation.relations[0].createdAt = ago(-0.1)
  const memory = buildMemorySnapshot({ ...scope, ...history(futureEnd, futureReport, futureForecast, futureEvidence, futurePublication, futureRelation, base) })
  assert(!memory.sourceRunIds.includes('run_future_end'))
  assert(!memory.sourceRunIds.includes('run_future_report'))
  assert(!memory.sourceRunIds.includes('run_future_forecast'))
  assert(!memory.previousEvidence.some((item) => ['evidence_future_evidence', 'evidence_future_publication'].includes(item.evidenceId)))
  assert(!memory.relations.some((item) => ['relation_future_evidence', 'relation_future_publication', 'relation_future_relation'].includes(item.relationId)))
  assert.equal(memory.previousForecast.forecastId, 'forecast_future_evidence', 'A past forecast can be a historical judgment even if its later evidence version is no longer eligible')
})

test('partial research stays a missing probability while a genuine zero forecast remains zero', () => {
  const partial = record('partial', 0.1, { status: 'insufficient' })
  partial.assignments[0].report.status = 'insufficient'; partial.forecasts = []
  const zero = record('zero', 0.2); zero.forecasts[0].probabilityYes = 0
  const invalid = record('invalid', 0.3); invalid.forecasts[0].probabilityYes = 2; invalid.assignments = []
  const memory = buildMemorySnapshot({ ...scope, ...history(partial, zero, invalid) })
  assert.equal(memory.recentJudgments[0].hasForecast, false)
  assert.equal(memory.recentJudgments[0].probabilityYes, null)
  assert.equal(memory.recentJudgments[1].probabilityYes, 0)
  assert.equal(memory.previousForecast.probabilityYes, 0)
  assert(!memory.sourceRunIds.includes('run_invalid'))
})

test('retrieval caps and semantic deduplication bound reports/relations/source indexes and preserve counterevidence', () => {
  const data = history(...Array.from({ length: 4 }, (_, index) => record(`caps_${index}`, 0.1 + index / 10)))
  data.assignments = data.assignments.flatMap((item) => [item, { ...item, assignmentId: item.assignmentId + '_2', roleId: 'official' }, { ...item, assignmentId: item.assignmentId + '_3', roleId: 'statistics' }])
  for (let index = 0; index < 20; index++) {
    const item = record(`proof_${index}`, 0.1)
    data.evidence.push({ ...item.evidence[0], runId: 'run_caps_0' })
    data.relations.push({ ...item.relations[0], runId: 'run_caps_0', relation: index % 2 ? 'contradicts' : 'supports' })
  }
  data.relations.push({ ...data.relations[0], relationId: 'duplicate_relation' })
  data.evidence.push({ ...data.evidence[0] })
  const memory = buildMemorySnapshot({ ...scope, ...data })
  assert.equal(memory.reports.length, 8)
  assert.equal(memory.relations.length, 8)
  assert.equal(memory.previousEvidence.length, 12)
  assert(memory.relations.some((item) => item.relation === 'contradicts'))
  assert.equal(new Set(memory.relations.map((item) => `${item.relation}:${item.claimId}:${item.evidenceId}`)).size, memory.relations.length)
  assert(memory.relations.every((item) => memory.previousEvidence.some((proof) => proof.evidenceId === item.evidenceId)))
  assert(memory.relations.every((item) => item.requiresRefresh && item.evidenceAgeMs >= 0))
})

test('memory preserves simulation provenance and public summaries without leaking raw bodies, checkpoints or training claims', () => {
  const data = record('replay')
  data.runs[0].modelMode = 'mock'; data.runs[0].sourceMode = 'replay'; data.runs[0].state = { messages: ['PRIVATE PROTOCOL'] }
  data.forecasts[0].modelMode = 'mock'; data.forecasts[0].sourceMode = 'replay'
  data.assignments[0].checkpoint = { messages: ['PRIVATE CHECKPOINT'] }
  data.evidence[0].sourceMode = 'replay'; data.evidence[0].fixture = true
  const original = structuredClone(data)
  const memory = buildMemorySnapshot({ ...scope, ...data })
  assert.equal(memory.previousForecast.modelMode, 'mock')
  assert.equal(memory.previousEvidence[0].sourceMode, 'replay')
  assert.equal(memory.previousEvidence[0].synthetic, true)
  assert.equal(memory.relations[0].synthetic, true)
  assert.equal(memory.policy.parameterTraining, false)
  assert(!JSON.stringify(memory).includes('PRIVATE'))
  memory.reports[0].summary = 'changed output'
  memory.relations[0].claim = 'changed output'
  assert.deepEqual(data, original)
})

test('explicit timezone/asOf and an exact version are required for deterministic historical scope', () => {
  assert.throws(() => buildMemorySnapshot({ requestId: 'request_a' }), TypeError)
  assert.throws(() => buildMemorySnapshot({ requestId: 'request_a', asOf: '2026-11-19T12:00:00' }), TypeError)
  const data = record('v1')
  assert.equal(buildMemorySnapshot({ requestId: scope.requestId, asOf: AS_OF, ...data }).recentJudgments.length, 0)
  const memory = buildMemorySnapshot({ ...scope, asOf: '2026-11-19T20:00:00+08:00', ...data })
  assert.equal(memory.policy.asOf, AS_OF)
  assert(Object.isFrozen(MEMORY_POLICY_V2))
})
