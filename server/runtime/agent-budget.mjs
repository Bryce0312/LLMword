/** Public counters only; never model messages or private reasoning. */
export function workerBudgetState(budget, usage, { finishOnToolBudget = false, forceReportOnly = false } = {}) {
  const remaining = {
    modelRequests: Math.max(0, budget.maxModelRequests - usage.modelRequests),
    toolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
    totalTokens: Math.max(0, budget.maxTotalTokens - usage.totalTokens),
  }
  const repairRequests = budget.inputAwareCloseout === true ? Math.min(budget.reportRepairRequests ?? 1, Math.max(0, budget.maxModelRequests - 1)) : 0
  const separatePhases = budget.inputAwareCloseout === true && Number.isInteger(budget.maxInvestigationRequests)
  const investigationSteps = Math.max(0, Math.min(budget.maxModelRequests - repairRequests - 1,
    separatePhases ? budget.maxInvestigationRequests : budget.maxModelRequests - 1))
  const reportStep = investigationSteps + 1
  const investigationUsed = separatePhases ? usage.investigationRequests ?? Math.max(0, usage.modelRequests - 1) : null
  return {
    modelRequestIndex: usage.modelRequests,
    maxModelRequests: budget.maxModelRequests,
    investigationSteps,
    reportStep,
    outputTokens: Math.min(budget.maxTokens, remaining.totalTokens),
    remaining,
    reportOnly: finishOnToolBudget && (forceReportOnly || (separatePhases ? investigationUsed >= investigationSteps : usage.modelRequests >= reportStep) || remaining.toolCalls === 0 || remaining.totalTokens <= (budget.reserveReportTokens || 0)),
    separatePhases,
    investigationUsed,
    reservedReportTokens: budget.reserveReportTokens || 0,
    reportRepairRequests: repairRequests,
    unknownUsage: Boolean(usage.unknownUsage),
  }
}

export function workerBudgetInstruction(budget, usage, options) {
  const current = workerBudgetState(budget, usage, options)
  return [
    '【本次执行与输出约束：由harness每次请求刷新】',
    `当前第${current.modelRequestIndex}/${budget.maxModelRequests}次模型请求；重试也计数。最多${current.investigationSteps}次调查决策，第${current.reportStep}次${current.reportRepairRequests ? `开始提交报告，另保留${current.reportRepairRequests}次报告修正机会` : '预留给提交报告'}；证据足够可提前结束，不能为凑轮数重复搜索。`,
    ...(current.separatePhases ? [`调查与报告分别计数：调查已用${current.investigationUsed}/${current.investigationSteps}次；报告首次提交后最多${current.reportRepairRequests}次结构化修正，不能回去反复搜索。零份本人已读原文时不能借用同伴编号；仅有搜索线索不足以提交带概率报告。`] : []),
    `本次输出上限${current.outputTokens} tokens（含模型思考与工具参数）；本任务累计上限${budget.maxTotalTokens} tokens。已返回用量${usage.totalTokens}，剩余${current.remaining.totalTokens}${current.unknownUsage ? '，部分调用实际用量未知，显示值不是精确余量' : ''}。`,
    `工具已用${usage.toolCalls}/${budget.maxToolCalls}；本次请求后剩余模型请求${current.remaining.modelRequests}，剩余工具调用${current.remaining.toolCalls}。`,
    ...(current.reservedReportTokens ? [`报告收尾保留额${current.reservedReportTokens} tokens，包含后续输入与输出的估计成本；程序会提前停止调查以保留交付机会。估算不是供应商精确账单，实际usage始终记账。`] : []),
    '公开报告summary不超过300中文字；support和counterevidence各最多3条、每条claim不超过120字；missingEvidence最多5条；nextSuggestion不超过150字。字数与token是不同限制，均要遵守。',
    '报告公开结论、证据和缺口，不输出隐藏思维链。没有读到资料不等于资料不存在，更不等于事件没有发生。',
    current.reportOnly ? '现在是收尾阶段，只允许submit_report。依据已经实际取得的证据提交报告；不足则明确insufficient/blocked。不要再搜索或读网页，不编造答案。' : '先决定下一项最有价值的取证动作，或提交带引用的报告。之后的汇报/质询由主Agent安排，不自行无限循环。',
  ].join('\n')
}
