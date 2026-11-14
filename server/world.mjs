import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { branches, caseInfo, observe, stages, targets, timeline } from './case.mjs'
import { holdMeeting, loadAgents, traceRecorder } from './harness.mjs'
import { createProvider } from './provider.mjs'
import { createToolRegistry, toolCatalog } from './tools.mjs'

const initialState = () => ({ version: 1, step: 0, pending: {}, history: [], forecast: null, trace: [] })

function adjustment(history) {
  const residual = history.reduce((sum, item) => sum + item.outcome - item.probability, 0)
  return Math.max(-0.12, Math.min(0.12, residual / (history.length + 5)))
}

function eligibleLearning(state, cutoff, mode) {
  const history = state.history.filter((item) => item.mode === mode && Date.parse(item.resolvedAt) <= Date.parse(cutoff))
  return {
    history,
    resolved: history.length,
    adjustment: adjustment(history),
    brier: history.length ? history.reduce((sum, item) => sum + item.brier, 0) / history.length : null,
    description: '按已揭晓事件的残差更新下一次预测。使用五条零残差先验收缩，校正最多 ±12 个百分点。',
  }
}

async function loadState(path) {
  if (!path) return initialState()
  try {
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (state.version !== 1 || !Number.isInteger(state.step) || state.step < 0 || state.step >= stages.length ||
      !state.pending || !Array.isArray(state.history) || !Array.isArray(state.trace)) {
      throw new Error('研究室存档格式无效。')
    }
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return initialState()
    throw error
  }
}

async function saveState(path, state) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function currentOutcome(step) {
  const latest = targets.findLast((target) => target.resolveStep <= step)
  if (!latest) return null
  return {
    value: latest.value,
    label: latest.label,
    sourceIds: latest.sourceIds,
    target: latest.question,
    resolvedAt: stages[latest.resolveStep].date,
  }
}

export function createWorld({ statePath, provider = createProvider(), onEvent: defaultOnEvent } = {}) {
  const ready = Promise.all([loadState(statePath), loadAgents()])
  // The first request reports load errors even if loading fails before it arrives.
  ready.catch(() => {})
  let current
  let queue = Promise.resolve()

  function enqueue(action) {
    const result = queue.then(async () => {
      const [initial] = await ready
      current ??= initial
      return await action()
    })
    queue = result.catch(() => {})
    return result
  }

  async function snapshot() {
    const [initial, agents] = await ready
    current ??= initial
    const observed = observe(current.step)
    return structuredClone({
      case: caseInfo,
      step: current.step,
      totalSteps: stages.length,
      cutoff: observed.cutoff,
      mode: provider.mode,
      agents,
      companies: observed.companies,
      factors: observed.factors,
      evidence: observed.evidence,
      question: observed.target?.question ?? null,
      stages: timeline(current.step),
      branches: Object.values(branches),
      forecast: current.forecast,
      trace: current.trace,
      learning: eligibleLearning(current, observed.cutoff, provider.mode),
      outcome: currentOutcome(current.step),
      tools: toolCatalog,
    })
  }

  async function commit(next) {
    await saveState(statePath, next)
    current = next
    return await snapshot()
  }

  return {
    get: snapshot,
    run: ({ branch = 'base', runId = randomUUID(), onEvent = defaultOnEvent } = {}) => enqueue(async () => {
      if (!Object.hasOwn(branches, branch)) {
        throw Object.assign(new Error('情景必须是 base、narrow 或 broad。'), { status: 400 })
      }
      const context = observe(current.step)
      const [, agents] = await ready
      let sequence = 0
      const result = await holdMeeting({
        agents,
        provider,
        onEvent: onEvent && ((event) => onEvent(structuredClone({ ...event, runId, sequence: ++sequence }))),
        context: {
          ...context, branch: branches[branch], learning: eligibleLearning(current, context.cutoff, provider.mode),
        },
      })
      const { target } = context
      const next = { ...current, ...result, pending: { ...current.pending } }
      if (target && branch === 'base' && result.forecast.probability !== null) {
        if (!next.pending[target.id]) {
          next.pending[target.id] = { probability: result.forecast.probability, issuedAt: context.cutoff, mode: provider.mode }
        }
        next.forecast = { ...result.forecast, lockedProbability: next.pending[target.id].probability }
      }
      return await commit(next)
    }),
    advance: () => enqueue(async () => {
      if (current.step === stages.length - 1) return await snapshot()
      const step = current.step + 1
      const context = observe(step)
      const trace = traceRecorder()
      const next = { ...current, step, forecast: null, trace: trace.rows, history: [...current.history], pending: { ...current.pending } }
      const [, agents] = await ready
      const chair = agents.find((agent) => agent.id === 'chair')
      trace.add(chair.id, 'observation', 'harness', '推进回放时钟。已按公开时间更新共享事实。', undefined,
        context.evidence.filter((item) => item.publishedAt === context.cutoff).map((item) => item.id))
      for (const target of targets.filter((item) => item.resolveStep === step)) {
        const pending = next.pending[target.id]
        if (!pending || Date.parse(pending.issuedAt) >= Date.parse(context.cutoff)) continue
        const { probability, issuedAt, mode } = pending
        const tool = createToolRegistry(context, trace.add)
        const { brier } = tool.call(chair, 'score_forecast', { probability, value: target.value })
        next.history.push({
          target: target.question, targetId: target.id, probability, outcome: target.value,
          brier, issuedAt, resolvedAt: context.cutoff, mode, sourceIds: target.sourceIds,
        })
        delete next.pending[target.id]
        trace.add(chair.id, 'settle', 'harness', `预测已结算，Brier 分数 ${brier.toFixed(3)}。反馈可用于下一次预测。`, 'score_forecast', target.sourceIds)
      }
      return await commit(next)
    }),
    reset: () => enqueue(() => commit(initialState())),
  }
}
