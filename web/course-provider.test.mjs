import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COURSE_PROVIDER_PRESETS, COURSE_PROVIDER_DEFAULTS, courseProviderSettings, courseProviderModelForUrl, courseProviderPresentation, courseProviderError, saveCourseProviderKey, syncCourseProviderCredential } from './course-provider.mjs'

test('connection state never exposes a credential or claims configured means verified', () => {
  const view = courseProviderPresentation({ provider: 'deepseek', configured: true, keySource: 'session', canUpdate: true, activeRuns: 0, activeWatchers: 0, apiKey: 'DO_NOT_DISPLAY_KEY', balance: 'DO_NOT_DISPLAY_BALANCE' })
  assert.equal(view.canUpdate, true)
  assert.equal(view.label, 'API Key 已配置，待校验')
  assert(view.verificationHint.includes('/models'))
  assert.equal(courseProviderPresentation({ configured: true, connection: 'connected' }).label, 'API Key 已连接')
  assert.equal(courseProviderPresentation({ configured: true, connection: 'failed' }).label, 'API Key 已配置，未连接')
  assert(!JSON.stringify(view).includes('DO_NOT_DISPLAY'))
  assert.equal(courseProviderPresentation({ canUpdate: true, activeRuns: 1 }).canUpdate, false)
  const watched = courseProviderPresentation({ configured: true, canUpdate: true, activeRuns: 0, activeWatchers: 2 })
  assert.equal(watched.canUpdate, false, 'an existing key is not replaced while watchers remain')
  assert(watched.actionHint.includes('原 Key 保持不变'))
  assert(watched.actionHint.includes('2 个持续监听'))
  assert(watched.taskState.includes('持续监听：2'))
  const first = courseProviderPresentation({ canUpdate: true, activeRuns: 0, activeWatchers: 2 })
  assert.equal(first.canUpdate, true, 'the first key may be saved while old watches exist')
  assert(first.actionHint.includes('首次配置'))
  assert(courseProviderError({ code: 'PROVIDER_UPDATE_BUSY' }).includes('原 API Key 保持不变'))
  assert.equal(courseProviderPresentation({ configured: true, canUpdate: true, activeRuns: 1, activeWatchers: 0 }).canUpdate, false)
  assert.equal(courseProviderPresentation({ canUpdate: true, activeRuns: 0 }).canUpdate, false)
  assert.equal(courseProviderPresentation({ canUpdate: true }).canUpdate, false)
  const locked = courseProviderPresentation({ locked: true, canUpdate: true, activeRuns: 0, activeWatchers: 0 })
  assert.equal(locked.locked, true)
  assert.equal(locked.canUpdate, true, 'a mock room may accept typing and reject the save with a clear error')
  assert.equal(courseProviderPresentation({ configured: true, canUpdate: true, activeRuns: 1 }).canUpdate, false)
  assert.equal(courseProviderPresentation({ canUpdate: true, activeRuns: 0, activeWatchers: 1 }).canUpdate, true, 'a first key may be saved while old watches exist')
  assert(locked.actionHint.includes('start:live'))
  assert(courseProviderError({ code: 'MODE_LOCKED', status: 409 }).includes('模拟环境配置失败'))
})

test('save clears while transmitting, restores the exact edited value on verified success, and clears errors', async () => {
  const input = { value: '  TEST_NOT_A_REAL_KEY  ' }
  const result = await saveCourseProviderKey(input, async body => {
    assert.equal(input.value, '')
    assert.deepEqual(body, { apiKey: 'TEST_NOT_A_REAL_KEY' })
    return { configured: true, connection: 'connected' }
  })
  assert.equal(result.configured, true)
  assert.equal(input.value, '  TEST_NOT_A_REAL_KEY  ')
  input.value = 'ANOTHER_FAKE_VALUE'
  await assert.rejects(saveCourseProviderKey(input, async () => { assert.equal(input.value, ''); throw Object.assign(new Error('UPSTREAM_SECRET'), { status: 409 }) }))
  assert.equal(input.value, '')
  input.value = '   '
  await assert.rejects(saveCourseProviderKey(input, () => { throw new Error('must not send') }), { code: 'EMPTY_API_KEY' })
})

