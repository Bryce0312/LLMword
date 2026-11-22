/** Bounded historical retrieval. This module performs no IO and never updates archives. */
import { deriveForecastStatus } from './forecast-facts.mjs'
import { PRICE_DIRECTION, isPriceDirection, validDirectionProbabilities, directionFields } from '../../web/course-price-direction.mjs'

const probabilities = item => isPriceDirection(item) ? { type: PRICE_DIRECTION, ...directionFields(item) } : { probabilityYes: item?.probabilityYes ?? null }

export const MEMORY_POLICY_V2 = Object.freeze({
  version: '2.0', shortTermDays: 7, maxJudgments: 4, maxReports: 8,
  longTermDays: 90, maxRelations: 8, maxEvidence: 12,
})

const DAY = 86_400_000
const ended = new Set(['completed', 'insufficient'])
const reportStatuses = new Set(['complete', 'insufficient', 'blocked'])
const time = (value) => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
const text = (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : ''
const strings = (value, max = 30, chars = 160) => [...new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.slice(0, chars)))].slice(0, max)
const unique = (items, key) => { const seen = new Set(); return items.filter((item) => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true }) }
const latestFirst = (items, date) => items.slice().sort((a, b) => time(date(b)) - time(date(a)))
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null

/**
 * Pass runs newest-first for deterministic ties (the SQLite row order is suitable).
 * The other arrays contain original flat records with runId. No raw model messages,
 * evidence bodies, credentials, or arbitrary record fields are copied to the result.
 */
