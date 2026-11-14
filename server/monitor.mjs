import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pollPublicSources } from './sources.mjs'
import { loadAgents } from './harness.mjs'

const materialForms = new Set(['10-K', '10-Q'])
const materialItems = new Set(['2.02', '2.05', '2.06'])
const chipPolicy = /(?:export (?:control|restriction|licen[sc]e)|exporting|H20|MI308|chip ban)/i
const sixHours = 6 * 60 * 60 * 1000
const sevenDays = 7 * 24 * 60 * 60 * 1000
const thirtyDays = 30 * 24 * 60 * 60 * 1000
const actorIds = ['policy', 'supply', 'company', 'market', 'chair']
const taskLabels = {
  analysis: { policy: '核对政策范围', supply: '检查供应链影响', company: '核对公司敞口', market: '检查市场信号' },
  challenge: '提出核查问题', review: '复核直接敞口', decision: '汇总本次研判',
}
const fixture = [
  { id: 'demo:notice', kind: 'filing', symbols: ['NVDA'], title: '模拟公告：芯片出口许可范围变化', summary: '演示事件。NVDA 报告一类芯片需要许可，AMD 的具体产品范围尚待核实。', filing: { form: '8-K', items: ['8.01'] } },
  { id: 'demo:administrative', kind: 'filing', symbols: ['AMD'], title: '模拟公告：一般行政事项', summary: '演示事件。此公告只涉及行政事项。', filing: { form: '8-K', items: ['5.02'] } },
]
const blank = () => ({ version: 1, sources: [], latestItems: [], decisions: [], latestMeeting: null, lastCheckAt: null, known: {}, pending: [], initialized: [] })
const sourceKey = (item) => item.sourceId === 'sec_edgar' && item.symbols[0]
  ? `sec_edgar:${item.symbols[0]}` : item.sourceId
const marketQuality = ({ yesPrice, bid, ask, liquidity } = {}) => [yesPrice, bid, ask, liquidity].every(Number.isFinite)
  && ask >= bid && ask - bid <= 0.1000001 && liquidity >= 1000

async function load(path) {
  if (!path) return blank()
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.pending) || !Array.isArray(data.initialized) || !data.known) {
      throw new Error('后台观察存档格式无效。')
    }
    return data
  } catch (error) {
    if (error.code === 'ENOENT') return blank()
    throw error
  }
}

async function save(path, data) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(data), 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function decide(item, previous, baseline, now) {
  if (baseline) return ['baseline', '首次同步，记入来源基线。']
  if (item.sourceId === 'demo') {
    if (previous) return null
    return item.id === fixture[0].id ? ['meeting', '演示公告涉及许可变化，且跨公司影响仍待确认。']
      : ['ignore', '行政事项，暂不召集会议。']
  }
  if (item.kind === 'filing') {
    if (previous) return null
    const age = now.valueOf() - Date.parse(item.publishedAt)
    if (!Number.isFinite(age) || age < 0 || age > sevenDays) return ['ignore', '披露时间缺失或已超出七天观察窗口。']
    if (materialForms.has(item.filing?.form?.replace(/\/A$/, '')) || item.filing?.items?.some((code) => materialItems.has(code)) || chipPolicy.test(item.title)) {
      return ['meeting', '新披露包含定期业绩、重大财务事项或芯片政策线索。']
    }
    return ['ignore', '公告索引未显示本研究室跟踪的实质性事项。']
  }
  if (!marketQuality(item.market)) {
    return previous ? null : ['ignore', '合约报价或流动性不足，保留作参考。']
  }
  const { yesPrice } = item.market
  if (!previous) return ['meeting', '发现主题相关且有可用盘口的预测合约，需核对其结算范围。']
  if (previous.price === null) return ['baseline', '首次获得该合约的可用报价，建立观察基线。']
  if (Math.abs(yesPrice - previous.price) >= 0.0999999 && now.valueOf() - Date.parse(previous.at) >= sixHours) {
    return ['meeting', '相关合约的可用报价相对上次记录变化至少 10 个百分点。']
  }
  return null
}

function demoPoll(now, startedAt) {
  const checkedAt = now.toISOString()
  const items = fixture.map((item, index) => ({
    ...item, sourceId: 'demo', url: null,
    publishedAt: new Date(startedAt + 12000 + index * 18000).toISOString(),
    observedAt: checkedAt,
  })).filter((item) => item.publishedAt <= checkedAt)
  return { items, sources: [{ id: 'demo', status: 'live', checkedAt, lastSuccessAt: checkedAt, itemCount: items.length, message: '正在监听模拟信号。' }] }
}

