import { h, dataContent, button, sourceLink } from './workbench-core.js'
import { courseRoleName } from './course-team.mjs'
import { formatCourseProbability } from './course-probability.mjs'

const dispositions = { adopted: '采纳', qualified: '保留条件', rejected: '未采纳' }
const percent = p => formatCourseProbability(p, '未给概率')
export function renderCollaboration(node, trace) {
  const openReports = new Set([...node.querySelectorAll('details[open][data-assignment-id]')].map((item) => item.dataset.assignmentId))
  node.hidden = !trace
  if (!trace) return
  const refs = (ids) => h('div', 'cc-collab-refs', ...(ids || []).map((id) => {
    const source = trace.sources.find((item) => item.evidenceId === id)
    return source ? h('span', '', dataContent('span', '', source.title), ' ', sourceLink(source)) : null
  }))
  const reportCard = (item) => {
    const partial = item.reportQuality === 'partial' && Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1 && Array.isArray(item.evidenceIds) && item.evidenceIds.length
    const label = partial ? item.status === 'failed' ? '未完整，部分依据已保留' : '资料有限' : ({ complete: '报告完成', insufficient: '资料不足', blocked: '受阻' })[item.reportStatus] || '等待报告'
    const box = h('details', 'cc-collab-report', h('summary', '', dataContent('span', '', courseRoleName(item.roleId, item.name)), ' · ', item.followUp ? `第${item.cycle}轮补查` : '独立调查', ' · ', label))
    box.dataset.assignmentId = item.assignmentId; box.open = openReports.has(item.assignmentId)
    box.append(h('p', '', '调查任务：', dataContent('span', '', item.objective)), h('p', 'wb-muted', '选择理由：', dataContent('span', '', item.reason)), dataContent('p', 'wb-prewrap', item.summary || '报告尚未提交。'))
    box.append(h('p', 'wb-muted', Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1 ? '本席 Yes 估计 ' + percent(item.probability) + '（未校准）' : '本席 Yes 估计：未给估计。'))
    for (const [label, claims] of [['支持', item.support], ['反证', item.counterevidence]]) for (const claim of claims) box.append(h('p', '', label + (claim.basis === 'inference' ? '（推断）' : claim.basis === 'fact' ? '（直接事实）' : '') + '：', dataContent('span', '', claim.claim)), refs(claim.evidenceIds), ...(claim.citations || []).map(q => dataContent('blockquote', 'wb-prewrap', q.quote)))
    if (item.missingEvidence.length) box.append(h('p', 'cc-collab-gap', '未解决：', dataContent('span', '', item.missingEvidence.join('；'))))
    box.append(item.decision ? h('p', 'cc-collab-decision', dispositions[item.decision.disposition] + '：', dataContent('span', '', item.decision.reason)) : h('p', 'wb-muted', trace.decision ? '本次发布未记录这份报告的逐项采纳理由。' : '尚未裁决。'))
    return box
  }
  const exportButton = button('导出本轮协作记录', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = trace.runId + '-collaboration.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'wb-text-button')
  const header = h('div', 'cc-collab-heading', h('div', '', h('h2', '', '本轮协作如何影响判断'), h('p', '', trace.conclusion)), exportButton)
  node.replaceChildren(header)
  if (trace.modelMode !== 'live' || trace.sourceMode !== 'live') node.append(h('p', 'cc-collab-gap', '模拟／回放记录：用于验证协作流程，不作为真实预测成绩。'))
  if (trace.triage?.reason) node.append(h('p', '', '本轮范围：', dataContent('span', '', trace.triage.reason)))
  const team = h('div', 'cc-collab-team', ...trace.team.map(reportCard))
  node.append(h('h3', '', '① 谁负责什么、查到了什么'), team, h('h3', '', '② 为什么补查、答复带来了什么'))
  if (!trace.reviews.length) node.append(h('p', 'wb-muted', trace.team.length ? '本轮未发起定向补查。' : '本次检查未派出研究员。'))
  for (const review of trace.reviews) {
    const detail = h('div', 'cc-collab-review', h('p', '', '主 Agent → ', dataContent('span', '', courseRoleName(review.roleId, review.name))),
      h('p', '', '问题：', dataContent('span', '', review.review?.objective || review.objective)), h('p', '', '原因：', dataContent('span', '', review.review?.reason || review.reason)), refs(review.review?.evidenceIds))
    if (review.previousSummary) detail.append(h('details', '', h('summary', '', '查看该研究员补查前的报告'), dataContent('p', 'wb-prewrap', review.previousSummary)))
    detail.append(h('p', '', review.responseStatus === 'submitted' ? '补查答复已提交；是否采纳见下方裁决。' : review.responseStatus === 'failed' ? '补查未完成，保留缺口。' : '正在等待补查答复。'), reportCard(review))
    if (review.newEvidenceIds.length) detail.append(h('p', '', '该研究员新增引用：'), refs(review.newEvidenceIds))
    if (Number.isFinite(review.probabilityBefore) && Number.isFinite(review.probabilityAfter)) detail.append(h('p', '', '研究员候选概率：' + percent(review.probabilityBefore) + ' → ' + percent(review.probabilityAfter)))
    node.append(detail)
  }
  node.append(h('h3', '', '③ 最终采纳、保留和未解决问题'))
  if (trace.decision) {
    const decision = trace.decision
    if (decision.groundingPolicy) node.append(h('p', 'wb-muted', '逐条片段已检查出处与基本数字覆盖；片段匹配不等于语义判断全部正确。'), ...decision.reasoningClaims.map(claim => h('details', '', h('summary', '', claim.basis === 'inference' ? '推断：' : '直接事实：', dataContent('span', '', claim.claim)), ...(claim.citations || []).map(q => dataContent('blockquote', 'wb-prewrap', q.quote)), refs(claim.evidenceIds))))
    node.append(h('p', '', (decision.kind === 'research_report' ? '本轮为财报核验研报' : '本轮 Yes ' + percent(decision.probabilityYes)) + (decision.delta !== null ? `；相较上次${decision.delta >= 0 ? '+' : ''}${Math.round(decision.delta * 1000) / 10}个百分点` : '') + `；已记录 ${decision.recordedNotes}/${decision.totalReports} 份报告的裁决。`))
    for (const item of trace.reports.filter((item) => item.decision)) node.append(h('p', '', dataContent('span', '', courseRoleName(item.roleId, item.name)), ' · ' + dispositions[item.decision.disposition] + '：', dataContent('span', '', item.decision.reason)), refs(item.decision.evidenceIds))
    for (const dissent of decision.dissent) node.append(h('p', 'cc-collab-gap', '保留异议：', dataContent('span', '', dissent)))
    node.append(h('p', 'wb-muted', '补查答复已提交不代表争议已解决；概率变化不代表预测准确率提高。'))
  } else node.append(h('p', '', '本轮没有新发布的判断。'))
}