export function buildMemorySnapshot({ requestId, predictionVersion = null, excludeRunId, asOf,
  runs = [], assignments = [], forecasts = [], relations = [], evidence = [] } = {}) {
  const cutoff = time(asOf)
  if (typeof requestId !== 'string' || !requestId.trim() || !Number.isFinite(cutoff)) throw new TypeError('Memory retrieval requires a requestId and an explicit asOf time.')
  const scopeVersion = predictionVersion ?? null
  const shortFrom = cutoff - MEMORY_POLICY_V2.shortTermDays * DAY
  const longFrom = cutoff - MEMORY_POLICY_V2.longTermDays * DAY
  const before = (value) => Number.isFinite(time(value)) && time(value) <= cutoff
  const sameVersion = (item) => (item.predictionVersion ?? null) === scopeVersion
  const scopedRuns = latestFirst(runs.filter((run) => run.requestId === requestId && run.runId !== excludeRunId &&
    sameVersion(run) && ended.has(run.status) && before(run.createdAt) && before(run.updatedAt) && time(run.updatedAt) >= longFrom), (run) => run.updatedAt)
  const scopedIds = new Set(scopedRuns.map((run) => run.runId))
  const runById = new Map(scopedRuns.map((run) => [run.runId, run]))
  const scopeRecord = (item) => scopedIds.has(item.runId) && (item.requestId === undefined || item.requestId === requestId)
  const visibleEvidence = latestFirst(evidence.filter((item) => scopeRecord(item) && sameVersion(item) &&
    typeof item.evidenceId === 'string' && item.evidenceId && before(item.obtainedAt) && time(item.obtainedAt) >= longFrom &&
    (!item.publishedAt || before(item.publishedAt))), (item) => item.obtainedAt)
  const evidenceKeys = new Set(visibleEvidence.map((item) => `${item.runId}:${item.evidenceId}`))
  const evidenceByKey = new Map(visibleEvidence.map((item) => [`${item.runId}:${item.evidenceId}`, item]))
  const evidenceIdsFor = (runId, ids) => strings(ids).filter((id) => evidenceKeys.has(`${runId}:${id}`))
  const visibleReports = assignments.filter((item) => scopeRecord(item) && item.report && reportStatuses.has(item.report.status) &&
    text(item.report.summary).trim() && before(item.updatedAt) && (!item.createdAt || before(item.createdAt)))
  const visibleForecasts = latestFirst(forecasts.filter((item) => scopeRecord(item) && sameVersion(item) &&
    (isPriceDirection(item) ? validDirectionProbabilities(item) : probability(item.probabilityYes) !== null) && before(item.issuedAt ?? item.publishedAt) &&
    time(item.issuedAt ?? item.publishedAt) >= longFrom &&
    (!item.publishedAt || before(item.publishedAt))), (item) => item.issuedAt ?? item.publishedAt)
  const researched = (run) => visibleForecasts.some((item) => item.runId === run.runId) ||
    visibleReports.some((item) => item.runId === run.runId && item.report.status !== 'blocked')
  const selected = scopedRuns.filter((run) => time(run.updatedAt) >= shortFrom && researched(run)).slice(0, MEMORY_POLICY_V2.maxJudgments)
  const shortIds = new Set(selected.map((run) => run.runId))
  const projectReport = (item) => ({ sourceRunId: item.runId, roleId: item.roleId, historical: true, requiresRefresh: true,
    status: item.report.status, summary: text(item.report.summary),
    evidenceIds: evidenceIdsFor(item.runId, item.report.evidenceIds),
    missingEvidence: strings(item.report.missingEvidence, 3, 300),
  })
  const reports = selected.flatMap((run) => visibleReports.filter((item) => item.runId === run.runId).map(projectReport)).slice(0, MEMORY_POLICY_V2.maxReports)

  const relationRecords = unique(latestFirst(relations.filter((item) => scopeRecord(item) && sameVersion(item) &&
    ['supports', 'contradicts'].includes(item.relation) && text(item.claim).trim() && before(item.createdAt) &&
    time(item.createdAt) >= longFrom && evidenceKeys.has(`${item.runId}:${item.evidenceId}`)), (item) => item.createdAt),
  (item) => `${item.relation}:${item.claimId || item.claim}:${item.evidenceId}`)
  const projectRelation = (item) => {
    const proof = evidenceByKey.get(`${item.runId}:${item.evidenceId}`)
    return { relationId: item.relationId, runId: item.runId, sourceRunId: item.runId,
    predictionId: item.predictionId ?? null, predictionVersion: item.predictionVersion ?? null,
    assignmentId: item.assignmentId ?? null, relation: item.relation, claimId: item.claimId ?? null,
    claim: text(item.claim), evidenceId: item.evidenceId, createdAt: item.createdAt,
    historical: true, requiresRefresh: true, ageMs: cutoff - time(item.createdAt),
    evidenceObtainedAt: proof.obtainedAt, evidenceAgeMs: cutoff - time(proof.obtainedAt),
    sourceMode: proof.sourceMode || runById.get(item.runId)?.sourceMode || null,
    modelMode: runById.get(item.runId)?.modelMode || null, synthetic: Boolean(proof.fixture || proof.synthetic),
    interpretation: 'evidence-claim-relation-not-causality',
  } }
  const relationMemory = relationRecords.slice(0, MEMORY_POLICY_V2.maxRelations).map(projectRelation)
  const relationProofs = relationMemory.map((item) => evidenceByKey.get(`${item.runId}:${item.evidenceId}`))
  const previousEvidence = unique([...relationProofs, ...visibleEvidence], (item) => `${item.evidenceId}:${item.contentHash || ''}:${item.url || ''}`)
    .slice(0, MEMORY_POLICY_V2.maxEvidence).map((item) => ({ evidenceId: item.evidenceId, url: text(item.url, 2000),
      title: text(item.title, 240), contentHash: text(item.contentHash, 200), sourceRunId: item.runId,
      historical: true, requiresRefresh: true, obtainedAt: item.obtainedAt, publishedAt: item.publishedAt || null,
      ageMs: cutoff - time(item.obtainedAt), sourceMode: item.sourceMode || null, synthetic: Boolean(item.fixture || item.synthetic),
    }))
  const projectForecast = (item) => item && ({ forecastId: item.forecastId, sourceRunId: item.runId,
    predictionVersion: item.predictionVersion ?? null, ...probabilities(item),
    issuedAt: item.issuedAt ?? item.publishedAt, summary: text(item.summary),
    modelMode: item.modelMode || null, modelRef: item.modelRef || null, sourceMode: item.sourceMode || null,
    historical: true, ageMs: cutoff - time(item.issuedAt ?? item.publishedAt),
    ...deriveForecastStatus(item),
  })
  const previousForecast = projectForecast(visibleForecasts[0]) || null
  const recentJudgments = selected.map((run) => {
    const forecast = visibleForecasts.find((item) => item.runId === run.runId)
    const runReports = visibleReports.filter((item) => item.runId === run.runId)
    const factors = relationRecords.filter((item) => item.runId === run.runId).slice(0, 6).map(projectRelation)
    return { sourceRunId: run.runId, predictionVersion: run.predictionVersion ?? null,
      completedAt: run.updatedAt, historical: true, hasForecast: Boolean(forecast), forecastId: forecast?.forecastId ?? null,
      ...probabilities(forecast), issuedAt: forecast?.issuedAt ?? forecast?.publishedAt ?? null,
      summary: forecast ? text(forecast.summary) : text(run.message || runReports.map((item) => item.report.summary).join('；')),
      ...(forecast ? deriveForecastStatus(forecast) : {}),
      factors, unresolvedFactors: strings(runReports.flatMap((item) => item.report.missingEvidence || []), 6, 300),
      dissent: strings(forecast?.dissent, 6, 300), reportCount: runReports.length,
      modelMode: run.modelMode || null, sourceMode: run.sourceMode || null,
    }
  })
  const longSourceRunIds = [...new Set([...relationMemory.map((item) => item.sourceRunId), ...previousEvidence.map((item) => item.sourceRunId), ...(previousForecast ? [previousForecast.sourceRunId] : [])])]
  const policy = { ...MEMORY_POLICY_V2, scope: { requestId, predictionVersion: scopeVersion }, asOf: new Date(cutoff).toISOString(),
    shortTermFrom: new Date(shortFrom).toISOString(), longTermFrom: new Date(longFrom).toISOString(),
    retention: 'archive-kept-without-automatic-deletion', retrievalIsNotDeletion: true,
    historicalEvidenceRequiresRefresh: true, crossRequestRetrieval: false, parameterTraining: false,
  }
  const sourceRunIds = selected.map((run) => run.runId)
  const summary = `历史记忆：近${MEMORY_POLICY_V2.shortTermDays}天${recentJudgments.length}次实质研判、${reports.length}份报告；近${MEMORY_POLICY_V2.longTermDays}天${relationMemory.length}条来源关系。旧概率和资料只作历史比较与检索线索，本轮引用必须重新读取；检索窗口不删除封存档案。`
  return { historical: true, policy, sourceRunIds, previousForecast, recentJudgments,
    reports, relations: relationMemory, previousEvidence, reportCount: reports.length, relationCount: relationMemory.length, summary,
    shortTerm: { sourceRunIds: [...sourceRunIds], recentJudgments, reports,
      relations: relationMemory.filter((item) => shortIds.has(item.sourceRunId)), from: policy.shortTermFrom },
    longTerm: { sourceRunIds: longSourceRunIds, previousForecast, relations: relationMemory, previousEvidence, from: policy.longTermFrom,
      archiveRetention: 'no-automatic-deletion', requiresRefresh: true },
  }
}
/** Compact only the model input; the full historical archive and UI stay unchanged. */
export function memoryForModel(memory, { roleId, maxCharacters = 16000 } = {}) {
  if (!memory) return null
  const cut = (value, size = 350) => typeof value === 'string' ? value.slice(0, size) : ''
  const forecast = (value) => value ? {
    forecastId: value.forecastId, sourceRunId: value.sourceRunId, predictionVersion: value.predictionVersion,
    ...probabilities(value), issuedAt: value.issuedAt, summary: cut(value.summary),
    statusLabel: value.statusLabel, baselineVerified: value.baselineVerified, conditionalOnly: value.conditionalOnly,
    scoringEligible: value.scoringEligible, historical: true, modelMode: value.modelMode, sourceMode: value.sourceMode,
    statusFacts: (value.statusFacts || []).slice(0, 6).map(({ key, label, text }) => ({ key, label, text: cut(text, 200) })),
    summaryConflict: value.summaryConflict ? { detected: value.summaryConflict.detected, reasons: (value.summaryConflict.reasons || []).slice(0, 4).map((text) => cut(text, 160)) } : null,
  } : null
  const reports = (memory.reports || []).filter((item) => !roleId || [roleId, 'verification'].includes(item.roleId)).slice(0, 4)
  const result = { historical: true, modelViewVersion: 1, summary: cut(memory.summary), policy: memory.policy,
    sourceRunIds: memory.sourceRunIds, previousForecast: forecast(memory.previousForecast),
    recentJudgments: (memory.recentJudgments || []).slice(0, 4).map((item) => ({ ...forecast(item), completedAt: item.completedAt,
      unresolvedFactors: (item.unresolvedFactors || []).slice(0, 3).map((text) => cut(text, 180)) })),
    reports: reports.map((item) => ({ sourceRunId: item.sourceRunId, roleId: item.roleId, status: item.status, summary: cut(item.summary),
      evidenceIds: item.evidenceIds, missingEvidence: (item.missingEvidence || []).slice(0, 3).map((text) => cut(text, 180)), requiresRefresh: true })),
    relations: (memory.relations || []).slice(0, 4).map(({ relationId, sourceRunId, relation, claim, evidenceId }) => ({ relationId, sourceRunId, relation, claim: cut(claim, 240), evidenceId, requiresRefresh: true })),
    previousEvidence: (memory.previousEvidence || []).slice(0, 8).map(({ evidenceId, sourceRunId, title, url, publishedAt, obtainedAt }) => ({ evidenceId, sourceRunId, title: cut(title, 120), url: cut(url, 800), publishedAt, obtainedAt, requiresRefresh: true })),
    reportCount: reports.length, relationCount: Math.min(4, memory.relations?.length || 0),
    omission: '模型仅接收一次有界摘要；完整短期、长期档案保留，旧证据仍须重新读取。',
  }
  for (const key of ['previousEvidence', 'relations', 'reports', 'recentJudgments']) while (JSON.stringify(result).length > maxCharacters && result[key].length) result[key].pop()
  result.reportCount = result.reports.length; result.relationCount = result.relations.length
  return result
}
