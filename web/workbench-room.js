import { createActorSprite } from './actors.js'

export function createWorkbenchRoom(container, { onAgent, onDestination } = {}) {
  let generation = -1
  let timer
  let role = null
  let run = null
  container.innerHTML = `<div class="wb-room-image"><img src="/assets/lab-play.png" alt="夜间像素研究室，设有圆桌、黑板和收报台"><span class="wb-room-phase">等待派工</span><button class="wb-worker" type="button" aria-label="查看本轮研究员"><span class="wb-sprite"></span><span class="wb-worker-name">尚未派工</span></button><section class="wb-room-bubble" aria-live="polite" hidden><strong></strong><p></p><small></small></section></div><div class="wb-room-tools" role="status">工具调用会在实际执行后出现在这里。</div>`
  const actor = container.querySelector('.wb-worker')
  const phase = container.querySelector('.wb-room-phase')
  const bubble = container.querySelector('.wb-room-bubble')
  const sprite = container.querySelector('.wb-sprite')
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
    actor.querySelector('.wb-worker-name').textContent = agent.name
    actor.dataset.agentInstanceId = currentRun?.assignment?.agentInstanceId ?? ''
    actor.setAttribute('aria-label', `查看${agent.name}的定义`)
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
      bubble.querySelector('strong').textContent = `${role?.name ?? '研究员'} · ${{ success: '研读完成', insufficient: '资料不足', blocked: '暂被阻塞', cancelled: '已取消', error: '未完成', neutral: '公开发言' }[effect.tone] ?? '研究反馈'}`
      bubble.querySelector('p').textContent = effect.message || effect.label || '本轮任务已返回状态。'
      bubble.querySelector('small').textContent = effect.evidenceIds.length ? `引用 ${effect.evidenceIds.length} 条材料 · 全文见研读记录` : '完整报告保留在研读记录'
      bubble.hidden = false
      actor.classList.add('is-speaking')
      const token = generation
      timer = setTimeout(() => { if (token === generation) { bubble.hidden = true; actor.classList.remove('is-speaking') } }, Math.max(effect.minVisibleMs, 6000))
    } else if (effect.type === 'tool') {
      actor.classList.toggle('is-tooling', effect.tool.status === 'running')
      container.querySelector('.wb-room-tools').textContent = `${effect.tool.toolId ?? '工具'} · ${effect.tool.status === 'running' ? '执行中' : effect.tool.success ? '已取得结果' : '未取得完整结果'}${effect.tool.summary ? `：${effect.tool.summary}` : ''}`
    } else if (effect.type === 'run.status') {
      phase.textContent = ({ running: '材料研读中', waiting: '等待后续资料', completed: '研读报告已保存', failed: '本轮研读失败', cancelled: '本轮已取消' })[effect.status] ?? effect.status
    }
  }
  return { setRole, apply, destroy: clear }
}
