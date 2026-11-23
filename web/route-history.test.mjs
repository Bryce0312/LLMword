import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consumeTutorialFocus, goBack, rememberRoute, requestTutorialFocus, resetRouteHistory, routeHistorySize } from './route-history.mjs'

function freshLocation() { globalThis.location = { hash: '' } }

test('tutorial back returns to the previous in-app route instead of a fixed page', () => {
  resetRouteHistory(); freshLocation()
  rememberRoute('#/welcome')
  rememberRoute('#/guide')
  rememberRoute('#/guide/update/1')
  goBack('#/guide')
  assert.equal(location.hash, '#/guide')
  rememberRoute('#/guide')
  goBack('#/welcome')
  assert.equal(location.hash, '#/welcome')
  rememberRoute('#/welcome')
  assert.equal(routeHistorySize(), 0)
})

test('direct tutorial entry falls back without leaving the app', () => {
  resetRouteHistory(); freshLocation()
  rememberRoute('#/guide/collaboration')
  goBack('#/guide')
  assert.equal(location.hash, '#/guide')
  rememberRoute('#/guide')
  goBack('#/welcome')
  assert.equal(location.hash, '#/welcome')
})

test('browser-like return to a previous route pops it instead of growing the stack', () => {
  resetRouteHistory(); freshLocation()
  rememberRoute('#/welcome')
  rememberRoute('#/guide')
  rememberRoute('#/guide/update/1')
  rememberRoute('#/guide')
  assert.equal(routeHistorySize(), 1)
  goBack('#/welcome')
  assert.equal(location.hash, '#/welcome')
})

test('tutorial focus is requested once and consumed by the welcome render', () => {
  resetRouteHistory()
  assert.equal(consumeTutorialFocus(), false)
  requestTutorialFocus()
  assert.equal(consumeTutorialFocus(), true)
  assert.equal(consumeTutorialFocus(), false)
})
