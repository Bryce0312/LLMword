import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseProviderPresentation, courseProviderError, saveCourseProviderKey } from './course-provider.mjs'

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

test('save clears the password field before the request and on success or failure', async () => {
  const input = { value: '  TEST_NOT_A_REAL_KEY  ' }
  const result = await saveCourseProviderKey(input, async body => {
    assert.equal(input.value, '')
    assert.deepEqual(body, { apiKey: 'TEST_NOT_A_REAL_KEY' })
    return { configured: true }
  })
  assert.equal(result.configured, true)
  assert.equal(input.value, '')
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
