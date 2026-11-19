import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { digest, domainFailure, identifier, json, normalizeEvidence, normalizePrediction, normalizeTopic, validDate } from './contracts.mjs'
import { normalizeAgentSpec } from './agent-catalog.mjs'
import { normalizeLegacySnapshot } from './legacy-import.mjs'

const SCHEMA_VERSION = 1
const generated = (kind) => `${kind}_${randomUUID()}`
const parse = (value) => JSON.parse(value)

export function createDomainStore({ path, registeredToolIds = [], now = () => new Date().toISOString() } = {}) {
  if (typeof path !== 'string' || !path) throw domainFailure('INVALID_PATH', '领域数据库需要独立的保存路径。')
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  let closed = false

  function transact(work) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL')
    transact(() => {
      db.exec('CREATE TABLE IF NOT EXISTS domain_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
      const version = db.prepare("SELECT value FROM domain_metadata WHERE key = 'schemaVersion'").get()
      if (version && Number(version.value) !== SCHEMA_VERSION) throw domainFailure('DOMAIN_SCHEMA_VERSION', '领域数据库版本尚不受支持。', 500)
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_topics (
          topic_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          record_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_predictions (
          prediction_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES domain_topics(topic_id),
          current_version INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_prediction_versions (
          prediction_id TEXT NOT NULL REFERENCES domain_predictions(prediction_id),
          version INTEGER NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (prediction_id, version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_agent_versions (
          agent_spec_id TEXT NOT NULL,
          spec_version INTEGER NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (agent_spec_id, spec_version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_evidence (
          evidence_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES domain_topics(topic_id),
          record_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_evidence_predictions (
          evidence_id TEXT NOT NULL REFERENCES domain_evidence(evidence_id),
          prediction_id TEXT NOT NULL REFERENCES domain_predictions(prediction_id),
          PRIMARY KEY (evidence_id, prediction_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_operations (
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (scope, idempotency_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_legacy_imports (
          source_hash TEXT PRIMARY KEY,
          input_hash TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          result_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS domain_legacy_mappings (
          source_hash TEXT NOT NULL REFERENCES domain_legacy_imports(source_hash),
          kind TEXT NOT NULL,
          legacy_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (source_hash, kind, legacy_id)
        ) STRICT;
      `)
      db.prepare("INSERT OR IGNORE INTO domain_metadata (key,value) VALUES ('schemaVersion',?)").run(String(SCHEMA_VERSION))
      db.prepare("INSERT OR IGNORE INTO domain_metadata (key,value) VALUES ('storeId',?)").run(randomUUID())
    })
  } catch (error) {
    db.close()
    throw error
  }
  const metadata = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    storeId: db.prepare("SELECT value FROM domain_metadata WHERE key = 'storeId'").get().value,
  })

  function time() {
    const at = now()
    if (!validDate(at)) throw domainFailure('INVALID_STORE_CLOCK', '领域数据库时钟须返回有效 ISO 时间。', 500)
    return at
  }

  function expectedVersion(value, version) {
    if (!Number.isSafeInteger(value) || value < 1) throw domainFailure('EXPECTED_VERSION_REQUIRED', '修改前请提供当前版本。', 400, ['expectedVersion'])
    if (value !== version) throw domainFailure('VERSION_CONFLICT', '记录已被更新，请读取最新版本。', 409, ['expectedVersion'])
  }

  function requestRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw domainFailure('INVALID_INPUT', '请求必须是 JSON 对象。')
    }
    return value
  }

  function once(scope, key, input, work) {
    if (key === undefined) return work()
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw domainFailure('INVALID_IDEMPOTENCY_KEY', '幂等键格式无效。')
    const hash = digest(input)
    const old = db.prepare('SELECT * FROM domain_operations WHERE scope = ? AND idempotency_key = ?').get(scope, key)
    if (old) {
      if (old.input_hash !== hash) throw domainFailure('IDEMPOTENCY_CONFLICT', '此幂等键已用于不同的内容。', 409)
      return parse(old.result_json)
    }
    const result = work()
    db.prepare('INSERT INTO domain_operations VALUES (?, ?, ?, ?)').run(scope, key, hash, json(result))
    return result
  }

  function getTopic(topicId) {
    identifier(topicId, 'topicId')
    const row = db.prepare('SELECT record_json FROM domain_topics WHERE topic_id = ?').get(topicId)
    return row ? parse(row.record_json) : null
  }

  function requireTopic(topicId) {
    const topic = getTopic(topicId)
    if (!topic) throw domainFailure('TOPIC_NOT_FOUND', '找不到此主题。', 404)
    return topic
  }

  function getPrediction(predictionId, { version } = {}) {
    identifier(predictionId, 'predictionId')
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw domainFailure('INVALID_VERSION', '版本必须是正整数。')
    const row = version === undefined
      ? db.prepare(`SELECT v.record_json FROM domain_prediction_versions v
          JOIN domain_predictions p ON p.prediction_id = v.prediction_id AND p.current_version = v.version
          WHERE p.prediction_id = ?`).get(predictionId)
      : db.prepare('SELECT record_json FROM domain_prediction_versions WHERE prediction_id = ? AND version = ?').get(predictionId, version)
    return row ? parse(row.record_json) : null
  }

  function requirePrediction(predictionId) {
    const prediction = getPrediction(predictionId)
    if (!prediction) throw domainFailure('PREDICTION_NOT_FOUND', '找不到此预测题。', 404)
    return prediction
  }

  function insertTopic(input, at) {
    requestRecord(input)
    const topicId = identifier(input.topicId ?? generated('topic'), 'topicId')
    if (getTopic(topicId)) throw domainFailure('TOPIC_CONFLICT', '主题编号已存在。', 409)
    const topic = { ...normalizeTopic(input), topicId, version: 1, createdAt: at, updatedAt: at }
    db.prepare('INSERT INTO domain_topics VALUES (?, ?, ?)').run(topicId, 1, json(topic))
    return topic
  }

  function insertPrediction(topicId, input, at, migration = false) {
    requestRecord(input)
    const topic = requireTopic(topicId)
    const predictionId = identifier(input.predictionId ?? generated('prediction'), 'predictionId')
    if (getPrediction(predictionId)) throw domainFailure('PREDICTION_CONFLICT', '预测题编号已存在。', 409)
    const normalized = normalizePrediction(input)
    const prediction = {
      ...normalized, predictionId, topicId, version: 1,
      scoringEligible: !migration && topic.sourceMode !== 'replay' && normalized.validation.ready,
      createdAt: at, updatedAt: at,
      ...(migration ? { legacy: legacyMetadata(input) } : {}),
    }
    db.prepare('INSERT INTO domain_predictions VALUES (?, ?, ?)').run(predictionId, topicId, 1)
    db.prepare('INSERT INTO domain_prediction_versions VALUES (?, ?, ?)').run(predictionId, 1, json(prediction))
    return prediction
  }

  function legacyMetadata(input) {
    return { legacyId: input.legacyId ?? null, originalMode: input.originalMode ?? null, missingFields: input.legacyMissingFields ?? [], ...(input.legacy || {}) }
  }

  function addEvidenceRecord(topicId, input, at, migration = false) {
    requestRecord(input)
    const topic = requireTopic(topicId)
    const evidenceId = identifier(input.evidenceId ?? generated('evidence'), 'evidenceId')
    const evidence = { ...normalizeEvidence(input, { receivedAt: at }), evidenceId, topicId }
    for (const predictionId of evidence.predictionIds) {
      if (requirePrediction(predictionId).topicId !== topicId) {
        throw domainFailure('EVIDENCE_SCOPE_MISMATCH', '资料只能关联到同一主题下的预测题。', 409)
      }
    }
    if (migration) Object.assign(evidence, { sourceMode: 'replay', scoringEligible: false, legacy: legacyMetadata(input) })
    if (topic.sourceMode === 'replay') evidence.scoringEligible = false
    const previous = db.prepare('SELECT record_json FROM domain_evidence WHERE evidence_id = ?').get(evidenceId)
    if (previous) {
      const old = parse(previous.record_json)
      const comparable = (item) => { const { firstSeenAt, retrievedAt, ...rest } = item; return rest }
      if (digest(comparable(old)) !== digest(comparable(evidence))) throw domainFailure('EVIDENCE_CONFLICT', '此资料编号已经对应另一份不可变材料。', 409)
      return old
    }
    db.prepare('INSERT INTO domain_evidence VALUES (?, ?, ?)').run(evidenceId, topicId, json(evidence))
    for (const predictionId of evidence.predictionIds) {
      db.prepare('INSERT INTO domain_evidence_predictions VALUES (?, ?)').run(evidenceId, predictionId)
    }
    return evidence
  }

  function getAgentSpec(agentSpecId, { specVersion } = {}) {
    identifier(agentSpecId, 'agentSpecId')
    if (specVersion !== undefined && (!Number.isInteger(specVersion) || specVersion < 1)) throw domainFailure('INVALID_VERSION', '角色版本必须是正整数。')
    const row = specVersion === undefined
      ? db.prepare('SELECT record_json FROM domain_agent_versions WHERE agent_spec_id = ? ORDER BY spec_version DESC LIMIT 1').get(agentSpecId)
      : db.prepare('SELECT record_json FROM domain_agent_versions WHERE agent_spec_id = ? AND spec_version = ?').get(agentSpecId, specVersion)
    return row ? parse(row.record_json) : null
  }

  function importLegacy({ snapshot, sourceHash }) {
    const hash = digest(snapshot)
    sourceHash ??= hash
    if (typeof sourceHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sourceHash)) throw domainFailure('INVALID_SOURCE_HASH', '迁移来源须提供 SHA256 哈希。')
    sourceHash = sourceHash.toLowerCase()
    return transact(() => {
      const previous = db.prepare('SELECT input_hash, result_json FROM domain_legacy_imports WHERE source_hash = ?').get(sourceHash)
      if (previous) {
        if (previous.input_hash !== hash) throw domainFailure('LEGACY_HASH_CONFLICT', '相同来源哈希对应了不同的旧数据。', 409)
        return { ...parse(previous.result_json), duplicate: true }
      }
      const at = time()
      const plan = normalizeLegacySnapshot(snapshot, { sourceHash, importedAt: at })
      const topic = getTopic(plan.topic.topicId) ?? insertTopic({ ...plan.topic, sourceMode: 'replay' }, at)
      if (topic.sourceMode !== 'replay') throw domainFailure('LEGACY_SCOPE_CONFLICT', '旧案例主题编号与现有主题冲突。', 409)
      const predictions = plan.predictions.map((input) => {
        const existing = getPrediction(input.predictionId)
        if (existing && existing.topicId !== topic.topicId) throw domainFailure('LEGACY_SCOPE_CONFLICT', '旧预测题与现有主题归属冲突。', 409)
        return existing ?? insertPrediction(topic.topicId, { ...input, status: 'draft' }, at, true)
      })
      const evidence = (plan.evidence || []).map((item) => addEvidenceRecord(topic.topicId, item, at, true))
      const mappings = [
        { kind: 'topic', legacyId: plan.topic.legacyId ?? 'gpu-exports-2025', targetId: topic.topicId, data: plan.topic },
        ...plan.predictions.map((input) => ({ kind: 'prediction', legacyId: input.legacyId ?? input.predictionId, targetId: input.predictionId, data: input })),
        ...(plan.archive?.records || []).map((item) => ({ kind: item.kind, legacyId: item.legacyId, targetId: item.predictionId ?? item.targetId ?? topic.topicId, data: item })),
      ]
      const result = { topic, predictions, evidence, mappings, duplicate: false, sourceHash, importedAt: at }
      db.prepare('INSERT INTO domain_legacy_imports VALUES (?, ?, ?, ?, ?)').run(sourceHash, hash, at, json(plan), json(result))
      for (const entry of mappings) {
        db.prepare('INSERT INTO domain_legacy_mappings VALUES (?, ?, ?, ?, ?)').run(sourceHash, entry.kind, entry.legacyId, entry.targetId, json(entry.data))
      }
      return result
    })
  }

  return {
    metadata,
    createTopic(input, options = {}) {
      return transact(() => once('topic:create', options.idempotencyKey ?? input?.idempotencyKey, input, () => insertTopic(input, time())))
    },
    getTopic,
    listTopics() {
      return db.prepare('SELECT record_json FROM domain_topics ORDER BY topic_id').all().map((row) => parse(row.record_json))
    },
    updateTopic(topicId, patch, options = {}) {
      return transact(() => once(`topic:update:${topicId}`, options.idempotencyKey ?? patch?.idempotencyKey, patch, () => {
        requestRecord(patch)
        const previous = requireTopic(topicId)
        expectedVersion(patch.expectedVersion, previous.version)
        const normalized = normalizeTopic(patch, { previous })
        if (normalized.sourceMode !== previous.sourceMode) {
          throw domainFailure('TOPIC_SOURCE_MODE_IMMUTABLE', '主题的数据模式创建后不可修改，请为新模式建立独立主题。', 409, ['sourceMode'])
        }
        if (digest(normalized) === digest(normalizeTopic(previous))) return previous
        const topic = { ...previous, ...normalized, version: previous.version + 1, updatedAt: time() }
        db.prepare('UPDATE domain_topics SET version = ?, record_json = ? WHERE topic_id = ?').run(topic.version, json(topic), topicId)
        return topic
      }))
    },
    createPrediction(topicId, input, options = {}) {
      return transact(() => once(`prediction:create:${topicId}`, options.idempotencyKey ?? input?.idempotencyKey, input, () => insertPrediction(topicId, input, time())))
    },
    getPrediction,
    listPredictions({ topicId, status } = {}) {
      const records = db.prepare(`SELECT v.record_json FROM domain_prediction_versions v
        JOIN domain_predictions p ON p.prediction_id = v.prediction_id AND p.current_version = v.version
        ORDER BY p.prediction_id`).all().map((row) => parse(row.record_json))
      return records.filter((item) => (!topicId || item.topicId === topicId) && (!status || item.status === status))
    },
    updatePrediction(predictionId, patch, options = {}) {
      return transact(() => once(`prediction:update:${predictionId}`, options.idempotencyKey ?? patch?.idempotencyKey, patch, () => {
        requestRecord(patch)
        const previous = requirePrediction(predictionId)
        expectedVersion(patch.expectedVersion, previous.version)
        const normalized = normalizePrediction(patch, { previous })
        if (previous.type === 'binary' && ['draft', 'ready'].includes(previous.status) &&
          digest(normalized) === digest(normalizePrediction(previous))) return previous
        const topic = requireTopic(previous.topicId)
        const prediction = {
          ...previous, ...normalized, version: previous.version + 1, updatedAt: time(),
          scoringEligible: !previous.legacy && topic.sourceMode !== 'replay' && normalized.validation.ready,
        }
        db.prepare('INSERT INTO domain_prediction_versions VALUES (?, ?, ?)').run(predictionId, prediction.version, json(prediction))
        db.prepare('UPDATE domain_predictions SET current_version = ? WHERE prediction_id = ?').run(prediction.version, predictionId)
        return prediction
      }))
    },
    saveAgentSpec(input, options = {}) {
      return transact(() => once('agent:save', options.idempotencyKey ?? input?.idempotencyKey, input, () => {
        requestRecord(input)
        const agentSpecId = input.agentSpecId ?? generated('agent')
        const previous = getAgentSpec(agentSpecId)
        if (previous) expectedVersion(input.expectedVersion, previous.specVersion)
        const spec = { ...normalizeAgentSpec({ ...input, agentSpecId }, { previous, registeredToolIds }), createdAt: time() }
        db.prepare('INSERT INTO domain_agent_versions VALUES (?, ?, ?)').run(spec.agentSpecId, spec.specVersion, json(spec))
        return spec
      }))
    },
    getAgentSpec,
    listAgentSpecs() {
      return db.prepare(`SELECT v.record_json FROM domain_agent_versions v JOIN (
        SELECT agent_spec_id, MAX(spec_version) AS latest FROM domain_agent_versions GROUP BY agent_spec_id
      ) current ON current.agent_spec_id = v.agent_spec_id AND current.latest = v.spec_version
      ORDER BY v.agent_spec_id`).all().map((row) => parse(row.record_json))
    },
    addEvidence(topicId, input, options = {}) {
      return transact(() => once(`evidence:create:${topicId}`, options.idempotencyKey ?? input?.idempotencyKey, input, () => addEvidenceRecord(topicId, input, time())))
    },
    listEvidence({ topicId, predictionId, cutoff } = {}) {
      requireTopic(topicId)
      if (predictionId && requirePrediction(predictionId).topicId !== topicId) throw domainFailure('EVIDENCE_SCOPE_MISMATCH', '预测题不属于此主题。', 409)
      if (cutoff && !validDate(cutoff)) throw domainFailure('INVALID_DATE', '资料截点无效。')
      const records = db.prepare('SELECT record_json FROM domain_evidence WHERE topic_id = ? ORDER BY evidence_id').all(topicId).map((row) => parse(row.record_json))
      return records.filter((item) => (!predictionId || !item.predictionIds.length || item.predictionIds.includes(predictionId)) &&
        (!cutoff || Date.parse(item.firstSeenAt) <= Date.parse(cutoff) &&
          (!item.publishedAt || Date.parse(item.publishedAt) <= Date.parse(cutoff))))
    },
    importLegacy,
    getLegacyImport(sourceHash) {
      const row = db.prepare('SELECT plan_json FROM domain_legacy_imports WHERE source_hash = ?').get(sourceHash)
      return row ? parse(row.plan_json) : null
    },
    listLearningEntries() {
      return db.prepare(`SELECT source_hash, legacy_id, target_id, record_json FROM domain_legacy_mappings
        WHERE kind = 'settled-forecast' ORDER BY source_hash, legacy_id`).all().map((row) => {
        const item = parse(row.record_json)
        const original = item.data
        if (!Number.isFinite(original.probability) || original.probability < 0 || original.probability > 1 ||
          ![0, 1].includes(original.outcome)) return null
        return {
          entryId: `legacy_${digest([row.source_hash, row.legacy_id]).slice(0, 24)}`,
          predictionId: item.predictionId, question: original.target ?? '',
          probability: original.probability, outcome: original.outcome,
          brier: Number.isFinite(original.brier) ? original.brier : null,
          mode: item.originalMode, issuedAt: original.issuedAt ?? null, resolvedAt: original.resolvedAt ?? null,
          scoringEligible: false, status: 'legacy', missingFields: item.missingFields,
          sourceHash: row.source_hash, legacyId: row.legacy_id,
        }
      }).filter(Boolean)
    },
    close() {
      if (!closed) { db.close(); closed = true }
    },
  }
}
