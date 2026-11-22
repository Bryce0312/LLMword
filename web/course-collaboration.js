import { h, button, sourceLink } from './workbench-core.js'
import { courseRoleName } from './course-team.mjs'

const dispositions = { adopted: '采纳', qualified: '保留条件', rejected: '未采纳' }
const percent = (p) => Number.isFinite(p) ? Math.round(p * 100) + '%' : '未给概率'
export function renderCollaboration(node, trace) {
  const openReports = new Set([...node.querySelectorAll('details[open][data-assignment-id]')].map((item) => item.dataset.assignmentId))
  node.hidden = !trace
  if (!trace) return
  const refs = (ids) => h('div', 'cc-collab-refs', ...(ids || []).map((id) => {
    const source = trace.sources.find((item) => item.evidenceId === id)
    return source ? h('span', '', source.title, ' ', sourceLink(source)) : null
  }))
  const reportCard = (item) => {
    const box = h('details', 'cc-collab-report', h('summary', '', courseRoleName(item.roleId, item.name), ' · ', item.followUp ? `第${item.cycle}轮补查` : '独立调查', ' · ', ({ complete: '报告完成', insufficient: '资料不足', blocked: '受阻' })[item.reportStatus] || '等待报告'))
    box.dataset.assignmentId = item.assignmentId; box.open = openReports.has(item.assignmentId)
    box.append(h('p', '', '调查任务：' + item.objective), h('p', 'wb-muted', '选择理由：' + item.reason), h('p', 'wb-prewrap', item.summary || '报告尚未提交。'))
    for (const [label, claims] of [['支持', item.support], ['反证', item.counterevidence]]) for (const claim of claims) box.append(h('p', '', label + (claim.basis === 'inference' ? '（推断）' : claim.basis === 'fact' ? '（直接事实）' : '') + '：' + claim.claim), refs(claim.evidenceIds), ...(claim.citations || []).map(q => h('blockquote', 'wb-prewrap', q.quote)))
    if (item.missingEvidence.length) box.append(h('p', 'cc-collab-gap', '未解决：' + item.missingEvidence.join('；')))
    box.append(item.decision ? h('p', 'cc-collab-decision', dispositions[item.decision.disposition] + '：' + item.decision.reason) : h('p', 'wb-muted', trace.decision ? '本次发布未记录这份报告的逐项采纳理由。' : '尚未裁决。'))
    return box
  }
  const exportButton = button('导出本轮协作记录', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = trace.runId + '-collaboration.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'wb-text-button')
  const header = h('div', 'cc-collab-heading', h('div', '', h('h2', '', '本轮协作如何影响判断'), h('p', '', trace.conclusion)), exportButton)
  node.replaceChildren(header)
  if (trace.modelMode !== 'live' || trace.sourceMode !== 'live') node.append(h('p', 'cc-collab-gap', '模拟／回放记录：用于验证协作流程，不作为真实预测成绩。'))
  if (trace.triage?.reason) node.append(h('p', '', '本轮范围：' + trace.triage.reason))
  const sources = new Map()
  for (const source of trace.sources) {
    let key = source.url || source.evidenceId
    try { const url = new URL(key); url.hash = ''; key = url.href } catch {}
    if (!sources.has(key)) sources.set(key, { source, ids: new Set() })
    sources.get(key).ids.add(source.evidenceId)
  }
  const relationships = h('details', 'cc-source-map', h('summary', '', `来源与研究员 · ${sources.size} 个来源地址`))
  relationships.append(h('p', 'wb-muted', '同一地址只列一次；不同地址也可能转载同一来源。连线表示已记录的引用，不表示观点正确或相互独立。'))
  const sourceList = h('ul', '')
  for (const {source, ids} of sources.values()) {
    const users = trace.reports.filter(report => report.evidenceIds.some(id => ids.has(id)))
    const labels = [...new Set(users.map(report => courseRoleName(report.roleId, report.name)))]
    const support = users.some(report => report.support.some(claim => claim.evidenceIds.some(id => ids.has(id))))
    const counter = users.some(report => report.counterevidence.some(claim => claim.evidenceIds.some(id => ids.has(id))))
    sourceList.append(h('li', '', sourceLink(source), ' → ', labels.join('、') || '尚无报告引用',
      h('small', '', support && counter ? ' · 同时用于支持与反证，请核对具体主张' : counter ? ' · 反证引用' : support ? ' · 支持引用' : ' · 尚未形成判断')))
  }
  relationships.append(sourceList); node.append(relationships)
  const team = h('div', 'cc-collab-team', ...trace.team.map(reportCard))
  node.append(h('h3', '', '① 谁负责什么、查到了什么'), team, h('h3', '', '② 为什么补查、答复带来了什么'))
  if (!trace.reviews.length) node.append(h('p', 'wb-muted', trace.team.length ? '本轮未发起定向补查。' : '本次检查未派出研究员。'))
  for (const review of trace.reviews) {
    const detail = h('div', 'cc-collab-review', h('p', '', '主 Agent → ' + courseRoleName(review.roleId, review.name)),
      h('p', '', '问题：' + (review.review?.objective || review.objective)), h('p', '', '原因：' + (review.review?.reason || review.reason)), refs(review.review?.evidenceIds))
    if (review.previousSummary) detail.append(h('details', '', h('summary', '', '查看该研究员补查前的报告'), h('p', 'wb-prewrap', review.previousSummary)))
    detail.append(h('p', '', review.responseStatus === 'submitted' ? '补查答复已提交；是否采纳见下方裁决。' : review.responseStatus === 'failed' ? '补查未完成，保留缺口。' : '正在等待补查答复。'), reportCard(review))
    if (review.newEvidenceIds.length) detail.append(h('p', '', '该研究员新增引用：'), refs(review.newEvidenceIds))
    if (Number.isFinite(review.probabilityBefore) && Number.isFinite(review.probabilityAfter)) detail.append(h('p', '', '研究员候选概率：' + percent(review.probabilityBefore) + ' → ' + percent(review.probabilityAfter)))
    node.append(detail)
  }
  node.append(h('h3', '', '③ 最终采纳、保留和未解决问题'))
  if (trace.decision) {
    const decision = trace.decision
    if (decision.groundingPolicy) node.append(h('p', 'wb-muted', '逐条片段已检查出处与基本数字覆盖；片段匹配不等于语义判断全部正确。'), ...decision.reasoningClaims.map(claim => h('details', '', h('summary', '', (claim.basis === 'inference' ? '推断：' : '直接事实：') + claim.claim), ...(claim.citations || []).map(q => h('blockquote', 'wb-prewrap', q.quote)), refs(claim.evidenceIds))))
    node.append(h('p', '', (decision.kind === 'research_report' ? '本轮为财报核验研报' : '本轮 Yes ' + percent(decision.probabilityYes)) + (decision.delta !== null ? `；相较上次${decision.delta >= 0 ? '+' : ''}${Math.round(decision.delta * 100)}个百分点` : '') + `；已记录 ${decision.recordedNotes}/${decision.totalReports} 份报告的裁决。`))
    for (const item of trace.reports.filter((item) => item.decision)) node.append(h('p', '', courseRoleName(item.roleId, item.name) + ' · ' + dispositions[item.decision.disposition] + '：' + item.decision.reason), refs(item.decision.evidenceIds))
    for (const dissent of decision.dissent) node.append(h('p', 'cc-collab-gap', '保留异议：' + dissent))
    node.append(h('p', 'wb-muted', '补查答复已提交不代表争议已解决；概率变化不代表预测准确率提高。'))
  } else node.append(h('p', '', '本轮没有新发布的判断。'))
}
