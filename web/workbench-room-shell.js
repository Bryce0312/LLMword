import { $, h, header, empty, button, api } from './workbench-core.js'
import { createRoomShellNavigation, roomShellTarget, mergeRoomHistory } from './room-shell-navigation.mjs'

const titles = { predictions: '开始预测', course: '开始预测', agents: '研究室设置', 'model-connection': '模型连接', learning: '学习档案', tools: '工具台', advanced: '高级材料研读', topics: '主题档案', 'course-examples': '流程案例' }

export function createWorkbenchRoomShell({ baseCtx, mountScene, renderWorkspace, renderSidebar, onWorkspaceContext, onWorkspaceDispose }) {
  const main = $('wb-content'), host = $('wb-room-host'), scene = $('wb-scene')
  const dialog = $('wb-workspace-dialog'), content = $('wb-workspace-content'), title = $('wb-workspace-title'), close = $('wb-workspace-close')
  const historyMenu = $('wb-history-menu'), topbar = document.querySelector('.wb-header'), camera = scene?.querySelector('.wb-room-camera')
  if (!main || !host || !dialog || !content || !title || !close || !scene) throw new Error('研究室页面结构未加载完整，请刷新当前页面。')
  let navigation, sceneCtx = null, overlayCtx = null, returnFocus = null, disposed = false, historyEpoch = 0
  dialog.setAttribute('role', 'dialog'); dialog.removeAttribute('aria-modal')
  scene.tabIndex = -1
  function currentContext(token, kind) {
    const owner = Object.create(baseCtx)
    const active = () => !disposed && (kind === 'scene' ? navigation.isSceneCurrent(token) : navigation.isOverlayCurrent(token))
    Object.assign(owner, { content: kind === 'scene' ? main : content, roomHost: kind === 'scene' ? host : null, room: null, courseCleanup: null, selectCourseRun: null, selectedRuns: new Map(),
      isActive: active, isCurrent: value => value === token && active(),
      render: () => active() ? navigation.navigate(location.hash, { forceOverlay: kind === 'overlay' }) : Promise.resolve(),
      reload: () => active() ? (kind === 'scene' ? navigation.navigate(navigation.sceneHash, { forceScene: true }) : baseCtx.reload()) : Promise.resolve(),
      error: error => { if (active()) baseCtx.error(error) }, onDataConnected: () => { if (active()) baseCtx.onDataConnected?.() },
    })
    Object.defineProperties(owner, {
      courseRetryInput: { get: () => baseCtx.courseRetryInput, set: value => { baseCtx.courseRetryInput = value }, configurable: true },
      activeCourseRequestId: { get: () => navigation.sceneId }, activePredictionId: { get: () => null },
    })
    return owner
  }
  function cleanOwner(owner) { if (!owner) return; owner.courseCleanup?.(); owner.courseCleanup = null; owner.room?.destroy(); owner.room = null; owner.selectCourseRun = null }
  function clearWorkspace() { cleanOwner(overlayCtx); overlayCtx = null; content.replaceChildren(); onWorkspaceDispose?.() }
  function reveal() { if (typeof dialog.show === 'function') { if (!dialog.open) { try { dialog.show() } catch { dialog.setAttribute('open', '') } } } else dialog.setAttribute('open', '') }
  function focusWorkspace() { const target = content.querySelector('input:not([disabled]),textarea:not([disabled]),select:not([disabled])') ?? content; target.focus({ preventScroll: true }) }
  function updateNav(target) { for (const link of document.querySelectorAll('[data-nav]')) link.classList.toggle('is-selected', target?.kind === 'overlay' && (link.dataset.nav === target.parts[0] || (link.dataset.nav === 'predictions' && target.parts[0] === 'course'))) }
  function syncHeaderHeight() { if (!disposed && topbar) document.body.style.setProperty('--wb-header-height', Math.ceil(topbar.getBoundingClientRect().height) + 'px') }
  navigation = createRoomShellNavigation({
    clearScene() { cleanOwner(sceneCtx); sceneCtx = null; main.replaceChildren(); host.replaceChildren(); if (camera) camera.hidden = false },
    showIdle() { main.replaceChildren(); host.replaceChildren(); if (camera) camera.hidden = false; scene.dataset.state = 'idle' },
    sceneChanged() { renderSidebar(); updateNav(null) },
    async mountScene(target, token) {
      sceneCtx = currentContext(token, 'scene'); scene.dataset.state = 'loading'
      main.replaceChildren(h('p', 'wb-loading', '正在读取已保存的预测记录…'))
      try { await mountScene(sceneCtx, target.id, token); if (navigation.isSceneCurrent(token)) { scene.dataset.state = 'task'; if (camera) camera.hidden = host.children.length > 0 } }
      catch (error) { if (navigation.isSceneCurrent(token)) main.replaceChildren(header('这份预测暂时未能读取'), empty(error.message, '历史数据保留，可重新读取。', button('重新读取', () => { void sceneCtx?.reload() }))) }
    },
    selectRun(runId) { if (runId) sceneCtx?.selectCourseRun?.(runId) },
    prepareOverlay(target) {
      clearWorkspace(); main.setAttribute('inert', ''); title.textContent = titles[target.parts[0]] ?? '操作面板'
      content.replaceChildren(h('p', 'wb-loading', '正在读取工作区…')); reveal(); updateNav(target)
    },
    async renderOverlay(target, token) {
      const owner = currentContext(token, 'overlay'); overlayCtx = owner; onWorkspaceContext?.(owner, target)
      try { const nodes = await renderWorkspace(owner, target, token); if (owner.isActive()) { if (nodes) content.replaceChildren(...nodes); focusWorkspace(); syncHeaderHeight() } }
      catch (error) { if (owner.isActive()) content.replaceChildren(header('这个工作区暂时未能打开'), empty(error.message, '已保存的数据不会因此清除。', button('重新读取', () => { void owner.render() }))) }
    },
    closeOverlay() { clearWorkspace(); main.removeAttribute('inert'); if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); updateNav(null) },
    revealOverlay() { reveal(); focusWorkspace() },
    replaceHash(hash) { if (location.hash !== hash) history.replaceState(null, '', hash) },
    restoreFocus() { const target = returnFocus?.isConnected ? returnFocus : document.querySelector('.wb-brand'); target?.focus({ preventScroll: true }) },
  })
  async function refreshHistory() {
    if (!historyMenu?.open || disposed) return
    const epoch = ++historyEpoch, baseline = [...baseCtx.cache.courseRequests]
    try {
      const value = await api('/course/requests')
      if (disposed || epoch !== historyEpoch || !historyMenu.open) return
      if (!Array.isArray(value.requests)) throw new Error('历史接口返回不完整')
      baseCtx.cache.courseRequests = mergeRoomHistory(value.requests, baseCtx.cache.courseRequests, baseline); baseCtx.cache.courseHistoryError = null; renderSidebar()
    } catch { if (!disposed && epoch === historyEpoch && historyMenu.open) { baseCtx.cache.courseHistoryError = '历史记录暂未刷新，下面保留上次读取的真实任务。'; renderSidebar() } }
  }
  const onToggle = () => { if (historyMenu.open) void refreshHistory(); else historyEpoch++ }
  const onHeaderClick = event => {
    const link = event.target.closest?.('a[href^="#/"]')
    if (!link || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const hash = link.getAttribute('href'), target = roomShellTarget(hash)
    navigation.rememberSceneHash(location.hash)
    if (target.kind === 'overlay') returnFocus = link
    if (historyMenu?.contains(link)) { historyMenu.open = false; historyEpoch++ }
    else if (historyMenu?.open) { historyMenu.open = false; historyEpoch++ }
    if (hash === location.hash || (!location.hash && target.kind === 'idle')) { event.preventDefault(); void navigation.navigate(hash) }
  }
  const topModalOpen = event => {
    const path = event.composedPath?.() ?? []
    if (path.some(node => node.classList?.contains('wb-confirm-dialog') || node.classList?.contains('wb-confirm-overlay'))) return true
    try { if (document.querySelector('dialog:modal')) return true } catch {}
    return Boolean(document.querySelector('.wb-confirm-dialog[open],.wb-confirm-overlay'))
  }
  const onKeyDown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || topModalOpen(event)) return
    if (historyMenu?.open) { event.preventDefault(); historyMenu.open = false; historyEpoch++; historyMenu.querySelector('summary')?.focus(); return }
    if (navigation.overlayOpen) { event.preventDefault(); navigation.closeOverlay() }
  }
  const onClose = () => { if (navigation.overlayOpen) navigation.closeOverlay() }
  const onCloseClick = () => navigation.closeOverlay()
  const onCancel = event => { if (!event.defaultPrevented && !topModalOpen(event)) { event.preventDefault(); navigation.closeOverlay() } }
  const onOutsideHistory = event => { if (historyMenu?.open && !historyMenu.contains(event.target) && !topModalOpen(event)) { historyMenu.open = false; historyEpoch++ } }
  close.addEventListener('click', onCloseClick); dialog.addEventListener('close', onClose); dialog.addEventListener('cancel', onCancel)
  topbar?.addEventListener('click', onHeaderClick); historyMenu?.addEventListener('toggle', onToggle)
  document.addEventListener('keydown', onKeyDown); document.addEventListener('click', onOutsideHistory)
  window.addEventListener('resize', syncHeaderHeight); window.visualViewport?.addEventListener('resize', syncHeaderHeight)
  const headerObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(syncHeaderHeight) : null; if (topbar) headerObserver?.observe(topbar)
  syncHeaderHeight()
  return {
    get activeCourseRequestId() { return navigation.sceneId }, get sceneContext() { return sceneCtx }, get workspaceContext() { return overlayCtx },
    render: (hash, options) => navigation.navigate(hash, options),
    focusCurrent() { if (navigation.overlayOpen) focusWorkspace(); else if (main.children.length) main.focus(); else document.querySelector('[data-nav="predictions"]')?.focus() },
    dispose() { disposed = true; historyEpoch++; navigation.dispose(); headerObserver?.disconnect(); close.removeEventListener('click', onCloseClick); dialog.removeEventListener('close', onClose); dialog.removeEventListener('cancel', onCancel); topbar?.removeEventListener('click', onHeaderClick); historyMenu?.removeEventListener('toggle', onToggle); document.removeEventListener('keydown', onKeyDown); document.removeEventListener('click', onOutsideHistory); window.removeEventListener('resize', syncHeaderHeight); window.visualViewport?.removeEventListener('resize', syncHeaderHeight) },
  }
}
