import { createActorSprite } from './actors.js'
import { h, dataContent } from './workbench-core.js'
import { COURSE_ROLE_LABELS } from './course-team.js'

function isCanonicalRole(agent) {
  const name = agent && COURSE_ROLE_LABELS[agent.agentSpecId]
  return Boolean(name && (agent.name === name || (typeof agent.name === 'string' && agent.name.startsWith(name + ' v') && /^[1-9]\d*$/.test(agent.name.slice(name.length + 2)))))
}

export function createWorkbenchRoom(container, { onAgent, onDestination } = {}) {
  let generation = -1
  let timer
  let role = null
  let run = null
  const art = h('img'); art.src = 'assets/lab-play.png'; art.alt = '夜间像素研究室，设有圆桌、黑板和收报台'
  const phase = h('span', 'wb-room-phase', '等待派工')
  const sprite = h('span', 'wb-sprite')
  const workerName = h('span', 'wb-worker-name', '尚未派工')
  const actor = h('button', 'wb-worker', sprite, workerName); actor.type = 'button'; actor.setAttribute('aria-label', '查看本轮研究员')
  const bubble = h('section', 'wb-room-bubble', h('strong'), dataContent('p'), h('small')); bubble.hidden = true; bubble.setAttribute('aria-live', 'polite')
  const image = h('div', 'wb-room-image', art, phase, actor, bubble)
  const tools = h('div', 'wb-room-tools', '工具调用会在实际执行后出现在这里。'); tools.setAttribute('role', 'status')
  container.replaceChildren(image, tools)
  function nameNode() {
    const node = h('span', '', role?.name ?? '研究员')
    node.setAttribute(role && !isCanonicalRole(role) ? 'data-i18n-skip' : 'data-i18n-ui', 'true')
    return node
  }
  for (const [id, name] of [['world', '关系黑板'], ['inbox', '证据收报台'], ['learning', '学习档案柜']]) {
    const object = document.createElement('button'); object.type = 'button'; object.className = 'wb-room-object wb-object-' + id; object.textContent = name
    object.addEventListener('click', () => onDestination?.(id)); container.querySelector('.wb-room-image').append(object)
  }
  actor.hidden = true
  actor.addEventListener('click', () => role && onAgent?.(role.agentSpecId))

  function clear() {
    clearTimeout(timer)
    bubble.hidden = true
    actor.classList.remove('is-working', 'is-speaking', 'is-tooling')
  }
  function setRole(agent, currentRun) {
    role = agent
    run = currentRun
    actor.hidden = !agent
    if (!agent) return
    sprite.style.backgroundImage = `url("${createActorSprite(agent.agentSpecId, Math.max(0, agent.index ?? 0))}")`
    workerName.textContent = agent.name
    workerName.removeAttribute('data-i18n-skip'); workerName.removeAttribute('data-i18n-ui')
    workerName.setAttribute(isCanonicalRole(agent) ? 'data-i18n-ui' : 'data-i18n-skip', 'true')
    actor.dataset.agentInstanceId = currentRun?.assignment?.agentInstanceId ?? ''
    actor.setAttribute('aria-label', isCanonicalRole(agent) ? `查看研究员定义：${agent.name}` : `查看${agent.name}的定义`)
    actor.setAttribute('data-i18n-data-attributes', 'aria-label')
  }
  function apply(effect) {
    if (effect.type === 'room.reset') {
      generation = effect.generation
      clear()
      phase.textContent = run ? '读取本轮状态' : '等待派工'
      return
    }
    if (effect.generation !== undefined && effect.generation !== generation) return
    if (effect.runId && run && effect.runId !== run.runId) return
    if (effect.type === 'room.restore') {
      const active = !['completed', 'cancelled', 'failed', 'waiting'].includes(effect.run.status)
      actor.classList.toggle('is-working', active && Object.values(effect.run.assignments).some((a) => a.status === 'running'))
      phase.textContent = active ? '材料研读中' : '本轮状态已恢复'
    } else if (effect.type === 'actor.work') {
      actor.classList.add('is-working')
      phase.textContent = '研究员正在查证'
    } else if (effect.type === 'actor.stop') {
      actor.classList.remove('is-working', 'is-tooling')
    } else if (effect.type === 'bubble') {
      clearTimeout(timer)
      bubble.dataset.tone = effect.tone
      bubble.dataset.assignmentId = effect.assignmentId ?? ''
      bubble.dataset.resultId = effect.resultId ?? ''
      bubble.dataset.agentInstanceId = effect.agentInstanceId ?? ''
      bubble.querySelector('strong').replaceChildren(nameNode(), ' · ', { success: '研读完成', insufficient: '资料不足', blocked: '暂被阻塞', cancelled: '已取消', error: '未完成', neutral: '公开发言' }[effect.tone] ?? '研究反馈')
      const message = bubble.querySelector('p')
      const hasContent = Boolean(effect.message || effect.label)
      message.removeAttribute(hasContent ? 'data-i18n-ui' : 'data-i18n-skip')
      message.setAttribute(hasContent ? 'data-i18n-skip' : 'data-i18n-ui', 'true')
      message.textContent = effect.message || effect.label || '本轮任务已返回状态。'
      bubble.querySelector('small').textContent = effect.evidenceIds.length ? `引用 ${effect.evidenceIds.length} 条材料 · 全文见研读记录` : '完整报告保留在研读记录'
      bubble.hidden = false
      actor.classList.add('is-speaking')
      const token = generation
      timer = setTimeout(() => { if (token === generation) { bubble.hidden = true; actor.classList.remove('is-speaking') } }, Math.max(effect.minVisibleMs, 6000))
    } else if (effect.type === 'tool') {
      actor.classList.toggle('is-tooling', effect.tool.status === 'running')
      tools.replaceChildren(effect.tool.toolId ? dataContent('span', '', effect.tool.toolId) : h('span', '', '工具'), ' · ', effect.tool.status === 'running' ? '执行中' : effect.tool.success ? '已取得结果' : '未取得完整结果', ...(effect.tool.summary ? ['：', dataContent('span', '', effect.tool.summary)] : []))
    } else if (effect.type === 'run.status') {
      phase.textContent = ({ running: '材料研读中', waiting: '等待后续资料', completed: '研读报告已保存', failed: '本轮研读失败', cancelled: '本轮已取消' })[effect.status] ?? effect.status
    }
  }
  return { setRole, apply, destroy: clear }
}
