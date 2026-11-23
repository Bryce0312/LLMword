import { caseInfo, stages, targets } from '../case.mjs'
import { digest, domainFailure, json, normalizePrediction } from './contracts.mjs'

const TOPIC_ID = 'topic_legacy_gpu_exports_2025'
const predictionId = (legacyId) => `prediction_legacy_${legacyId.replaceAll('-', '_')}`
const objectFor = { 'amd-license': 'AMD 同类芯片出口许可', 'nvda-charge': 'NVIDIA H20 相关计提' }
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const modeOf = (value, fallback = 'unknown') => typeof value?.mode === 'string' && value.mode.trim() ? value.mode : fallback
const has = (value) => value !== null && value !== undefined && value !== ''

/**
 * Pure V0 adapter: accepts world.get() snapshots or version:1 JSON state.
 * It never reads files, runs a model, advances the replay clock or scores data.
 */
export function normalizeLegacySnapshot(input, { sourceHash } = {}) {
  if (!record(input)) throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧档案必须是 JSON 对象。')
  const raw = JSON.parse(json(input))
  const apiSnapshot = raw.case?.id === caseInfo.id && Array.isArray(raw.evidence) && Array.isArray(raw.stages)
  const stateSnapshot = raw.version === 1 && record(raw.pending) && Array.isArray(raw.history) && Array.isArray(raw.trace)
  if ((!apiSnapshot && !stateSnapshot) || !Number.isInteger(raw.step) || raw.step < 0 || raw.step >= stages.length ||
    (raw.case && raw.case.id !== caseInfo.id)) {
    throw domainFailure('INVALID_LEGACY_SNAPSHOT', '仅支持现有 GPU 出口案例的 API 快照或 version:1 状态。')
  }
  const contentHash = digest(raw)
  if (sourceHash !== undefined && (typeof sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sourceHash))) {
    throw domainFailure('INVALID_LEGACY_SOURCE_HASH', '源哈希必须是完整 SHA-256 十六进制值。')
  }
  sourceHash = sourceHash?.toLowerCase() ?? contentHash
  const originalMode = modeOf(raw)
  const predictions = targets.map((target) => {
    const normalized = normalizePrediction({
      type: 'binary', question: target.question, object: objectFor[target.id], status: 'draft',
    })
    return {
      ...normalized, predictionId: predictionId(target.id), topicId: TOPIC_ID,
      legacyId: target.id, originalMode, scoringEligible: false,
      legacyMissingFields: [...normalized.validation.missingFields],
      legacy: { caseId: caseInfo.id, historicalDisplayOnly: true, issueStep: target.issueStep, resolveStep: target.resolveStep,
        note: '仅迁移原题文字；回放揭晓时间不能替代预测契约中的期限和结算规则。' },
    }
  })
  const records = []
  const append = (kind, legacyId, data, { predictionLegacyId = null, missingFields = [], originalMode: itemMode = modeOf(data, originalMode) } = {}) => {
    records.push({
      legacyId, kind, data: structuredClone(data), originalMode: itemMode, scoringEligible: false,
      predictionId: targets.some((target) => target.id === predictionLegacyId) ? predictionId(predictionLegacyId) : null,
      missingFields: [...missingFields],
    })
  }

  const history = apiSnapshot ? raw.learning?.history ?? [] : raw.history
  if (!Array.isArray(history) || history.some((item) => !record(item))) {
    throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧结算历史必须是记录数组。')
  }
  history.forEach((item, index) => append('settled-forecast', `history:${item.targetId || 'unmapped'}:${index}`, item, {
    predictionLegacyId: item.targetId,
    missingFields: ['issuedAt', 'resolvedAt', 'mode'].filter((field) => !has(item[field])),
  }))
  if (stateSnapshot) {
    for (const [targetId, item] of Object.entries(raw.pending)) {
      if (!record(item)) throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧待结算预测格式无效。')
      append('pending-forecast', `pending:${targetId}`, item, {
        predictionLegacyId: targetId, missingFields: ['issuedAt', 'mode'].filter((field) => !has(item[field])),
      })
    }
  }
  if (raw.forecast !== null && raw.forecast !== undefined) {
    if (!record(raw.forecast)) throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧预测摘要必须是对象。')
    const target = targets.find((item) => item.issueStep === raw.step)
    append('forecast-summary', `forecast:step:${raw.step}`, raw.forecast, {
      predictionLegacyId: target?.id,
      missingFields: [...(!has(raw.forecast.issuedAt) ? ['issuedAt'] : []), ...(!has(raw.forecast.mode) && !has(raw.mode) ? ['mode'] : [])],
    })
  }
  if (apiSnapshot) {
    raw.evidence.forEach((item, index) => {
      if (!record(item)) throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧来源资料格式无效。')
      append('evidence', `evidence:${item.id || index}:${index}`, item, {
        missingFields: ['publishedAt', 'firstSeenAt', 'retrievedAt', 'contentHash', 'text'].filter((field) => !has(item[field])),
      })
    })
    raw.stages.forEach((item, index) => {
      if (!record(item)) throw domainFailure('INVALID_LEGACY_SNAPSHOT', '旧时间线格式无效。')
      append('timeline', `timeline:${index}`, item, { missingFields: has(item.date) ? [] : ['date'] })
    })
    if (raw.outcome) append('outcome-summary', `outcome:step:${raw.step}`, raw.outcome, {
      predictionLegacyId: targets.find((item) => item.question === raw.outcome.target)?.id,
      missingFields: ['resolvedAt'].filter((field) => !has(raw.outcome[field])),
    })
  }
  if (Array.isArray(raw.trace)) raw.trace.forEach((item, index) => append('trace', `trace:${item?.id || index}:${index}`, item))
  // Preserve the actual archive, including branch results and old Brier values.
  // They remain historical data and are never inserted as new scored forecasts.
  return {
    schemaVersion: 1, sourceHash, contentHash,
    topic: { topicId: TOPIC_ID, title: raw.case?.title || caseInfo.title,
      background: raw.case?.description || caseInfo.description, sourceMode: 'replay',
      legacyId: caseInfo.id, originalMode, scoringEligible: false },
    predictions,
    archive: {
      format: apiSnapshot ? 'world-api-snapshot' : 'world-state-v1', caseId: caseInfo.id,
      originalMode, historicalDisplayOnly: true, scoringEligible: false,
      cutoff: has(raw.cutoff) ? raw.cutoff : null,
      missingFields: [...(!has(raw.mode) ? ['mode'] : []), ...(!has(raw.cutoff) ? ['cutoff'] : []),
        'snapshotCapturedAt', ...(!apiSnapshot ? ['evidence', 'timeline'] : [])],
      timeNotice: '导入时间由服务端另记；没有 firstSeenAt、retrievedAt 或原文版本的旧资料，不回填为当时可见证据。',
      records, raw,
    },
  }
}