function simulatedFinding(agentId, item, side) {
  if (agentId === 'policy') return side
    ? '可能有共同敞口。请把文件写明的型号和仍需查证的型号逐项区分。'
    : '先核对公告与合约文字的适用范围，再判断是否涉及两家公司。'
  if (agentId === 'company') return side
    ? '目前只能确认公告所述公司的披露。另一家公司的适用范围暂时保留为待核查。'
    : `先从 ${item.symbols.join('、') || '相关公司'} 的直接证据查起，保留尚未确认的公司影响。`
  if (agentId === 'supply') return '如果措施只覆盖特定型号，替代空间要看产品与区域范围。需要进一步核查供应链。'
  if (agentId === 'market') return item.kind === 'prediction_market'
    ? '把价格当作合约本身的外部信号，并核对结算规则、盘口与相关公司之间的关系。'
    : '公告本身无法说明价格已经反映多少。还需对齐股票与行业行情。'
  return '已列出直接证据与待核查路径。优先查原始公告、具体产品和另一家公司的独立披露。'
}

async function discuss(job, { onEvent, provider, now, mockPacing }) {
  const { item, id } = job
  const startedAt = now().toISOString()
  const findings = []
  const agents = provider.mode === 'live' ? await loadAgents() : []
  const stage = (value) => onEvent({ type: 'stage', stage: value })
  const move = (agentIds, room) => onEvent({ type: 'movement', agentIds, room })
  async function speak(agentId, phase, prior = [], side = false) {
    const label = phase === 'analysis' ? taskLabels.analysis[agentId] : taskLabels[phase]
    const task = { type: 'task', agentId, taskId: `monitor-${agentId}-${phase}`, label, presentation: 'report' }
    onEvent({ ...task, status: 'start' })
    let message
    let sourceIds = [item.id]
    try {
      if (provider.mode === 'live') {
        const agent = agents.find((candidate) => candidate.id === agentId)
        const raw = await provider.decide({
          agentId, skill: agent.skillText, action: phase, cutoff: startedAt, branch: { id: 'base' },
          scope: 'live-monitor', tools: [{ evidence: [item] }], target: null, allowedIds: sourceIds, reports: prior,
          expectsProbability: false,
        })
        if (typeof raw?.finding !== 'string' || !raw.finding.trim() || raw.finding.length > 1200 ||
          raw.probability !== null || !Array.isArray(raw.evidenceIds) || raw.evidenceIds.some((id) => id !== item.id)) {
          throw new Error('后台会议模型输出未通过证据检查。')
        }
        message = raw.finding.trim()
        sourceIds = [...new Set(raw.evidenceIds)]
      } else {
        if (mockPacing) await wait(mockPacing * (phase === 'analysis' ? 900 + actorIds.indexOf(agentId) * 2200 : 2300))
        message = simulatedFinding(agentId, item, side)
      }
    } catch (error) {
      onEvent({ ...task, status: 'failed' })
      throw error
    }
    const finding = { agentId, message, sourceIds }
    findings.push(finding)
    onEvent({ ...task, status: 'complete', message, sourceIds })
    onEvent({ type: 'trace', row: { ...finding, taskId: task.taskId, id: `live-${findings.length}`, stage: phase, kind: 'message' } })
    return message
  }
  stage('start')
  move(actorIds, 'meeting')
  stage('analysis')
  const initial = await Promise.allSettled(actorIds.slice(0, -1).map((id) => speak(id, 'analysis')))
  const failed = initial.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
  if (item.id === fixture[0].id || item.kind === 'prediction_market' || chipPolicy.test(item.title)) {
    const agentIds = ['policy', 'company']
    const reason = '需要核实事件范围和公司的直接敞口是否一致。'
    stage('challenge')
    onEvent({ type: 'side-meeting', status: 'start', agentIds, reason })
    move(agentIds, 'side-meeting')
    await speak('policy', 'challenge', [...findings], true)
    await speak('company', 'review', [...findings], true)
    onEvent({ type: 'side-meeting', status: 'end', agentIds })
    move(agentIds, 'meeting')
  }
  stage('decision')
  const summary = await speak('chair', 'decision', [...findings])
  return { id, trigger: 'auto', headline: item.title, startedAt, completedAt: now().toISOString(), findings, evidence: [item], summary }
}

