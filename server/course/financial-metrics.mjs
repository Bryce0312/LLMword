const units = { million: 1e6, billion: 1e9, hundred_million: 1e8, unit: 1 }
const figureSchema = { type: 'object', additionalProperties: false, properties: {
  value: { type: 'number' }, scale: { enum: Object.keys(units) }, currency: { enum: ['USD', 'CNY'] },
  period: { type: 'string', minLength: 1, maxLength: 100 }, accounting: { enum: ['GAAP', 'non-GAAP', 'unspecified'] },
  evidenceId: { type: 'string', minLength: 1 }, quote: { type: 'string', minLength: 8, maxLength: 1200 },
}, required: ['value', 'scale', 'currency', 'period', 'accounting', 'evidenceId', 'quote'] }
export function createFinancialMetricsTool({ getEvidence, now = () => new Date().toISOString() }) {
  return { toolId: 'compare_financial_metrics', version: 1, timeoutMs: 1000,
    description: '统计席对本人已读财报的两个同口径数字做确定性单位换算与增长率计算。需逐字原文、证据号、期间、币种及GAAP口径；不计算股价因果，不猜缺失单位。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { metric: { type: 'string', minLength: 1, maxLength: 100 }, comparison: { enum: ['year-over-year', 'quarter-over-quarter', 'guidance-comparison'] }, current: figureSchema, previous: figureSchema }, required: ['metric', 'comparison', 'current', 'previous'] },
    async execute(args) {
      const error = (code, message) => ({ status: 'error', data: null, evidenceIds: [], summary: message, error: { code, message, retryable: false }, observedAt: now(), usage: { providerRequests: 0 } })
      for (const figure of [args.current, args.previous]) {
        const evidence = getEvidence(figure.evidenceId)
        if (!evidence?.text?.includes(figure.quote)) return error('FINANCIAL_EVIDENCE', '计算必须引用本人本轮已读正文中的逐字片段。')
        const numbers = figure.quote.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || []
        if (!Number.isFinite(figure.value) || !numbers.some((value) => Number(value.replaceAll(',', '')) === figure.value)) return error('FINANCIAL_NUMBER', '原文片段未包含该数值，不能执行计算。')
        const unitPresent = { billion: /billion|十亿/i, million: /million|百万/i, hundred_million: /亿/, unit: /per share|每股|\bUSD\b|美元|\$/i }[figure.scale]?.test(figure.quote)
        const currencyPresent = (figure.currency === 'USD' ? /\bUSD\b|美元|dollars?|\$/i : /\bCNY\b|\bRMB\b|人民币/i).test(figure.quote)
        if (!unitPresent || !currencyPresent || figure.scale === 'hundred_million' && /十亿/.test(figure.quote)) return error('FINANCIAL_UNIT', '原文引用须明确币种和单位；表格请同时引用单位表头。')
        if (figure.accounting === 'non-GAAP' && !/non[- ]?GAAP/i.test(figure.quote) || figure.accounting === 'GAAP' && !/(?<!non[- ])\bGAAP\b/i.test(figure.quote)) return error('FINANCIAL_ACCOUNTING', '引用片段未支持声明的会计口径。')
      }
      const { current, previous } = args
      const period = (value) => { const m = /Q([1-4])\s*(?:FY)?\s*(20\d\d)/i.exec(value); return m && { quarter: Number(m[1]), year: Number(m[2]) } }
      const currentPeriod = period(current.period), previousPeriod = period(previous.period)
      if (args.comparison !== 'guidance-comparison' && (!currentPeriod || !previousPeriod ||
        (args.comparison === 'year-over-year' ? currentPeriod.quarter !== previousPeriod.quarter || currentPeriod.year - previousPeriod.year !== 1 : (currentPeriod.year - previousPeriod.year) * 4 + currentPeriod.quarter - previousPeriod.quarter !== 1))) return error('FINANCIAL_PERIOD', '同比须同季度相邻财年，环比须相邻季度；期间请写为Q3 FY2027等明确格式。')
      if (current.currency !== previous.currency || current.accounting !== previous.accounting || current.period === previous.period) return error('FINANCIAL_BASIS', '币种、会计口径须一致，期间须明确且不同。')
      const currentValue = current.value * units[current.scale], previousValue = previous.value * units[previous.scale]
      if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue <= 0) return error('FINANCIAL_BASELINE', '比较基数须为有限正数。')
      const growthPercent = (currentValue / previousValue - 1) * 100
      if (!Number.isFinite(growthPercent)) return error('FINANCIAL_BASELINE', '增长率超出有限数值范围。')
      return { status: 'ok', data: { metric: args.metric, comparison: args.comparison, currentPeriod: current.period, previousPeriod: previous.period,
        currentValue, previousValue, currency: current.currency, accounting: current.accounting, growthPercent, formula: '(current / previous - 1) * 100',
        qualification: '已校验引用与数值，指标名称及期间归属仍须核验；这是增长率，不是股价影响或因果估计。' },
        evidenceIds: [...new Set([current.evidenceId, previous.evidenceId])], summary: `${args.metric}对比变化为${growthPercent.toFixed(2)}%；请核验期间与指标归属。`, observedAt: now(), error: null, usage: { providerRequests: 0 } }
    } }
}
