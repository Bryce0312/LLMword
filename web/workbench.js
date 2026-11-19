import { $, h, header, empty, button, api, toast, route, goto, terminal, labels, fmt } from './workbench-core.js'
import { createProjectionState, selectRun, projectEvent } from './run-projection.mjs'
import { topicForm, predictionForm } from './workbench-forms.js'
import { sidebar, board, inbox, learning, agents, topicView } from './workbench-views.js'
import { detail, reportView } from './workbench-detail.js'
import { courseBoard, courseStartForm, mountCourseRequest } from './workbench-course.js'
import { probeCourseCapability, unavailableCourseCapability, isMissingCourseApi } from './course-capability.mjs'
import { providerConnectionView } from './workbench-provider.js'

const cache = { topics: [], predictions: [], agents: [], tools: [], config: {}, courseRequests: [], courseAvailable: false, courseCapability: null, courseHistoryError: null, runs: new Map(), events: new Map() }
let projection = createProjectionState()
let serial = 0
let stream
let capabilityCheck
const ctx = {
  cache, content: $('wb-content'), selectedRuns: new Map(), room: null, filterTopic: '',
  get projection() { return projection },
  isCurrent: (token) => token === serial,
  accept(result) { projection = result.state; dispatch(result.effects) },
  render: () => renderRoute(), reload: () => initialize(), error: (error) => showError(error),
  refreshSidebar: () => renderSidebar(), scrollOnRun: null,
  courseFreshRequests: new Set(), courseRetryInput: null, courseCleanup: null,
  checkCourseCapability, setCourseCapability,
  onFilter(value) { ctx.filterTopic = value; renderSidebar(); if (location.hash === '#/predictions') void renderRoute(); else goto('/predictions') },
}
function setCourseCapability(capability) {
  cache.courseCapability = capability; cache.courseAvailable = capability.available
  const { parts } = route()
  if (parts[0] === 'course' || (parts[0] === 'predictions' && (!parts[1] || parts[1] === 'new'))) {
    const notice = document.querySelector('.wb-stage-note > span:not(.wb-tag)')
    if (notice) notice.textContent = capability.available ? '一句问题，系统核对来源、分工调查；结果以实际运行记录为准。' : capability.message
  }
  return capability
}
function checkCourseCapability() {
  if (!capabilityCheck) capabilityCheck = probeCourseCapability().then(setCourseCapability).finally(() => { capabilityCheck = null })
  return capabilityCheck
}
function renderSidebar() { $('wb-sidebar').replaceChildren(...sidebar(ctx)) }
function showError(error) {
  $('wb-global-error').hidden = false
  $('wb-global-error').replaceChildren(h('span', '', error.message + ' '), button('重新读取', initialize, 'wb-text-button'))
}
function dispatch(effects) {
  for (const effect of effects) {
    if (effect.type === 'resync.required') { connectEvents(); continue }
    if (effect.type === 'run.snapshot.required') continue
    ctx.room?.apply(effect)
  }
}
function updateLive(run) {
  const { parts } = route()
  const p = parts[0] === 'predictions' ? cache.predictions.find((p) => p.predictionId === parts[1]) : null
  if (!p || !run || p.predictionId !== run.predictionId) return
  const effective = projection.runs[run.runId]?.status ?? run.status
  const latest = $('wb-contract-latest')
  const contract = ctx.content.querySelector('.wb-forecast-note')
  if (latest && run.predictionVersion === Number(contract?.dataset.predictionVersion) && (!latest.dataset.createdAt || Date.parse(run.createdAt) >= Date.parse(latest.dataset.createdAt))) {
    latest.textContent = (labels[effective] ?? effective) + ' · ' + fmt(run.updatedAt, p.timezone)
    latest.dataset.createdAt = run.createdAt
  }
  if (run.runId !== projection.selectedRunId) return
  reportView(ctx, p, run)
  const history = ctx.content.querySelector('[data-run-id="' + CSS.escape(run.runId) + '"]')
  if (history) history.textContent = '契约 v' + run.predictionVersion + ' · ' + fmt(run.createdAt) + ' · ' + (labels[effective] ?? effective)
  const start = $('wb-start-run')
  if (start) start.disabled = start.dataset.canStart !== 'true' || !terminal({ status: projection.runs[run.runId]?.status ?? run.status })
}
function connectEvents() {
  stream?.close()
  if (typeof EventSource === 'undefined') { $('wb-connection').textContent = '浏览器不支持实时事件'; return }
  const source = new EventSource('/api/v1/events'); stream = source
  source.onopen = () => { if (stream !== source) return; $('wb-connection').textContent = '数据已连接'; delete $('wb-connection').dataset.state }
  source.onerror = () => { if (stream !== source) return; $('wb-connection').textContent = '消息流重连中'; $('wb-connection').dataset.state = 'reconnecting' }
  source.onmessage = ({ data }) => {
    if (stream !== source) return
    let event; try { event = JSON.parse(data) } catch { return }
    if (event.type === 'sync' && event.payload?.reset) for (const run of event.payload.runs ?? []) cache.runs.set(run.runId, run)
    const result = projectEvent(projection, event); ctx.accept(result)
    if (result.effects.some((e) => e.type === 'unread') || event.type === 'sync') renderSidebar()
    if (projection.selectedRunId) updateLive(cache.runs.get(projection.selectedRunId))
    if (['run.started', 'run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) {
      void api('/runs/' + event.runId).then((run) => {
        cache.runs.set(run.runId, run)
        const p = cache.predictions.find((p) => p.predictionId === run.predictionId)
        if (p && run.predictionVersion === p.version && (!p.latestRun || Date.parse(run.createdAt) >= Date.parse(p.latestRun.createdAt))) p.latestRun = run
        updateLive(run)
      }).catch(showError)
    }
  }
}

async function renderRoute() {
  const token = ++serial; const { parts, query } = route()
  const courseRoute = parts[0] === 'course' || (parts[0] === 'predictions' && (!parts[1] || parts[1] === 'new'))
  document.body.classList.toggle('wb-course-route', courseRoute)
  if (courseRoute || parts[0] === 'model-connection') { stream?.close(); stream = null }
  else if (!stream) connectEvents()
  ctx.courseCleanup?.(); ctx.courseCleanup = null
  ctx.room?.destroy(); ctx.room = null
  ctx.accept(selectRun(projection, null))
  $('wb-global-error').hidden = true; renderSidebar()
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('is-selected', a.dataset.nav === parts[0] || (a.dataset.nav === 'predictions' && courseRoute))
  ctx.content.replaceChildren(h('p', 'wb-loading', '正在读取工作区…'))
  const stage = document.querySelector('.wb-stage-note')
  stage.replaceChildren(h('span', 'wb-tag', parts[0] === 'advanced' ? '高级材料研读' : '事件跟踪'), h('span', '', parts[0] === 'advanced' ? '手动定义题目、选择材料与单研究员研读。' : cache.courseAvailable ? '一句问题，系统核对来源、分工调查；结果以实际运行记录为准。' : cache.courseCapability?.message ?? '正在检查当前服务的自动跟踪能力。'), h('a', '', '旧历史案例'))
  stage.querySelector('a').href = '/legacy.html'
  try {
    let nodes
    if (parts[0] === 'course' && parts[1] && parts[1] !== 'new') { await mountCourseRequest(ctx, parts[1], token); return }
    else if ((parts[0] === 'course' && (!parts[1] || parts[1] === 'new')) || (parts[0] === 'predictions' && parts[1] === 'new')) nodes = courseStartForm(ctx, { standalone: true })
    else if (parts[0] === 'learning') nodes = await learning()
    else if (parts[0] === 'model-connection') nodes = await providerConnectionView(ctx)
    else if (parts[0] === 'agents') {
      const historical = parts[1] && query.has('specVersion') ? await api('/agents/' + parts[1] + '?specVersion=' + encodeURIComponent(query.get('specVersion'))) : null
      nodes = agents(ctx, parts[1], historical)
    }
    else if (parts[0] === 'tools') nodes = [header('工具台', '只有已注册且获授权的能力才能实际执行。'), h('div', 'wb-paper', cache.tools.map((t) => h('article', 'wb-evidence-item', h('h3', '', t.name ?? t.toolId ?? t.id), h('p', '', t.description), h('small', '', t.toolId ?? t.id))))]
    else if (parts[0] === 'topics' && parts[1] === 'new') { topicForm(ctx.content, cache); return }
    else if (parts[0] === 'topics' && parts[2] === 'inbox') nodes = await inbox(ctx, parts[1], query.get('predictionId'))
    else if (parts[0] === 'topics' && parts[1]) nodes = topicView(cache, parts[1])
    else if (parts[0] === 'advanced' && parts[1] === 'new') { predictionForm(ctx.content, cache); return }
    else if (parts[0] === 'predictions' && parts[1]) {
      const p = cache.predictions.find((v) => v.predictionId === parts[1]); if (!p) throw new Error('找不到这个预测题。请返回公告栏或重新读取数据。')
      if (p.type !== 'binary') { nodes = [header('此题型暂未开放'), empty('当前版本只支持是／否预测', '这条记录不会获得可运行入口。')] }
      else if (parts[2] === 'edit') { predictionForm(ctx.content, cache, p); return }
      else { await detail(ctx, p, parts[2] === 'runs' ? parts[3] : null, parts[2], token); return }
    } else if (parts[0] === 'advanced') nodes = board(ctx)
    else nodes = courseBoard(ctx)
    if (ctx.isCurrent(token)) ctx.content.replaceChildren(...nodes)
  } catch (error) {
    if (ctx.isCurrent(token)) ctx.content.replaceChildren(header('这个工作区暂时未能打开'), empty(error.message, '已保存的数据不会因此清除。', button('重新读取', renderRoute)))
  }
}
async function initialize() {
  try {
    const [topics, predictions, agents, tools, config] = await Promise.all([api('/topics'), api('/predictions'), api('/agents'), api('/tools'), api('/config')])
    cache.topics = topics.topics; cache.predictions = predictions.predictions; cache.agents = agents.agents; cache.tools = tools.tools; cache.config = config
    const capability = await checkCourseCapability()
    cache.courseHistoryError = null
    if (capability.available) {
      try {
        const course = await api('/course/requests')
        if (!Array.isArray(course.requests)) setCourseCapability(unavailableCourseCapability('restart-required'))
        else cache.courseRequests = course.requests
      } catch (error) {
        if (isMissingCourseApi(error)) setCourseCapability(unavailableCourseCapability('restart-required'))
        else cache.courseHistoryError = '自动跟踪能力已连接，但历史任务暂时未能读取：' + error.message
      }
    }
    $('wb-global-error').hidden = true; $('wb-connection').textContent = '数据已连接'; await renderRoute()
  } catch (error) {
    $('wb-connection').textContent = '服务未连接'; showError(error)
    ctx.content.replaceChildren(header('研究室等待连接'), empty('暂时无法读取真实数据', '请启动本地服务后重试。这里不会用模拟任务冒充已保存的数据。', button('重新连接', initialize)))
  }
}
addEventListener('hashchange', () => { void renderRoute() })
addEventListener('workbench:datachanged', renderSidebar)
document.querySelector('.wb-skip').addEventListener('click', (event) => { event.preventDefault(); ctx.content.focus({ preventScroll: false }) })
void initialize()
