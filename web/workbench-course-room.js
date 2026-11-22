import { createActorSprite } from './actors.js'
import { h, dataContent } from './workbench-core.js'
import { courseObjective, normalizeCourseRole } from './course-team.mjs'
import { courseRoomOutcome } from './course-projection.mjs'
import { courseUsageText, courseModelStatusView } from './course-workflow.mjs'

const pixels = { supervisor: 'chair', official: 'policy', timeline: 'supply', industry: 'company', people: 'market', statistics: 'supply', market: 'market', social: 'company', analogy: 'policy', graph: 'supply', verification: 'company' }
const shortNames = { supervisor: '主 Agent', official: '官方', timeline: '新闻', industry: '行业', people: '人物', statistics: '统计', market: '市场', social: '社群', analogy: '类比', graph: '关系', verification: '核验' }
const terminal = (status) => ['completed', 'finished', 'insufficient', 'failed', 'cancelled'].includes(status)

export function createCourseRoom(container) {
  let runId = null; let generation = -1; let timer
  const figures = new Map()
  const image = h('div', 'wb-room-image cc-room-image')
  const art = h('img'); art.src = '/assets/lab-play.png'; art.alt = '按当前问题派出研究员的像素研究室'
  const phase = h('span', 'wb-room-phase', '等待真实派工')
  function setPhase(text, data = false) { if (data) phase.setAttribute('data-i18n-skip', 'true'); else phase.removeAttribute('data-i18n-skip'); phase.textContent = text }
  function phaseWithName(name, action) { phase.removeAttribute('data-i18n-skip'); phase.replaceChildren(dataContent('span', '', name), action) }
  const bubble = h('section', 'wb-room-bubble cc-room-bubble'); bubble.hidden = true; bubble.setAttribute('aria-live', 'polite')
  bubble.append(h('strong'), dataContent('p'), h('small'))
  image.append(art, phase, bubble)
  const teamNote = h('p', 'cc-team-note', '研究员由主 Agent 按本题选择；名单将在实际派工后出现。')
  const cards = h('div', 'cc-work-cards')
  const tool = h('div', 'wb-room-tools', '实际工具执行后，会在这里显示调用与返回。')
  container.replaceChildren(image, tool, teamNote, cards)

  function clear() { clearTimeout(timer); bubble.hidden = true; for (const { actor } of figures.values()) actor.classList.remove('is-working', 'is-speaking', 'is-tooling', 'is-model-waiting') }
  function syncTeam(team) {
    const ids = new Set(team.map((member) => member.roleId))
    for (const [id, figure] of figures) if (!ids.has(id)) { figure.actor.remove(); figure.card.remove(); figures.delete(id) }
    const workers = team.filter((member) => member.roleId !== 'supervisor')
    for (const [index, member] of team.entries()) {
      const id = member.roleId
      let figure = figures.get(id)
      if (!figure) {
        const actor = h('div', 'cc-actor'); actor.dataset.role = id
        const sprite = h('span', 'wb-sprite'); sprite.style.backgroundImage = 'url("' + createActorSprite(pixels[id] ?? id, index) + '")'
        const badge = h('span', 'cc-actor-badge'); const modelBadge = h('span', 'cc-actor-model'); modelBadge.hidden = true
        actor.append(sprite, badge, modelBadge); image.insertBefore(actor, bubble)
        const name = dataContent('strong'); const job = dataContent('p'); const reason = h('p', 'cc-work-reason')
        const status = h('span', 'cc-work-status', '等待派工')
        const modelState = h('span', 'cc-work-model'); modelState.hidden = true
        const usage = h('small', 'cc-work-usage'); usage.hidden = true
        const card = h('div', 'cc-work-card', name, job, reason, status, modelState, usage); card.dataset.role = id; cards.append(card)
        figure = { actor, badge, modelBadge, card, name, job, reason, status, modelState, usage }; figures.set(id, figure)
      }
      figure.data = member
      figure.name.textContent = member.name
      figure.badge.textContent = shortNames[id] ?? member.name.replace(/研究员$/, '')
      figure.badge.setAttribute('data-i18n-skip-attributes', 'title')
      if (shortNames[id]) figure.badge.removeAttribute('data-i18n-skip'); else figure.badge.setAttribute('data-i18n-skip', 'true')
      figure.badge.title = member.name
      figure.job.textContent = courseObjective(member.objective) || (id === 'supervisor' ? '整理问题、选择研究员与汇总公开报告' : '等待实际调查任务')
      const reason = member.followUpReason ? '补查原因：' + member.followUpReason : member.reason ? '选我来查：' + member.reason : ''
      figure.reason.replaceChildren(...(reason ? [member.followUpReason ? '补查原因：' : '选我来查：', dataContent('span', '', member.followUpReason || member.reason)] : [])); figure.reason.hidden = !reason
      const seat = workers.findIndex((worker) => worker.roleId === id)
      const x = id === 'supervisor' ? 80 : workers.length === 1 ? 43 : 24 + seat * (38 / Math.max(1, workers.length - 1))
      const meetingX = id === 'supervisor' ? 60 : workers.length === 1 ? 41 : 30 + seat * (22 / Math.max(1, workers.length - 1))
      figure.x = x; figure.meetingX = meetingX
      figure.actor.style.setProperty('--desk-x', x + '%'); figure.actor.style.setProperty('--meeting-x', meetingX + '%')
      figure.actor.style.setProperty('--meeting-bottom', id === 'supervisor' ? '27%' : seat === 0 ? '24%' : '16%')
    }
    teamNote.textContent = workers.length ? '本轮已选 ' + workers.length + ' 位研究员 · 每人的任务与入选原因见下方。' : '主 Agent 正在按题选择研究员；尚未显示的角色不会预先入场。'
  }
  function statusFor(roleId, value, objective) {
    const figure = figures.get(roleId); if (!figure) return
    const texts = { queued: '等待派工', pending: '等待派工', running: '调查中', complete: '报告已提交', completed: '报告已提交', checked: '检查完成', published: '判断已保存', insufficient: '资料不足', blocked: '存在缺口', failed: '执行失败', cancelled: '已取消' }
    figure.status.textContent = texts[value] ?? value ?? '等待派工'
    figure.status.dataset.status = value ?? 'pending'
    if (objective) figure.job.textContent = courseObjective(objective)
  }
  function modelFor(effect) {
    const figure = figures.get(effect.roleId); if (!figure) return
    const view = courseModelStatusView(effect); const waiting = view.waiting
    if (!waiting && effect.status !== 'ended' && effect.modelRequestId && figure.modelRequestId && effect.modelRequestId !== figure.modelRequestId) return
    if (waiting) figure.modelRequestId = effect.modelRequestId ?? null
    else if (effect.status === 'ended') figure.modelRequestId = null
    figure.actor.classList.toggle('is-model-waiting', waiting)
    figure.modelBadge.hidden = !waiting; figure.modelBadge.textContent = view.badgeText
    figure.modelState.textContent = view.text
    figure.modelState.dataset.state = effect.status; figure.modelState.hidden = !figure.modelState.textContent
  }
  function usageFor(assignments, status) {
    const latest = new Map(assignments.map(a => [normalizeCourseRole(a.roleId ?? a.agentSpecId ?? a.role), a]))
    for (const [roleId, a] of latest) {
      const figure = figures.get(roleId); if (!figure) continue
      const u = a.usage; const b = a.budget ?? {}
      figure.usage.hidden = !u
      if (u) figure.usage.textContent = (a.cycle ? `调查周期 ${a.cycle} · ` : '') + '模型 ' + courseUsageText(Number.isSafeInteger(u.modelRequests) ? u.modelRequests : null, Number.isSafeInteger(b.maxModelRequests) ? b.maxModelRequests : null, ' 次') + ' · 工具 ' + courseUsageText(Number.isSafeInteger(u.toolCalls) ? u.toolCalls : null, Number.isSafeInteger(b.maxToolCalls) ? b.maxToolCalls : null, ' 次')
      if (terminal(status) || a.status !== 'running') modelFor({ roleId, status: 'ended' })
      figure.actor.classList.toggle('is-working', !terminal(status) && a.status === 'running')
      statusFor(roleId, a.report?.status ?? a.status)
    }
  }
  function finish(effect) {
    const outcome = courseRoomOutcome(effect)
    for (const [roleId, f] of figures) { f.actor.classList.remove('is-working', 'is-tooling', 'is-model-waiting'); modelFor({ roleId, status: 'ended' }) }
    statusFor('supervisor', outcome.supervisorState, outcome.supervisorObjective)
    setPhase(outcome.phase)
    if (outcome.teamNote) teamNote.textContent = outcome.teamNote
  }
  function apply(effect) {
    if (effect.type === 'reset') {
      clear(); runId = effect.runId; generation = effect.generation
      for (const figure of figures.values()) { figure.actor.remove(); figure.card.remove() }
      figures.clear()
      setPhase('等待真实派工'); tool.textContent = '实际工具执行后，会在这里显示调用与返回。'
      teamNote.textContent = '研究员由主 Agent 按本题选择；名单将在实际派工后出现。'
      return
    }
    if (effect.runId !== runId || effect.generation !== generation) return
    if (effect.type === 'team') { syncTeam(effect.team); return }
    const figure = figures.get(effect.roleId)
    if (effect.type === 'restore') {
      for (const a of effect.assignments) {
        const roleId = normalizeCourseRole(a.roleId ?? a.role ?? a.agentSpecId)
        statusFor(roleId, a.report?.status ?? a.status, a.objective)
        const actor = figures.get(roleId)?.actor
        if (actor) actor.classList.toggle('is-working', effect.status === 'running' && a.status === 'running')
      }
      for (const activity of effect.modelActivity ?? []) modelFor(activity)
      if (terminal(effect.status)) finish(effect)
      else setPhase('恢复本轮真实状态')
    } else if (effect.type === 'usage') usageFor(effect.assignments, effect.status)
    else if (effect.type === 'model') modelFor(effect)
    else if (effect.type === 'work') {
      figure?.actor.classList.add('is-working'); statusFor(effect.roleId, 'running', effect.summary); phaseWithName(figure?.data.name ?? '研究员', '正在调查')
    } else if (effect.type === 'stop') { figure?.actor.classList.remove('is-working', 'is-tooling', 'is-model-waiting'); modelFor({ ...effect, status: 'ended' }) }
    else if (effect.type === 'tool') {
      figure?.actor.classList.toggle('is-tooling', effect.status === 'running')
      if (effect.status === 'running') phaseWithName(figure?.data.name ?? '研究员', '正在执行工具')
      if (effect.roleId === 'supervisor') statusFor('supervisor', effect.status === 'running' ? 'running' : effect.status === 'error' ? '存在资料缺口' : '工具已返回')
      const name = { search_web: '搜索公开资料', fetch_page: '读取网页原文', read_evidence: '核对资料原文', get_market_quote: '读取市场现价 (get_market_quote)' }[effect.toolId] ?? effect.toolId ?? '工具'
      tool.replaceChildren(dataContent('span', '', figure?.data.name ?? '研究室'), ' · ', dataContent('span', '', name), ' · ', effect.status === 'running' ? '执行中' : effect.status === 'ok' ? '已取得返回' : effect.status === 'partial' ? '已取得可引用片段' : '未取得资料', ...(effect.summary ? ['：', dataContent('span', '', effect.summary)] : []))
    } else if (effect.type === 'meeting') {
      for (const [id, f] of figures) f.actor.classList.toggle('is-at-table', effect.participants.includes(id))
      setPhase(effect.summary || '正在核对具体分歧', Boolean(effect.summary))
    } else if (effect.type === 'speech' && figure) {
      clearTimeout(timer)
      for (const f of figures.values()) f.actor.classList.remove('is-speaking')
      const success = ['complete', 'completed'].includes(effect.status)
      statusFor(effect.roleId, effect.status === 'message' ? '公开讨论' : effect.status)
      bubble.dataset.role = effect.roleId; bubble.dataset.assignmentId = effect.assignmentId ?? ''; bubble.dataset.resultId = effect.resultId ?? ''; bubble.dataset.tone = success ? 'success' : effect.status === 'message' ? 'neutral' : 'insufficient'
      bubble.querySelector('strong').replaceChildren(dataContent('span', '', figure.data.name), ' · ', success ? '报告已提交' : effect.status === 'message' ? '公开讨论' : '调查反馈')
      bubble.querySelector('p').textContent = effect.summary
      bubble.querySelector('small').textContent = effect.evidenceIds?.length ? '引用 ' + effect.evidenceIds.length + ' 条资料，完整记录见下方。' : '公开判断摘要，完整记录见下方。'
      const x = figure.actor.classList.contains('is-at-table') ? figure.meetingX : figure.x
      bubble.style.setProperty('--tail', Math.max(8, Math.min(92, (x - 12.5) / .75)) + '%')
      bubble.hidden = false; figure.actor.classList.add('is-speaking')
      const token = generation
      timer = setTimeout(() => { if (token === generation) { bubble.hidden = true; figure.actor.classList.remove('is-speaking') } }, 7000)
    } else if (effect.type === 'phase') setPhase(effect.summary, true)
    else if (effect.type === 'end') {
      finish(effect)
    }
  }
  return { apply, destroy: clear }
}
