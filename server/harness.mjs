import { readFile } from 'node:fs/promises'
import { createToolRegistry } from './tools.mjs'

const agents = [
  { id: 'policy', name: '小策', role: '政策研究', color: '#d58f57', skill: '政策分析', tools: ['search_evidence', 'verify_sources', 'read_factors'] },
  { id: 'supply', name: '小链', role: '供应链研究', color: '#7da699', skill: '供应链推演', tools: ['search_evidence', 'map_exposure', 'roll_scenario'] },
  { id: 'company', name: '小财', role: '公司基本面', color: '#9b86b5', skill: '公司敞口核验', tools: ['search_evidence', 'compare_charges', 'verify_sources', 'read_memory'] },
  { id: 'market', name: '小盘', role: '市场研究', color: '#9cae69', skill: '市场预期质疑', tools: ['read_factors', 'market_availability'] },
  { id: 'chair', name: '主持人', role: '会议主持', color: '#bb7d8e', skill: '会议与验证', tools: ['verify_sources', 'read_memory', 'roll_scenario', 'score_forecast'] },
]

export async function loadAgents() {
  return await Promise.all(agents.map(async (agent) => ({
    ...agent,
    skillText: (await readFile(new URL(`./skills/${agent.id}.md`, import.meta.url), 'utf8')).trim(),
  })))
}

const evidencePlans = {
  policy: { label: '查找政策依据', calls: [['search_evidence', { topic: 'policy' }], ['read_factors']] },
  supply: { label: '追踪供应链敞口', calls: [['search_evidence', { topic: 'supply' }], ['map_exposure'], ['roll_scenario']] },
  company: { label: '核对公司披露', calls: [['search_evidence', { topic: 'exposure' }], ['compare_charges'], ['read_memory']] },
  market: { label: '检查市场行情覆盖', calls: [['read_factors'], ['market_availability']] },
}

const reportLabels = {
  analyze: '形成独立判断',
  challenge: '形成复核问题',
  revise: '更新复核判断',
  summarize: '形成会议结论',
}

export function traceRecorder(onEvent) {
  const rows = []
  return {
    rows,
    add(agentId, stage, kind, message, tool, sourceIds = [], taskId) {
      const row = { id: `line-${rows.length + 1}`, agentId, stage, kind, message, tool, sourceIds }
      if (taskId) row.taskId = taskId
      rows.push(row)
      onEvent?.({ type: 'trace', stage, agentId, row })
    },
  }
}

function validated(raw, allowed, expectsProbability) {
  if (!raw || typeof raw.finding !== 'string' || !raw.finding.trim() || raw.finding.length > 1200 ||
    !Array.isArray(raw.evidenceIds) || raw.evidenceIds.some((id) => !allowed.includes(id))) {
    throw new Error('模型输出未通过结构或引用检查。')
  }
  const evidenceIds = [...new Set(raw.evidenceIds)]
  if (raw.probability !== null &&
    (!expectsProbability || !Number.isFinite(raw.probability) || raw.probability < 0 ||
      raw.probability > 1 || evidenceIds.length === 0)) {
    throw new Error('模型输出的概率或证据不符合预测契约。')
  }
  return { finding: raw.finding.trim(), evidenceIds, probability: raw.probability }
}