export function createMonitor({ mode, path, intervalMs, events, provider, mockPacing = 0, poll = pollPublicSources, now = () => new Date() }) {
  const ready = load(path)
  ready.catch(() => {})
  const startedAt = now().valueOf()
  let state
  let timer
  let nextCheckAt = null
  let stopped = false
  let running = false
  let error = null
  let jobPromise = null

  async function get() {
    const { sources, latestItems, decisions, latestMeeting, lastCheckAt } = state ?? await ready
    return structuredClone({ mode, sources, latestItems, decisions, latestMeeting, lastCheckAt, nextCheckAt, error })
  }

  async function commit(next) {
    await save(path, next)
    state = next
    events.publish({ type: 'monitor', monitor: await get() })
  }

  function launch(job) {
    jobPromise = events.run({ scope: 'monitor', trigger: 'auto', headline: job.item.title, runId: job.id }, async (run) => {
      const latestMeeting = await discuss(job, { ...run, provider, now, mockPacing })
      await commit({ ...state, latestMeeting, pending: state.pending.filter(({ id }) => id !== job.id) })
    }).catch(async () => {
      const pending = state.pending.map((entry) => entry.id === job.id
        ? { ...entry, attempts: (entry.attempts ?? 0) + 1,
          retryAt: new Date(now().valueOf() + Math.max(30000, intervalMs) * Math.min(16, 2 ** (entry.attempts ?? 0))).toISOString() } : entry)
      error = '后台会议未完成，已排定重试。'
      await commit({ ...state, pending })
    }).catch((cause) => {
      error = '后台会议存档失败，保留待处理事件。'
      console.error(cause.message)
    }).finally(() => { jobPromise = null })
  }

  async function tick() {
    if (running || mode === 'off') return
    running = true
    nextCheckAt = new Date(now().valueOf() + intervalMs).toISOString()
    try {
      state ??= await ready
      // Serialize writes with the worker meeting's durable acknowledgement.
      if (jobPromise) return
      const time = now()
      const next = structuredClone(state)
      if (mode === 'demo') next.demoStartedAt ??= startedAt
      const checked = mode === 'demo' ? demoPoll(time, next.demoStartedAt) : await poll({ now: time })
      next.lastCheckAt = time.toISOString()
      next.sources = checked.sources.map((source) => ({
        ...source,
        lastSuccessAt: source.lastSuccessAt ?? state.sources.find(({ id }) => id === source.id)?.lastSuccessAt ?? null,
      }))
      const incoming = [...checked.items].sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))
      const touched = new Set()
      const parents = new Set(next.pending.map(({ item }) => item.market?.eventSlug).filter(Boolean))
      for (const item of incoming) {
        if (touched.has(item.id)) continue
        touched.add(item.id)
        const previous = Object.hasOwn(next.known, item.id) ? next.known[item.id] : null
        const baseline = mode === 'public' && !state.initialized.includes(sourceKey(item))
        const result = decide(item, previous, baseline, time)
        if (result) {
          let [action, reason] = result
          const id = randomUUID()
          const at = time.toISOString()
          const parent = item.market?.eventSlug
          if (parent && action === 'meeting' && parents.has(parent)) {
            action = 'ignore'
            reason = '同一市场事件已有另一份合约进入本轮会议。'
          }
          if (parent && action === 'meeting') parents.add(parent)
          next.known[item.id] = { at, price: marketQuality(item.market) ? item.market.yesPrice : null,
            firstSeenAt: previous?.firstSeenAt ?? item.observedAt }
          next.decisions.unshift({ id, itemId: item.id, title: item.title, action, reason, at })
          if (action === 'meeting') next.pending.push({ id, item })
        }
      }
      for (const source of checked.sources) {
        if (!source.lastSuccessAt) continue
        const keys = source.id === 'sec_edgar'
          ? (source.coveredSymbols ?? []).map((symbol) => `sec_edgar:${symbol}`) : [source.id]
        for (const key of keys) if (!next.initialized.includes(key)) next.initialized.push(key)
      }
      next.latestItems = [...new Map(checked.items.map((item) => [item.id, {
        ...item, firstSeenAt: next.known[item.id]?.firstSeenAt ?? item.observedAt,
      }])).values(), ...next.latestItems.filter((item) => !touched.has(item.id)
        && !(item.sourceId === 'polymarket' && checked.sources.some((source) => source.id === item.sourceId && source.complete)))]
        .sort((a, b) => (b.firstSeenAt ?? b.observedAt).localeCompare(a.firstSeenAt ?? a.observedAt)).slice(0, 40)
      const outstanding = new Set(next.pending.map(({ item }) => item.id))
      for (const [id, known] of Object.entries(next.known)) {
        if (!touched.has(id) && !outstanding.has(id) && time.valueOf() - Date.parse(known.at) > thirtyDays) delete next.known[id]
      }
      next.decisions = next.decisions.slice(0, 60)
      const job = next.pending.find((entry) => !entry.retryAt || Date.parse(entry.retryAt) <= time.valueOf())
      error = null
      await commit(next)
      if (!stopped && job) launch(job)
    } catch (cause) {
      error = '后台同步失败，将自动重试。'
      console.error(cause.message)
      events.publish({ type: 'monitor', monitor: await get().catch(() => ({ mode, error })) })
    } finally {
      running = false
      if (!stopped) schedule(intervalMs)
    }
  }

  function schedule(delay) {
    nextCheckAt = new Date(now().valueOf() + delay).toISOString()
    timer = setTimeout(tick, delay)
    timer.unref()
  }

  return {
    get,
    start() { if (mode !== 'off' && !timer && !stopped) schedule(0) },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