test('connection errors use safe guidance and never echo upstream bodies or user keys', () => {
  for (const status of [400, 401, 404, 409, 500]) {
    const text = courseProviderError({ status, message: 'SECRET_PROVIDER_BODY', apiKey: 'SECRET_INPUT' })
    assert(!text.includes('SECRET'))
  }
  assert(courseProviderError({ status: 409 }).includes('原连接继续使用'))
})

test('editable connection presets keep exact campus and official completion URLs and models', () => {
  assert.deepEqual(COURSE_PROVIDER_PRESETS, [
    { url: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model: 'DeepSeek-V4-Flash' },
    { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
  ])
  assert.deepEqual(courseProviderSettings(), COURSE_PROVIDER_DEFAULTS)
  for (const preset of COURSE_PROVIDER_PRESETS) assert.equal(courseProviderModelForUrl('  ' + preset.url + '  '), preset.model)
  assert.equal(courseProviderModelForUrl('https://custom.example/chat/completions'), null, 'custom endpoints do not force a model change')
  assert.deepEqual(courseProviderSettings({ url: ' https://custom.example/chat/completions ', model: ' custom-model ', apiKey: 'DO_NOT_COPY' }), { url: 'https://custom.example/chat/completions', model: 'custom-model' })
})

test('save submits the edited URL and model together with a cleared password field', async () => {
  const input = { value: '  FAKE_KEY  ' }
  const settings = { url: '  https://genai.comp.polyu.edu.hk/api/v1//chat/completions  ', model: '  DeepSeek-V4-Flash  ', ignored: 'DO_NOT_COPY' }
  await saveCourseProviderKey(input, async body => {
    assert.equal(input.value, '')
    assert.deepEqual(body, { apiKey: 'FAKE_KEY', url: 'https://genai.comp.polyu.edu.hk/api/v1//chat/completions', model: 'DeepSeek-V4-Flash' })
    return { configured: true }
  }, settings)
  input.value = 'FAKE_RETRY_KEY'
  await assert.rejects(saveCourseProviderKey(input, async body => {
    assert.equal(input.value, '')
    assert.equal(body.url, 'https://custom.example/chat/completions')
    assert.equal(body.model, 'custom-model')
    throw Object.assign(new Error('DO_NOT_DISPLAY'), { status: 409 })
  }, { url: 'https://custom.example/chat/completions', model: 'custom-model' }))
  assert.equal(input.value, '')
})

const verifiedState = (extra = {}) => ({ configured: true, connection: 'connected', verifiedAt: '2026-11-22T08:00:00Z', keySource: 'session', url: COURSE_PROVIDER_DEFAULTS.url, model: COURSE_PROVIDER_DEFAULTS.model, ...extra })

test('failed, pending, missing, or unconfigured save results never retain an input credential', async () => {
  for (const result of [{ configured: true, connection: 'failed' }, { configured: true, connection: 'unknown' }, { configured: true }, { configured: false, connection: 'connected' }, null]) {
    const input = { value: 'FAKE_UNVERIFIED_KEY' }
    await saveCourseProviderKey(input, async () => { assert.equal(input.value, ''); return result })
    assert.equal(input.value, '')
  }
})

test('a verified key survives SPA input reconstruction only for the matching public connection state', async () => {
  const state = verifiedState()
  const initial = { value: 'FAKE_SESSION_KEY' }
  await saveCourseProviderKey(initial, async () => state)
  const returnedInput = { value: '' }
  assert.equal(syncCourseProviderCredential(returnedInput, { ...state, activeRuns: 3, pricing: { status: 'loading' }, apiKey: 'NEVER_USE_PUBLIC_KEY' }), true)
  assert.equal(returnedInput.value, 'FAKE_SESSION_KEY')
  const edited = { value: 'MY_NEW_UNSAVED_FAKE_KEY' }
  assert.equal(syncCourseProviderCredential(edited, state, { edited: true }), true)
  assert.equal(edited.value, 'MY_NEW_UNSAVED_FAKE_KEY')
  const reloaded = await import('./course-provider.mjs?new-document-memory')
  const freshDocumentInput = { value: '' }
  assert.equal(reloaded.syncCourseProviderCredential(freshDocumentInput, state), false)
  assert.equal(freshDocumentInput.value, '', 'a fresh module does not recover a key from public state or persistent storage')
})

test('restart, replacement, model, endpoint, source, and invalid connection changes invalidate cached keys', async () => {
  const state = verifiedState()
  for (const changed of [verifiedState({ verifiedAt: '2026-11-22T09:00:00Z' }), verifiedState({ url: COURSE_PROVIDER_PRESETS[0].url }), verifiedState({ model: 'other-model' }), verifiedState({ keySource: 'environment' }), verifiedState({ configured: false }), verifiedState({ connection: 'unknown' }), verifiedState({ connection: 'failed' }), verifiedState({ locked: true }), verifiedState({ verifiedAt: null }), null]) {
    await saveCourseProviderKey({ value: 'FAKE_OLD_KEY' }, async () => state)
    const input = { value: 'FAKE_OLD_KEY' }
    assert.equal(syncCourseProviderCredential(input, changed), false)
    assert.equal(input.value, '')
    assert.equal(syncCourseProviderCredential({ value: '' }, state), false, 'invalidated keys cannot reappear from an older state')
  }
})

test('status refresh preserves active edits while invalidating any obsolete verified cache', async () => {
  const state = verifiedState()
  await saveCourseProviderKey({ value: 'FAKE_PREVIOUS_KEY' }, async () => state)
  const input = { value: 'FAKE_UNSAVED_EDIT' }
  assert.equal(syncCourseProviderCredential(input, verifiedState({ verifiedAt: '2026-11-22T10:00:00Z' }), { edited: true }), false)
  assert.equal(input.value, 'FAKE_UNSAVED_EDIT')
  assert.equal(syncCourseProviderCredential({ value: '' }, state), false)
})

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('inactive credential owners cannot clear, restore or submit over a newer verified document cache', async () => {
  const latest = verifiedState({ verifiedAt: '2026-11-22T12:00:00Z' })
  await saveCourseProviderKey({ value: 'FAKE_CURRENT_DOCUMENT_KEY' }, async () => latest)
  const detached = { value: 'DETACHED_UNSAVED_FAKE_KEY' }
  assert.equal(syncCourseProviderCredential(detached, null, { isActive: () => false }), false)
  assert.equal(detached.value, 'DETACHED_UNSAVED_FAKE_KEY')
  let requests = 0
  await assert.rejects(saveCourseProviderKey(detached, async () => { requests++; return verifiedState() }, undefined, { isActive: () => false }), { code: 'PROVIDER_VIEW_INACTIVE' })
  assert.equal(requests, 0)
  assert.equal(detached.value, 'DETACHED_UNSAVED_FAKE_KEY')
  const restored = { value: '' }
  assert.equal(syncCourseProviderCredential(restored, latest), true)
  assert.equal(restored.value, 'FAKE_CURRENT_DOCUMENT_KEY')
})

test('a superseded save cannot overwrite a later verified input or cache when responses finish out of order', async () => {
  for (const outcome of ['success', 'failure']) {
    const old = deferred(), input = { value: 'FAKE_OLD_ATTEMPT' }
    const oldSave = saveCourseProviderKey(input, () => old.promise)
    input.value = 'FAKE_LATEST_ATTEMPT'
    const latest = verifiedState({ verifiedAt: '2026-11-22T13:00:00Z' })
    await saveCourseProviderKey(input, async () => latest)
    if (outcome === 'success') { old.resolve(verifiedState()); await oldSave }
    else { old.reject(new Error('FAKE_TRANSPORT_FAILURE')); await assert.rejects(oldSave) }
    assert.equal(input.value, 'FAKE_LATEST_ATTEMPT')
    const restored = { value: '' }
    assert.equal(syncCourseProviderCredential(restored, latest), true)
    assert.equal(restored.value, 'FAKE_LATEST_ATTEMPT')
  }
})

test('a save authorized while open may finish after closure without restoring its detached input or retaining its credential', async () => {
  const pending = deferred(), input = { value: 'FAKE_CLOSED_OWNER_KEY' }
  let active = true
  const save = saveCourseProviderKey(input, () => pending.promise, undefined, { isActive: () => active })
  assert.equal(input.value, '')
  active = false
  const state = verifiedState({ verifiedAt: '2026-11-22T14:00:00Z' })
  pending.resolve(state)
  assert.deepEqual(await save, state, 'the completed authorized backend operation is still returned to its caller')
  assert.equal(input.value, '')
  assert.equal(syncCourseProviderCredential({ value: '' }, state), false)
})
