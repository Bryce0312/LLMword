import test from 'node:test'
import assert from 'node:assert/strict'
import { workerBudgetState, workerBudgetInstruction } from './agent-budget.mjs'

const budget = { maxModelRequests: 6, maxToolCalls: 6, maxTotalTokens: 65536, maxTokens: 32768 }
const usage = { modelRequests: 2, toolCalls: 3, totalTokens: 10000, unknownUsage: false }
test('system budget instruction describes output characters, tokens, actual remaining counters, and the distinct report step', () => {
  const current = workerBudgetState(budget, usage, { finishOnToolBudget: true })
  assert.deepEqual(current.remaining, { modelRequests: 4, toolCalls: 3, totalTokens: 55536 })
  assert.equal(current.reportOnly, false)
  const prompt = workerBudgetInstruction(budget, usage, { finishOnToolBudget: true })
  for (const fragment of ['第2/6', '最多5次调查', '第6次预留', '32768 tokens', '65536', '55536', '300中文字', '最多3条', '隐藏思维链']) assert(prompt.includes(fragment), fragment)
})
test('final model request and an exhausted tool allowance require reports, while generic non-course workers keep their existing tool policy', () => {
  assert(workerBudgetState(budget, { ...usage, modelRequests: 6 }, { finishOnToolBudget: true }).reportOnly)
  assert(workerBudgetState(budget, { ...usage, toolCalls: 6 }, { finishOnToolBudget: true }).reportOnly)
  assert(!workerBudgetState(budget, { ...usage, modelRequests: 6 }).reportOnly)
  assert(workerBudgetInstruction(budget, { ...usage, modelRequests: 6 }, { finishOnToolBudget: true }).includes('只允许submit_report'))
})
test('remaining token cap never exceeds the task remainder and unknown usage is not described as an exact budget', () => {
  const state = { ...usage, totalTokens: 65000, unknownUsage: true }
  assert.equal(workerBudgetState(budget, state).outputTokens, 536)
  assert(workerBudgetInstruction(budget, state).includes('不是精确余量'))
})

test('new input-aware assignments reserve a correction request without reinterpreting legacy reserved budgets', () => {
  const legacy = { ...budget, reserveReportTokens: 14000 }
  const current = { ...legacy, inputAwareCloseout: true, reportRepairRequests: 1 }
  assert.equal(workerBudgetState(legacy, { ...usage, modelRequests: 5 }, { finishOnToolBudget: true }).reportOnly, false)
  const state = workerBudgetState(current, { ...usage, modelRequests: 5 }, { finishOnToolBudget: true })
  assert.equal(state.reportOnly, true)
  assert.equal(state.reportStep, 5)
  assert.equal(state.investigationSteps, 4)
  assert(workerBudgetInstruction(current, { ...usage, modelRequests: 5 }, { finishOnToolBudget: true }).includes('1次报告修正'))
})

test('explicit investigation decisions and report repairs are distinct while total requests remain capped', () => {
  const current = { ...budget, maxModelRequests: 10, maxToolCalls: 8, maxInvestigationRequests: 6, inputAwareCloseout: true, reportRepairRequests: 2 }
  const before = workerBudgetState(current, { ...usage, modelRequests: 6, investigationRequests: 5, reportRequests: 0 }, { finishOnToolBudget: true })
  assert.equal(before.reportOnly, false)
  assert.equal(before.reportStep, 7)
  assert.equal(before.investigationSteps, 6)
  const report = workerBudgetState(current, { ...usage, modelRequests: 7, investigationRequests: 6, reportRequests: 0 }, { finishOnToolBudget: true })
  assert.equal(report.reportOnly, true)
  assert.equal(report.reportRepairRequests, 2)
  assert(workerBudgetInstruction(current, { ...usage, modelRequests: 7, investigationRequests: 6 }, { finishOnToolBudget: true }).includes('调查与报告分别计数'))
  assert.equal(workerBudgetState({ ...current, inputAwareCloseout: false }, { ...usage, modelRequests: 7 }, { finishOnToolBudget: true }).reportOnly, false)
})
