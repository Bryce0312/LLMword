import { isWorkspaceBuiltinText } from './locale-zh-en-workspace.js'
import { dataContent, uiContent, dateContent, $, h, header, empty, button, api, toast, route, goto, terminal, labels, fmt } from './workbench-core.js'
import { createProjectionState, selectRun, projectEvent } from './run-projection.js'
import { topicForm, predictionForm } from './workbench-forms.js'
import { sidebar, board, inbox, learning, agents, topicView } from './workbench-views.js'
import { detail, reportView } from './workbench-detail.js'
import { courseBoard, courseStartForm, mountCourseRequest } from './workbench-course.js'
import { probeCourseCapability, unavailableCourseCapability, isMissingCourseApi, environmentPresentation } from './course-capability.js'
import { providerConnectionView } from './workbench-provider.js'
import { courseExamples } from './course-examples.js'
import { guideView } from './guide.js'
import { welcomeView } from './welcome.js'
import { createWorkbenchRoomShell } from './workbench-room-shell.js'
import { initialRouteHash, isGuideIndex, isPublicRoute, mergeDeletedHistoryMetadata, mergeRoomHistory } from './room-shell-navigation.js'
import { consumeTutorialFocus, rememberRoute } from './route-history.js'
import { initLocaleUI } from './locale.js'

initLocaleUI()

const cache = { topics: [], predictions: [], agents: [], tools: [], config: {}, courseRequests: [], courseAvailable: false, courseCapability: null, courseHistoryError: null, deletedCourseRequestIds: new Set(), deletedCoursePredictionIds: new Set(), historyDeletionPending: new Set(), runs: new Map(), events: new Map() }
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
  checkCourseCapability, setCourseCapability, onDataConnected: markDataConnected,
  onFilter(value) { ctx.filterTopic = value; renderSidebar(); if (location.hash === '#/predictions') void renderRoute(); else goto('/predictions') },
}
let roomShell = null
let liveCtx = ctx
Object.defineProperties(ctx, { activeCourseRequestId: { get: () => roomShell?.activeCourseRequestId ?? null }, activePredictionId: { get: () => null } })