function meanProbability(reports) {
  const values = reports.map((report) => report.probability).filter((value) => value !== null)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

const roundProbability = (value) => Math.round(Math.min(0.99, Math.max(0.01, value)) * 1000) / 1000

function dissentReason(context, reports) {
  if (context.target?.id === 'amd-license' && !context.evidence.some((item) => item.id === 'amd-8k')) {
    return 'AMD 年报只证实既有许可敞口，本次措施是否覆盖具体型号仍需核验。'
  }
  const estimates = reports.map((report) => report.probability).filter((value) => value !== null)
  const spread = estimates.length > 1 ? Math.max(...estimates) - Math.min(...estimates) : 0
  return spread + Number.EPSILON >= 0.15
    ? `独立判断相差 ${Math.round(spread * 100)} 个百分点，需要核查分歧的依据。`
    : null
}

export async function holdMeeting({ agents: roster, provider, context, onEvent }) {
  const trace = traceRecorder(onEvent)
  const tool = createToolRegistry(context, trace.add, onEvent)
  const { cutoff, branch, learning } = context
  const target = context.target ? { id: context.target.id, question: context.target.question } : null
  const chair = roster.find((agent) => agent.id === 'chair')
  const specialists = roster.filter((agent) => agent.id !== chair.id)
  const agentIds = roster.map((agent) => agent.id)
  const emitStage = (stage, id) => onEvent?.({ type: 'stage', stage, agentId: id })
  const move = (stage, room, participants) => onEvent?.({ type: 'movement', stage, room, agentIds: participants })
  const reportTask = (agent, action) => ({
    type: 'task', presentation: 'report', agentId: agent.id, taskId: `${agent.id}-${action}`, label: reportLabels[action],
  })
  const recordReport = (agent, action, stage, report) => {
    const task = reportTask(agent, action)
    onEvent?.({ ...task, status: 'complete', message: report.finding, sourceIds: report.evidenceIds })
    trace.add(agent.id, stage, 'message', report.finding, undefined, report.evidenceIds, task.taskId)
  }
  const call = async (agent, action, tools, allowedIds, reports, expectsProbability, details) => {
    onEvent?.({ ...reportTask(agent, action), status: 'start' })
    const raw = await provider.decide({
      agentId: agent.id, skill: agent.skillText, action, cutoff, branch, target, tools,
      allowedIds, reports, expectsProbability, followUp: learning.resolved > 0, ...details,
    })
    return validated(raw, allowedIds, expectsProbability)
  }

  emitStage('start', chair.id)
  move('start', 'desks', agentIds)
  trace.add(chair.id, 'start', 'harness', `封存回放截点 ${cutoff}。各席独立阅读档案。`)
  emitStage('analysis')
  let analyzing = true
  let atRoundTable = false
  const reports = await Promise.all(specialists.map(async (agent) => {
    const { calls, label } = evidencePlans[agent.id]
    const results = tool.batch(agent, calls, `${agent.id}-lookup`, label)
    const allowedIds = [...new Set(results.flatMap((result) => result.sourceIds))]
    const report = await call(agent, 'analyze', results, allowedIds, undefined, Boolean(target) && agent.id !== 'market')
    if (analyzing) {
      if (!atRoundTable) {
        move('analysis', 'meeting', agentIds)
        atRoundTable = true
      }
      recordReport(agent, 'analyze', 'analysis', report)
    }
    return { agentId: agent.id, ...report }
  })).finally(() => { analyzing = false })

  const beforeMeeting = meanProbability(reports)
  const reason = target ? dissentReason(context, reports) : null
  const [scenario] = tool.batch(chair, [['roll_scenario']], 'chair-scenario', '推演影响路径')
  const revised = [...reports]
  if (reason) {
    const company = specialists.find((agent) => agent.id === 'company')
    const position = reports.findIndex((report) => report.agentId === company.id)
    const participants = [chair.id, company.id]
    const sideMeeting = { type: 'side-meeting', room: 'side-meeting', agentIds: participants, reason }
    try {
      onEvent?.({ ...sideMeeting, stage: 'challenge', status: 'start' })
      move('challenge', 'side-meeting', participants)
      emitStage('challenge', chair.id)
      const memory = tool.call(chair, 'read_memory')
      const allowedIds = [...new Set(reports.flatMap((report) => report.evidenceIds))]
      const objection = await call(chair, 'challenge', [scenario, memory], allowedIds, reports, false, { dissentReason: reason })
      recordReport(chair, 'challenge', 'challenge', objection)
      emitStage('review', company.id)
      const [check] = tool.batch(company, [['verify_sources', { ids: objection.evidenceIds }]], 'company-verify', '复核异议出处')
      const review = await call(company, 'revise', [check], check.sourceIds, [reports[position], objection], true)
      revised[position] = { agentId: company.id, ...review }
      recordReport(company, 'revise', 'review', review)
    } finally {
      onEvent?.({ ...sideMeeting, stage: 'review', status: 'end' })
      move('review', 'meeting', participants)
    }
  }

  emitStage('decision', chair.id)
  const modelProbability = meanProbability(revised)
  const probability = modelProbability === null ? null : roundProbability(modelProbability + learning.adjustment)
  const ids = [...new Set(revised.flatMap((report) => report.evidenceIds))]
  const citations = tool.call(chair, 'verify_sources', { ids })
  const synthesis = await call(chair, 'summarize', [scenario, citations], citations.sourceIds, revised, false, { reviewed: Boolean(reason) })
  recordReport(chair, 'summarize', 'decision', synthesis)
  if (probability !== null && learning.resolved) {
    trace.add(chair.id, 'decision', 'harness', `应用此前已结算结果的有界校正（${(learning.adjustment * 100).toFixed(1)} 个百分点）。`, 'read_memory')
  }

  return {
    forecast: {
      probability,
      prior: beforeMeeting === null ? null : roundProbability(beforeMeeting),
      beforeLearning: modelProbability === null ? null : roundProbability(modelProbability),
      target: target?.question ?? null,
      branch: branch.id,
      branchLabel: branch.label,
      marketProbability: null,
      marketTarget: '行业相对收益 · 缺少对齐行情，暂未估计',
      paths: scenario.paths,
      transitions: scenario.transitions,
      summary: synthesis.finding,
      sourceIds: synthesis.evidenceIds,
    },
    trace: trace.rows,
  }
}
