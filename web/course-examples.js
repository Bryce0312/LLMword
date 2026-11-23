import { h, dataContent, header, button, link, sourceLink } from './workbench-core.js'
import { renderCollaboration } from './course-collaboration.js'

export async function courseExamples({ finance = false } = {}) {
  const response = await fetch(finance ? '/demo/finance-cases.json' : '/demo/cases.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('案例尚未生成，请在项目目录运行 npm run cases。')
  const data = await response.json()
  if (data.notAccuracyBenchmark !== true || !Array.isArray(data.cases)) throw new Error('案例文件标识无效。')
  if (!finance) {
    for (const path of ['/demo/warning-case.json','/demo/price-cases.json']) {
      const response = await fetch(path, { cache: 'no-store' })
      if (response.ok) { const extra = await response.json(); for (const item of extra.cases || [extra]) if (item.notAccuracyBenchmark === true) data.cases.push(item) }
    }
  }
  const content = h('section', 'cc-collaboration')
  const buttons = h('div', 'wb-actions')
  const show = (item) => {
    for (const b of buttons.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.caseId === item.id))
    const steps = h('div', 'wb-actions'), trace = h('section', 'wb-paper cc-collaboration')
    const showSnapshot = (snapshot, index) => {
      for (const [i, b] of [...steps.querySelectorAll('button')].entries()) b.setAttribute('aria-pressed', String(i === index))
      renderCollaboration(trace, snapshot.collaboration)
    }
    item.snapshots.forEach((snapshot, index) => { const step = button(snapshot.label, () => showSnapshot(snapshot, index)); step.setAttribute('data-i18n-skip', 'true'); steps.append(step) })
    const metrics = item.metrics
    content.replaceChildren(dataContent('h2', '', item.title), dataContent('p', '', item.question),
      h('p', 'wb-muted', h('span', '', metrics.runs + ' 次运行'), ', ', h('span', '', item.purpose === 'research' ? (metrics.reports || 0) + ' 份研报' : metrics.forecasts + ' 次发布'), '; ', h('span', '', metrics.modelRequests + ' 次模型调用'), ', ', h('span', '', metrics.toolCalls + ' 次工具调用。'), h('span', '', item.mode === 'live' ? '真实运行只读存档，不是实时新闻或准确率成绩。' : '模拟回复与合成计量。')),
      h('details', '', h('summary', '', `${item.checks.length} 项已通过验收`), h('ul', '', ...item.checks.map((check) => dataContent('li', '', check)))), steps, trace)
    if (item.reviewNotes?.length) content.insertBefore(h('section', 'wb-paper cc-collab-gap', h('h3', '', '报告复核备注'), h('ul', '', ...item.reviewNotes.map((note) => dataContent('li', '', note)))), steps)
    if (item.forecast?.publicationMode === 'revalidated-recorded-model-candidate') content.insertBefore(h('p', 'wb-paper cc-collab-gap', '此记录经维护重新校验原模型候选后封存；没有改写概率或回填发布时间，不代表完整自动流程验收通过。'), steps)
    if (item.result) content.insertBefore(h('section', 'wb-paper', h('h3', '', '到期结果与单题评分'), dataContent('p', '', item.result.summary), ...(item.result.scores || []).map(score => h('p', '', 'Brier ', dataContent('span', '', score.brier.toFixed(4)), ' · ', dataContent('span', '', score.label))), ...item.result.evidence.map(source => sourceLink(source))), steps)
    showSnapshot(item.snapshots[0], 0)
  }
  for (const item of data.cases) {
    const b = button(item.title, () => show(item)); b.setAttribute('data-i18n-skip', 'true'); b.dataset.caseId = item.id; buttons.append(b)
  }
  show(data.cases[0])
  return [header(finance ? '财报解读与管理层表述核验' : '协作验收案例', `${data.cases.length} 个案例：可查看实际报告、工具、来源和限制。`),
    link(finance ? '查看原有流程验收案例' : '查看财报案例', finance ? '#/course-examples' : '#/course-examples?set=finance', 'wb-text-button'),
    dataContent('p', 'wb-paper cc-collab-gap', data.description), buttons, content]
}