function markDataConnected() {
  const node = $('wb-connection'); if (!node) return
  node.textContent = '数据已连接'; delete node.dataset.state
}
function renderEnvironmentBadge(config = cache.config, connection = cache.courseConnection) {
  const el = $('wb-environment')
  if (!el) return
  const presentation = environmentPresentation(config, connection)
  if (!presentation) { el.hidden = true; return }
  el.hidden = false
  el.textContent = presentation.text
  el.dataset.mode = presentation.mode
  el.dataset.dot = presentation.dot
  el.dataset.connected = presentation.configured ? 'true' : 'false'
  el.title = presentation.title
}
async function refreshEnvironmentBadge() {
  try { cache.courseConnection = await api('/course/provider-connection') }
  catch { cache.courseConnection = null }
  renderEnvironmentBadge(cache.config, cache.courseConnection)
}
function setCourseCapability(capability) {
  cache.courseCapability = capability; cache.courseAvailable = capability.available
  if (capability.config) { cache.config = capability.config; renderEnvironmentBadge(capability.config); void refreshEnvironmentBadge() }
  return capability
}
function checkCourseCapability() {
  if (!capabilityCheck) capabilityCheck = probeCourseCapability().then(setCourseCapability).finally(() => { capabilityCheck = null })
  return capabilityCheck
}
function renderSidebar() { const container = $('wb-sidebar'); if (container) container.replaceChildren(...sidebar(ctx)) }
function toolsWorkspace() {
  const field = (tool, name, tag) => (isWorkspaceBuiltinText('tool', tool, name) ? uiContent : dataContent)(tag, '', tool[name] ?? tool.toolId ?? tool.id)
  return [header('工具台', '只有已注册且获授权的能力才能实际执行。'), h('div', 'wb-paper', cache.tools.map(tool => h('article', 'wb-evidence-item', field(tool, 'name', 'h3'), field(tool, 'description', 'p'), dataContent('small', '', tool.toolId ?? tool.id))))]
}
function showError(error) {
  $('wb-global-error').hidden = false
  $('wb-global-error').replaceChildren(h('span', '', error.message + ' '), button('重新读取', initialize, 'wb-text-button'))
}
function dispatch(effects) {
  for (const effect of effects) {
    if (effect.type === 'resync.required') { connectEvents(); continue }
    if (effect.type === 'run.snapshot.required') continue
    liveCtx.room?.apply(effect)
  }
}
function updateLive(run) {
  const activeCtx = liveCtx
  const { parts } = route()
  const p = parts[0] === 'predictions' ? cache.predictions.find((p) => p.predictionId === parts[1]) : null
  if (!p || !run || p.predictionId !== run.predictionId) return
  const effective = projection.runs[run.runId]?.status ?? run.status
  const latest = $('wb-contract-latest')
  const contract = activeCtx.content.querySelector('.wb-forecast-note')
  if (latest && run.predictionVersion === Number(contract?.dataset.predictionVersion) && (!latest.dataset.createdAt || Date.parse(run.createdAt) >= Date.parse(latest.dataset.createdAt))) {
    latest.replaceChildren(h('span', '', labels[effective] ?? effective), ' · ', dateContent(run.updatedAt, p.timezone))
    latest.dataset.createdAt = run.createdAt
  }
  if (run.runId !== projection.selectedRunId) return
  reportView(activeCtx, p, run)
  const history = activeCtx.content.querySelector('[data-run-id="' + CSS.escape(run.runId) + '"]')
  if (history) history.replaceChildren(h('span', '', '契约 v' + run.predictionVersion), ' · ', dateContent(run.createdAt), ' · ', h('span', '', labels[effective] ?? effective))
  const start = $('wb-start-run')
  if (start) start.disabled = start.dataset.canStart !== 'true' || !terminal({ status: projection.runs[run.runId]?.status ?? run.status })
}
function connectEvents() {
  stream?.close()
  if (typeof EventSource === 'undefined') { $('wb-connection').textContent = '浏览器不支持实时事件'; return }
  const source = new EventSource('/api/v1/events'); stream = source
  source.onopen = () => { if (stream !== source) return; markDataConnected() }
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

async function renderLegacyRoute() {
  liveCtx = ctx
  const token = ++serial; const { parts, query } = route()
  const courseRoute = parts[0] === 'course' || parts[0] === 'course-examples' || (parts[0] === 'predictions' && (!parts[1] || parts[1] === 'new'))
  document.body.classList.toggle('wb-course-route', courseRoute)
  if (courseRoute || parts[0] === 'guide' || parts[0] === 'model-connection') { stream?.close(); stream = null }
  else if (!stream) connectEvents()
  ctx.courseCleanup?.(); ctx.courseCleanup = null
  ctx.room?.destroy(); ctx.room = null
  ctx.accept(selectRun(projection, null))
  $('wb-global-error').hidden = true; renderSidebar()
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('is-selected', a.dataset.nav === parts[0] || (a.dataset.nav === 'predictions' && courseRoute))
  ctx.content.replaceChildren(h('p', 'wb-loading', '正在读取工作区…'))
  try {
    let nodes
    if (parts[0] === 'course-examples') nodes = await courseExamples({ finance: query.get('set') === 'finance' })
    else if (parts[0] === 'guide') nodes = await guideView(ctx, parts)
    else if (parts[0] === 'course' && parts[1] && parts[1] !== 'new') { await mountCourseRequest(ctx, parts[1], token); return }
    else if ((parts[0] === 'course' && (!parts[1] || parts[1] === 'new')) || (parts[0] === 'predictions' && parts[1] === 'new')) nodes = courseStartForm(ctx, { standalone: true })
    else if (parts[0] === 'learning') nodes = await learning()
    else if (parts[0] === 'model-connection') nodes = await providerConnectionView(ctx)
    else if (parts[0] === 'agents') {
      const historical = parts[1] && query.has('specVersion') ? await api('/agents/' + parts[1] + '?specVersion=' + encodeURIComponent(query.get('specVersion'))) : null
      nodes = agents(ctx, parts[1], historical)
    }
    else if (parts[0] === 'tools') nodes = toolsWorkspace()
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
async function renderShellWorkspace(owner, target, token) {
  const { parts, query } = target
  if (parts[0] === 'guide') return guideView(owner, parts)
  if (parts[0] === 'course-examples') return courseExamples({ finance: query.get('set') === 'finance' })
  if (parts[0] === 'course' || (parts[0] === 'predictions' && (!parts[1] || parts[1] === 'new'))) return courseStartForm(owner, { standalone: true })
  if (parts[0] === 'model-connection') return providerConnectionView(owner)
  if (parts[0] === 'agents') {
    const historical = parts[1] && query.has('specVersion') ? await api('/agents/' + encodeURIComponent(parts[1]) + '?specVersion=' + encodeURIComponent(query.get('specVersion'))) : null
    if (!owner.isActive()) return null
    return agents(owner, parts[1], historical)
  }
  if (parts[0] === 'learning') return learning()
  if (parts[0] === 'tools') return toolsWorkspace()
  if (parts[0] === 'topics' && parts[1] === 'new') { topicForm(owner.content, cache); return null }
  if (parts[0] === 'topics' && parts[2] === 'inbox') return inbox(owner, parts[1], query.get('predictionId'))
  if (parts[0] === 'topics' && parts[1]) return topicView(cache, parts[1])
  if (parts[0] === 'advanced' && parts[1] === 'new') { predictionForm(owner.content, cache); return null }
  if (parts[0] === 'advanced') return board(owner)
  if (parts[0] === 'predictions' && parts[1]) {
    const prediction = cache.predictions.find(value => value.predictionId === parts[1])
    if (!prediction) throw new Error('找不到这个预测题，请重新读取历史记录。')
    if (prediction.type !== 'binary') return [header('此题型暂未开放'), empty('当前版本只支持是／否预测', '历史记录继续保留。')]
    if (parts[2] === 'edit') predictionForm(owner.content, cache, prediction)
    else await detail(owner, prediction, parts[2] === 'runs' ? parts[3] : null, parts[2], token)
    return null
  }
  return [header('找不到这个工作区'), empty('请使用顶部菜单选择操作', '当前研究室和历史记录保持不变。')]
}

async function renderPublicRoute() {
  const token = ++serial
  const { parts } = route()
  const focusTutorial = consumeTutorialFocus()
  if (roomShell) { roomShell.dispose(); roomShell = null }
  stream?.close(); stream = null
  ctx.courseCleanup?.(); ctx.courseCleanup = null
  ctx.room?.destroy(); ctx.room = null
  liveCtx = ctx
  ctx.accept(selectRun(projection, null))
  document.body.dataset.publicPage = 'true'
  document.body.classList.remove('wb-course-route')
  $('wb-global-error').hidden = true
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('is-selected', a.dataset.nav === parts[0])
  ctx.content.replaceChildren(h('p', 'wb-loading', '正在打开…'))
  try {
    const nodes = parts[0] === 'welcome' ? welcomeView() : await guideView(ctx, parts)
    if (token !== serial) return
    ctx.content.replaceChildren(...nodes)
    document.title = parts[0] === 'welcome' ? '股票预测事务所' : '教程 · 股票预测事务所'
    window.scrollTo({ top: 0 })
    if (parts[0] === 'welcome' && focusTutorial) {
      requestAnimationFrame(() => document.getElementById('welcome-tutorial')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  } catch (error) {
    if (token !== serial) return
    ctx.content.replaceChildren(header('这个页面暂时未能打开'), empty(error.message, '已保存的数据不会因此清除。', button('重新读取', renderRoute)))
  }
}

async function renderRoute(options = {}) {
  if (document.body.dataset.roomShell !== 'true') return renderLegacyRoute()
  let targetHash = initialRouteHash(location.hash)
  if (isGuideIndex(targetHash)) targetHash = '#/welcome'
  if (targetHash !== location.hash) history.replaceState(null, '', targetHash)
  rememberRoute(targetHash)
  if (isPublicRoute(targetHash)) return renderPublicRoute()
  if (!workspaceLoaded) return initialize()
  document.title = '股票预测事务所'
  if (document.body.dataset.publicPage === 'true') {
    delete document.body.dataset.publicPage
    ctx.content.replaceChildren()
    $('wb-room-host')?.replaceChildren()
  }
  if (!roomShell) {
    ctx.courseCleanup?.(); ctx.courseCleanup = null; ctx.room?.destroy(); ctx.room = null
    stream?.close(); stream = null
    roomShell = createWorkbenchRoomShell({ baseCtx: ctx, mountScene: mountCourseRequest, renderWorkspace: renderShellWorkspace, renderSidebar,
      onWorkspaceContext(owner, target) {
        liveCtx = owner
        const legacyRun = target.parts[0] === 'predictions' && target.parts[1] && target.parts[1] !== 'new'
        if (legacyRun) connectEvents()
      },
      onWorkspaceDispose() { stream?.close(); stream = null; liveCtx = ctx; ctx.accept(selectRun(projection, null)) },
    })
  }
  $('wb-global-error').hidden = true
  renderSidebar()
  return roomShell.render(location.hash || '#/room', options)
}

let workspaceLoaded = false
let workspaceLoad = null

async function loadWorkspace() {
  const historyBaseline = [...cache.courseRequests]
  try {
    const [topics, predictions, agents, tools, config] = await Promise.all([api('/topics'), api('/predictions'), api('/agents'), api('/tools'), api('/config')])
    cache.topics = topics.topics; cache.predictions = predictions.predictions.filter(value => !cache.deletedCoursePredictionIds.has(value.predictionId)); cache.agents = agents.agents; cache.tools = tools.tools; cache.config = config
    renderEnvironmentBadge(config)
    void refreshEnvironmentBadge()
    const capability = await checkCourseCapability()
    cache.courseHistoryError = null
    if (capability.available) {
      try {
        const course = await api('/course/requests')
        if (!Array.isArray(course.requests)) setCourseCapability(unavailableCourseCapability('restart-required'))
        else {
          mergeDeletedHistoryMetadata(cache, course)
          cache.courseRequests = mergeRoomHistory(course.requests, cache.courseRequests, historyBaseline, cache.deletedCourseRequestIds)
        }
      } catch (error) {
        if (isMissingCourseApi(error)) setCourseCapability(unavailableCourseCapability('restart-required'))
        else cache.courseHistoryError = '历史任务暂时无法读取，请重试。'
      }
    }
    workspaceLoaded = true
    $('wb-global-error').hidden = true; markDataConnected()
  } catch (error) {
    $('wb-connection').textContent = '服务未连接'; showError(error)
    if (!isPublicRoute(location.hash)) ctx.content.replaceChildren(header('研究室等待连接'), empty('暂时无法读取真实数据', '请启动本地服务后重试。这里不会用模拟任务冒充已保存的数据。', button('重新连接', initialize)))
  }
}

async function initialize() {
  if (isPublicRoute(location.hash)) return renderRoute()
  if (!workspaceLoad) workspaceLoad = loadWorkspace().finally(() => { workspaceLoad = null })
  await workspaceLoad
  if (workspaceLoaded) await renderRoute()
}
addEventListener('hashchange', event => { let previousHash; try { previousHash = new URL(event.oldURL).hash } catch {} void renderRoute({ previousHash }) })
addEventListener('workbench:datachanged', renderSidebar)
document.querySelector('.wb-skip')?.addEventListener('click', event => { event.preventDefault(); if (roomShell) roomShell.focusCurrent(); else ctx.content.focus({ preventScroll: false }) })
void initialize()
