/** Resume input contains public worker receipts, not earlier model dialogue or repeated role catalogues. */
export function researchSummaryMessages(question, assignments, evidence, forecastContract = null) {
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : ''
  const reports = assignments.filter((item) => item.report).map((item) => ({
    assignmentId: item.assignmentId, roleId: item.roleId, status: item.report.status, summary: text(item.report.summary, 400),
    evidenceIds: item.report.evidenceIds,
    support: (item.report.support || []).slice(0, 2).map((claim) => ({ claim: text(claim.claim, 280), evidenceIds: claim.evidenceIds, basis: claim.basis, citations: claim.citations })),
    counterevidence: (item.report.counterevidence || []).slice(0, 2).map((claim) => ({ claim: text(claim.claim, 280), evidenceIds: claim.evidenceIds, basis: claim.basis, citations: claim.citations })),
    missingEvidence: (item.report.missingEvidence || []).slice(0, 3).map((value) => text(value, 160)),
  }))
  const used = new Set(reports.flatMap((item) => item.evidenceIds || []))
  if (forecastContract?.priceResolution) for (const evidenceId of [forecastContract.priceFinalSnapshot?.quoteEvidenceId, forecastContract.priceFinalSnapshot?.historyEvidenceId]) if (evidenceId) used.add(evidenceId)
  const messages = [{ role: 'system', content: '你是财报核验任务的汇总Agent。仅依据以下本轮已完成研究员报告整理研报，直接调用submit_research_report；不足则mark_insufficient。不可派工、联网或编造新证据，不创建未来预测、不输出概率。引用只能使用所列evidenceId；逐报告decisionNotes指向assignmentId及该报告的来源。区分本期/往期引语、正式财报/预期/行业假设，保留冲突与限制。输入为经过长度约束的公开报告摘要，完整原文和报告保留在应用，摘要未覆盖之处不得声称已核验。summary≤400中文字，findings≤6条，每条≤150字，limitations≤5条；不要输出自然语言前言或重复思考。' },
    { role: 'user', content: JSON.stringify({ kind: 'course-main', phase: 'review', purpose: 'research', question: text(question, 1000), reports,
      evidence: evidence.filter((item) => used.has(item.evidenceId)).map(({ evidenceId, title, url, publishedAt, text: body, citationHints }) => ({ evidenceId, title: text(title, 180), url, publishedAt, ...(forecastContract?.priceResolution ? { text: text(body, 1200), citationHints } : {}) })) }) }]
  if (forecastContract) {
    messages[0].content = '你是短窗口二元预测协调员。仅用已有独立报告直接调用propose_forecast（outcomeKnown=false），不足则mark_insufficient；不能取证或补查。当前状态不是目标后的结果。逐条reasoningClaims提供basis=fact/inference、evidenceIds与citations:[{evidenceId,quote}]；fact只复述片段中的字段和值，数字/日期须被片段覆盖。快照取得时间与警告发出时间分开，不将两者到目标的间隔混用。未来概率及持续性属于未校准推断，不写成已验证的频率；失败席位不能声称已完成。保留限制与decisionNotes。summary≤400字，依据≤5条。'
    if (forecastContract.priceResolution) messages[0].content = '你是Binance BTC-USDT短窗口预测协调员，USDT不是USD。三份独立上下文报告都须完整；仅用这些报告直接propose_forecast(outcomeKnown=false)，不足mark_insufficient，禁止补查/联网。固定基准为normalized.baseline，不得另选当前更有利价格；分钟桶仅作已发生研究背景，不能充作未来spot结果。三席来自同一Binance来源，不称独立交易所验证。根据样本方向与局限给有限、未校准概率，缺乏信号可接近0.5；不捏造宏观新闻、频率/准确率或因果。summary≤220中文字，不复述未经核对的绝对时间/分钟数；不称目标已经到达。reasoningClaims最多3条，每条一个原子主张，basis=fact或inference，所有来源附真实连续短片段citations；数字事实必须原样出现在片段，计算/概率标inference。逐份decisionNotes引用原assignmentId及该报告证据。sourceLimitations与dissent保留样本有限、来源单一、未来不确定。'
    if (forecastContract.priceResolution) messages[0].content += ' 系统已在三席报告后刷新现价及历史摘要，normalized.latestReference是最新观察，baseline仍为初始固定基准；优先结合最新观察作预测。引用优先逐字复制对应evidence.citationHints；不要给JSON子集添右括号。目标时刻来自契约而非原文，把比较/目标时间判断标inference。若原报告记录的是较早价格，只作其当时快照，不当成最新现价。'
    const context = JSON.parse(messages[1].content)
    Object.assign(context, { purpose: 'forecast', groundingPolicy: forecastContract.groundingPolicy || null, normalized: forecastContract, timeContext: forecastContract.timeContext })
    messages[1].content = JSON.stringify(context)
  }
  return messages
}

/** A provider preflight rejection has no global model reservation; complete worker checkpoints allow reconciliation. */
export function unsentSummaryRequest(run, assignments) {
  return Boolean(run.error?.code === 'COURSE_BUDGET' && run.state.summaryResumeCount && !run.state.summaryBudgetRetryCount && assignments.length &&
    assignments.every((item) => item.status === 'completed' && Number.isInteger(item.checkpoint?.usage?.modelRequests)) &&
    (run.state.main?.calls || 0) + assignments.reduce((sum, item) => sum + item.checkpoint.usage.modelRequests, 0) - run.usage.modelRequests === 1)
}
