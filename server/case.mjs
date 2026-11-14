// The SEC acceptance time is the replay clock for filings. It is not
// necessarily the exact first moment the information was publicly visible.
export const caseInfo = {
  id: 'gpu-exports-2025',
  title: '一条政策，两家芯片公司',
  description: '重放 2025 年 AI 芯片出口许可事件。跟踪同一政策如何改变 NVIDIA 与 AMD 的产品敞口，并在后续披露到来前封存预测。',
  clock: 'SEC 接收时间（美东）。采用 10-K 作此前的基线资料。',
}

export const stages = [
  { title: '初始披露', description: '开始时可见的监管冲击', date: '2025-04-15T17:22:59-04:00' },
  { title: '下一份公开材料', description: '前一预测进入核验', date: '2025-04-16T09:03:30-04:00' },
  { title: '财务核验', description: '核对第二个预测', date: '2025-05-28T16:21:30-04:00' },
  { title: '事件尾声', description: '查阅后续经营披露', date: '2025-08-05T16:16:31-04:00' },
]

const evidenceLog = [
  {
    id: 'amd-10k', title: 'AMD 年报｜既有出口敞口', source: 'AMD 10-K',
    publishedAt: '2025-02-05T16:42:57-05:00',
    url: 'https://ir.amd.com/financial-information/sec-filings/content/0000002488-25-000012/amd-20241228.htm',
    summary: 'AMD 此前已披露某些 Instinct 芯片出口需获许可。年报说明公司经营数据中心 GPU，也提供了产品范围需要逐项核验的依据。',
    topics: ['policy', 'supply', 'exposure'], tickers: ['AMD'],
  },
  {
    id: 'nvda-8k', title: 'NVIDIA 8-K｜H20 需出口许可', source: 'SEC · NVIDIA 8-K',
    publishedAt: stages[0].date,
    url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581025000082/nvda-20250409.htm',
    summary: 'NVIDIA 披露 H20 以及达到相关内存或互连带宽标准的其他芯片，出口至中国等地须获许可。公司预计本季度相关计提最高约 55 亿美元。',
    topics: ['policy', 'supply', 'exposure', 'charge'], tickers: ['NVDA'],
  },
  {
    id: 'amd-8k', title: 'AMD 8-K｜MI308 同样受限', source: 'SEC · AMD 8-K',
    publishedAt: stages[1].date,
    url: 'https://www.sec.gov/Archives/edgar/data/2488/000000248825000039/amd-20250415.htm',
    summary: 'AMD 确认新许可要求也适用于 MI308，预计相关库存、采购承诺及其他准备最高约 8 亿美元。',
    topics: ['policy', 'supply', 'exposure', 'charge'], tickers: ['AMD'],
  },
  {
    id: 'nvda-q1', title: 'NVIDIA 季报｜H20 实际计提', source: 'SEC · NVIDIA 季度业绩',
    publishedAt: stages[2].date,
    url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581025000115/q1fy26pr.htm',
    summary: 'NVIDIA 公布 2026 财年第一季度业绩，披露 H20 相关库存及采购义务计提为 45 亿美元。',
    topics: ['exposure', 'charge'], tickers: ['NVDA'],
  },
  {
    id: 'amd-q2', title: 'AMD 季报｜MI308 实际计提', source: 'SEC · AMD 季度业绩',
    publishedAt: stages[3].date,
    url: 'https://www.sec.gov/Archives/edgar/data/2488/000000248825000106/q22025991.htm',
    summary: 'AMD 公布 2025 年第二季度业绩，披露 MI308 出口管制导致约 8 亿美元的库存及相关计提。',
    topics: ['exposure', 'charge'], tickers: ['AMD'],
  },
]

export const targets = [
  {
    id: 'amd-license', issueStep: 0, resolveStep: 1, initial: 0.50, value: 1,
    question: 'AMD 会在接下来五个工作日内确认同类芯片受限吗？',
    label: '已确认 · AMD 披露 MI308 适用新许可要求',
    sourceIds: ['amd-8k'],
  },
  {
    id: 'nvda-charge', issueStep: 1, resolveStep: 2, initial: 0.50, value: 1,
    question: 'NVIDIA 本财季披露的 H20 相关计提会超过 40 亿美元吗？',
    label: '已确认 · NVIDIA 公布 H20 相关计提 45 亿美元',
    sourceIds: ['nvda-q1'],
  },
]

export const branches = {
  base: { id: 'base', label: '按现有证据', assumption: '仅使用当前可见证据，保留尚未证实的路径。' },
  narrow: { id: 'narrow', label: '许可范围偏窄', assumption: '假设许可范围只覆盖已确认的产品，替代需求可能转移到其他产品。' },
  broad: { id: 'broad', label: '许可范围偏广', assumption: '假设更多同类产品受到限制，替代空间缩小，共同敞口放大。' },
}

export function observe(step) {
  const cutoff = stages[step].date
  const evidence = evidenceLog.filter((item) => Date.parse(item.publishedAt) <= Date.parse(cutoff))
  const has = (id) => evidence.some((item) => item.id === id)
  const amd = has('amd-8k')
  const nvdaCharge = has('nvda-q1')
  const amdCharge = has('amd-q2')
  const companies = [
    { ticker: 'NVDA', name: 'NVIDIA', exposure: 'H20 · 已确认直接敞口', signal: 'down', sourceIds: ['nvda-8k'] },
    { ticker: 'AMD', name: 'AMD', exposure: amd ? 'MI308 · 已确认直接敞口' : '同类加速器 · 待核验', signal: amd ? 'down' : 'neutral', sourceIds: amd ? ['amd-8k'] : ['amd-10k'] },
  ]
  const factors = [
    { id: 'policy', label: '出口许可', value: amd ? '覆盖两款产品' : 'H20 已确认', status: 'confirmed', sourceIds: amd ? ['nvda-8k', 'amd-8k'] : ['nvda-8k'] },
    { id: 'supply', label: '替代供给', value: amd ? '替代路径收窄' : '可替代性待核验', status: 'watch', sourceIds: amd ? ['amd-8k'] : ['amd-10k'] },
    { id: 'exposure', label: '公司敞口', value: amd ? 'NVDA、AMD 均确认' : 'AMD 敞口待核验', status: amd ? 'confirmed' : 'watch', sourceIds: amd ? ['nvda-8k', 'amd-8k'] : ['nvda-8k', 'amd-10k'] },
    { id: 'charge', label: '财务计提', value: amdCharge ? '45 亿 / 约 8 亿美元' : nvdaCharge ? 'NVDA 实际 45 亿美元' : 'NVDA 预计最高 55 亿美元', status: nvdaCharge ? 'confirmed' : 'watch', sourceIds: amdCharge ? ['nvda-q1', 'amd-q2'] : nvdaCharge ? ['nvda-q1'] : ['nvda-8k'] },
    { id: 'market', label: '市场预期', value: '本案例无行情样本', status: 'unknown', sourceIds: [] },
  ]
  return { cutoff, evidence, companies, factors, target: targets.find((target) => target.issueStep === step) }
}

export function timeline(step) {
  return stages.map((stage, index) => index <= step ? stage : {
    title: stage.title,
    description: '推进时间后揭示',
    date: null,
  })
}
