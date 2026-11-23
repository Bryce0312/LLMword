// In-app route stack for tutorial "back to previous page". Never leaves the app.
const stack = []
let current = null
let suppressPush = false
let tutorialFocus = false

export function rememberRoute(hash) {
  const value = String(hash || '')
  if (!value) return
  if (suppressPush) { suppressPush = false; current = value; return }
  if (value === current) return
  if (stack.length && stack[stack.length - 1] === value) {
    stack.pop(); current = value; return
  }
  if (current) {
    stack.push(current)
    if (stack.length > 30) stack.shift()
  }
  current = value
}

export function goBack(fallback = '#/welcome') {
  const target = stack.pop() ?? fallback
  suppressPush = true
  location.hash = target
  return target
}

export function requestTutorialFocus() { tutorialFocus = true }

export function consumeTutorialFocus() {
  const value = tutorialFocus
  tutorialFocus = false
  return value
}

export function resetRouteHistory() {
  stack.length = 0
  current = null
  suppressPush = false
  tutorialFocus = false
}

export function routeHistorySize() { return stack.length }
