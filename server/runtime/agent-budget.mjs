/** Public counters only; never model messages or private reasoning. */
export function workerBudgetState(budget, usage, { finishOnToolBudget = false } = {}) {
  const remaining = {
    modelRequests: Math.max(0, budget.maxModelRequests - usage.modelRequests),
    toolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
    totalTokens: Math.max(0, budget.maxTotalTokens - usage.totalTokens),
  }
  return {
    modelRequestIndex: usage.modelRequests,
    maxModelRequests: budget.maxModelRequests,
    investigationSteps: Math.max(0, budget.maxModelRequests - 1),
    reportStep: budget.maxModelRequests,
    outputTokens: Math.min(budget.maxTokens, remaining.totalTokens),
    remaining,
    reportOnly: finishOnToolBudget && (remaining.modelRequests === 0 || remaining.toolCalls === 0 || remaining.totalTokens <= (budget.reserveReportTokens || 0)),
    unknownUsage: Boolean(usage.unknownUsage),
  }
}

export function workerBudgetInstruction(budget, usage, options) {
  const current = workerBudgetState(budget, usage, options)
  return [
    '【本次执行与输出约束：由harness每次请求刷新】',
    `当前第${current.modelRequestIndex}/${budget.maxModelRequests}次模型请求；重试也计数。最多${current.investigationSteps}次调查决策，第${current.reportStep}次预留给提交报告；证据足够可提前结束，不能为凑轮数重复搜索。`,
    `本次输出上限${current.outputTokens} tokens（含模型思考与工具参数）；本任务累计上限${budget.maxTotalTokens} tokens。已返回用量${usage.totalTokens}，剩余${current.remaining.totalTokens}${current.unknownUsage ? '，部分调用实际用量未知，显示值不是精确余量' : ''}。`,
    `工具已用${usage.toolCalls}/${budget.maxToolCalls}；本次请求后剩余模型请求${current.remaining.modelRequests}，剩余工具调用${current.remaining.toolCalls}。`,
    '公开报告summary不超过300中文字；support和counterevidence各最多3条、每条claim不超过120字；missingEvidence最多5条；nextSuggestion不超过150字。字数与token是不同限制，均要遵守。',
    '报告公开结论、证据和缺口，不输出隐藏思维链。没有读到资料不等于资料不存在，更不等于事件没有发生。',
    current.reportOnly ? '现在是收尾阶段，只允许submit_report。依据已经实际取得的证据提交报告；不足则明确insufficient/blocked。不要再搜索或读网页，不编造答案。' : '先决定下一项最有价值的取证动作，或提交带引用的报告。之后的汇报/质询由主Agent安排，不自行无限循环。',
  ].join('\n')
}
