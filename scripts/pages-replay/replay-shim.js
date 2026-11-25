/* GitHub Pages 只读回放 shim。
 * 由 scripts/build-pages.mjs 注入到 workbench.js 之前。
 * 只拦截本页发出的 /api/v1 请求和写操作控件；不修改 web/ 下的产品代码。 */
(function () {
  'use strict'

  var SNAPSHOT = window.__LLMWORD_REPLAY__
  if (!SNAPSHOT || !Array.isArray(SNAPSHOT.routes)) return

  var API_PREFIX = '/api/v1'
  var READ_ONLY_MESSAGE = '静态回放演示：不能在这里新建或修改任务。请用 Codespaces 或本地 npm start。'
  var NOT_FOUND_MESSAGE = '静态回放演示里没有这条记录。请从封存任务列表进入。'
  var NEW_TASK_NOTE = '静态回放演示：这里不能新建预测任务。下方列出的是封存的模拟运行，点「打开研究室」可查看一次完整的协作回放。'
  var originalFetch = window.fetch ? window.fetch.bind(window) : null
  var errors = []

  function reportError(value) {
    errors.push(String((value && value.stack) || value))
    var node = document.getElementById('wb-replay-errors')
    if (node) node.textContent = JSON.stringify(errors)
  }
  window.addEventListener('error', function (event) { reportError(event.error || event.message) })
  window.addEventListener('unhandledrejection', function (event) { reportError(event.reason) })

  function notify(text) {
    var toast = document.getElementById('wb-toast')
    if (!toast) return
    clearTimeout(notify.timer)
    toast.textContent = text
    toast.hidden = false
    notify.timer = setTimeout(function () { toast.hidden = true }, 5000)
  }

  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
      status: status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href)
      if (input && typeof input.url === 'string') return new URL(input.url, location.href)
    } catch {}
    return null
  }

  function requestMethod(input, init) {
    if (init && typeof init.method === 'string') return init.method.toUpperCase()
    if (input && typeof input.method === 'string') return input.method.toUpperCase()
    return 'GET'
  }

  function findRoute(pathname, searchParams) {
    var withQuery = null
    for (var index = 0; index < SNAPSHOT.routes.length; index++) {
      var route = SNAPSHOT.routes[index]
      if (route.method !== 'GET' || route.path !== pathname) continue
      if (!route.search) { if (!withQuery) withQuery = route; continue }
      var expected = new URLSearchParams(route.search)
      var matches = true
      expected.forEach(function (value, key) { if (searchParams.get(key) !== value) matches = false })
      if (matches) return route
    }
    return withQuery
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      var url = urlOf(input)
      if (!url || !url.pathname.startsWith(API_PREFIX)) return originalFetch(input, init)
      var method = requestMethod(input, init)
      if (method !== 'GET') {
        return Promise.resolve(jsonResponse(409, { error: { code: 'REPLAY_READ_ONLY', message: READ_ONLY_MESSAGE, retryable: false } }))
      }
      var pathname = url.pathname.slice(API_PREFIX.length) || '/'
      var route = findRoute(pathname, url.searchParams)
      if (!route) return Promise.resolve(jsonResponse(404, { error: { code: 'REPLAY_NOT_FOUND', message: NOT_FOUND_MESSAGE, retryable: false } }))
      return Promise.resolve(jsonResponse(route.status || 200, route.body))
    }
  }

  // 写控件在进入产品事件处理器之前就被拦下，避免出现确认框或服务端写请求。
  var WRITE_CONTROL = /(新建|开始预测|开始跟踪|开始财报核验|检查一次新资料|重试本次调查|重新调查|恢复预测汇总|继续整理已有报告|生成研究员资料整理版|停止跟踪|读取官方结果并核验|删除记录|保存供后续任务使用|保存预算|修改理解后重新跟踪|导入旧案例|确认删除)/
  function isWriteControl(text) {
    if (!text) return false
    if (/^(查看|刷新|重新检查|导出|打开|返回)/.test(text)) return false
    return WRITE_CONTROL.test(text)
  }

  document.addEventListener('click', function (event) {
    var target = event.target
    var control = target && target.closest ? target.closest('button, a, [role="button"]') : null
    if (!control) return
    if (!isWriteControl((control.textContent || '').trim())) return
    event.preventDefault()
    event.stopImmediatePropagation()
    notify(READ_ONLY_MESSAGE)
  }, true)

  document.addEventListener('submit', function (event) {
    event.preventDefault()
    event.stopImmediatePropagation()
    notify(READ_ONLY_MESSAGE)
  }, true)

  function dispatch(source, type, payload) {
    var event
    try {
      event = type === 'message'
        ? new MessageEvent('message', { data: JSON.stringify(payload), origin: location.origin, lastEventId: '' })
        : new Event(type)
    } catch {
      event = { type: type, data: JSON.stringify(payload) }
    }
    var handler = source['on' + type]
    if (typeof handler === 'function') handler.call(source, event)
    var listeners = source.__listeners[type] || []
    for (var i = 0; i < listeners.length; i++) listeners[i].call(source, event)
  }

  function ReplayEventSource(url) {
    if (!(this instanceof ReplayEventSource)) return new ReplayEventSource(url)
    var source = this
    var closed = false
    this.url = String(url)
    this.readyState = 0
    this.withCredentials = false
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.__listeners = { open: [], message: [], error: [] }
    this.addEventListener = function (type, listener) {
      if (this.__listeners[type] && typeof listener === 'function') this.__listeners[type].push(listener)
    }
    this.removeEventListener = function (type, listener) {
      var list = this.__listeners[type]
      if (!list) return
      var index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
    this.close = function () { closed = true; source.readyState = 2 }
    setTimeout(function () {
      if (closed) return
      source.readyState = 1
      dispatch(source, 'open')
      dispatch(source, 'message', SNAPSHOT.sync || { type: 'sync', payload: { reset: true, runs: [] } })
    }, 0)
  }
  window.EventSource = ReplayEventSource

  function requests() {
    var route = findRoute('/course/requests', new URLSearchParams())
    return route && route.body && Array.isArray(route.body.requests) ? route.body.requests : []
  }

  function statusLabel(record) {
    return ({ completed: '已完成', insufficient: '资料不足', failed: '失败', stopped: '已停止', queued: '排队中', researching: '调查中' })[record.status] || '封存记录'
  }

  function buildBoard() {
    var board = document.createElement('section')
    board.className = 'wb-paper wb-replay-board'
    board.setAttribute('data-replay-board', 'true')
    board.setAttribute('aria-label', '封存模拟回放任务')
    var heading = document.createElement('div')
    heading.className = 'wb-page-heading'
    var copy = document.createElement('div')
    var title = document.createElement('h1')
    title.textContent = '封存模拟回放任务'
    var detail = document.createElement('p')
    detail.textContent = '数据来自 mock 环境的封存运行，只读展示，不代表真实模型结果或预测准确率。'
    copy.appendChild(title)
    copy.appendChild(detail)
    heading.appendChild(copy)
    board.appendChild(heading)
    var grid = document.createElement('div')
    grid.className = 'wb-board-grid'
    var list = requests()
    for (var index = 0; index < list.length; index++) {
      var record = list[index]
      var id = record.requestId || record.id
      if (!id) continue
      var link = '#/course/' + encodeURIComponent(id) + '?results=1'
      var card = document.createElement('article')
      card.className = 'wb-paper wb-board-card'
      card.setAttribute('data-replay-request', id)
      var top = document.createElement('div')
      top.className = 'wb-card-top'
      var badge = document.createElement('span')
      badge.className = 'wb-badge'
      badge.textContent = statusLabel(record)
      var mode = document.createElement('span')
      mode.textContent = '模拟模型 / 历史／测试快照'
      top.appendChild(badge)
      top.appendChild(mode)
      var question = document.createElement('h3')
      var anchor = document.createElement('a')
      anchor.href = link
      anchor.textContent = record.question || (record.normalized && record.normalized.question) || '封存的模拟问题'
      question.appendChild(anchor)
      var probability = record.forecast && Number.isFinite(record.forecast.probabilityYes)
        ? Math.round(record.forecast.probabilityYes * 100) + '%'
        : '未发布概率'
      var score = document.createElement('div')
      score.className = 'wb-card-probability'
      score.appendChild(document.createTextNode(probability))
      var note = document.createElement('small')
      note.textContent = 'Yes 发生概率（模拟演示，非真实预测）'
      score.appendChild(note)
      var action = document.createElement('a')
      action.className = 'wb-button'
      action.href = link
      action.textContent = '打开研究室'
      card.appendChild(top)
      card.appendChild(question)
      card.appendChild(score)
      card.appendChild(action)
      grid.appendChild(card)
    }
    board.appendChild(grid)
    return board
  }

  function buildNotice(text) {
    var note = document.createElement('section')
    note.className = 'wb-paper wb-replay-readonly'
    note.setAttribute('data-replay-readonly', 'true')
    note.setAttribute('role', 'note')
    note.style.margin = '0 0 14px'
    var strong = document.createElement('strong')
    strong.textContent = '静态回放演示'
    var body = document.createElement('p')
    body.style.margin = '4px 0 0'
    body.textContent = text
    note.appendChild(strong)
    note.appendChild(body)
    return note
  }

  function hashParts() {
    var raw = (location.hash || '#/welcome').slice(1)
    var path = raw.split('?')[0]
    return path.split('/').filter(Boolean)
  }

  function decorate() {
    var parts = hashParts()
    var boardRoute = (parts[0] === 'course' || parts[0] === 'predictions') && (!parts[1] || parts[1] === 'new')
    var dialog = document.getElementById('wb-workspace-content')
    if (dialog && boardRoute) {
      var entry = dialog.querySelector('.cc-entry')
      if (!entry) return
      if (parts[1] === 'new' && !dialog.querySelector('[data-replay-readonly]')) dialog.insertBefore(buildNotice(NEW_TASK_NOTE), dialog.firstChild)
      if (!dialog.querySelector('[data-replay-board]')) {
        var board = buildBoard()
        entry.parentElement === dialog ? dialog.insertBefore(board, entry) : dialog.insertBefore(board, dialog.firstChild)
      }
      return
    }
    var main = document.getElementById('wb-content')
    if (main && parts[0] === 'room' && !main.querySelector('[data-replay-board]') && !main.children.length) main.appendChild(buildBoard())
  }

  var timer = null
  function schedule() {
    if (timer) return
    timer = setTimeout(function () { timer = null; decorate() }, 150)
  }

  if (typeof MutationObserver === 'function') new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('hashchange', schedule)
  document.addEventListener('DOMContentLoaded', function () {
    var node = document.createElement('pre')
    node.id = 'wb-replay-errors'
    node.hidden = true
    document.body.appendChild(node)
    schedule()
  })
})()
