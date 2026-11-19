import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseProviderPresentation, courseProviderError, saveCourseProviderKey } from './course-provider.mjs'

test('connection state never exposes a credential or claims configured means verified', () => {
  const view = courseProviderPresentation({ provider: 'deepseek', configured: true, keySource: 'session', canUpdate: true, activeRuns: 0, activeWatchers: 0, apiKey: 'DO_NOT_DISPLAY_KEY', balance: 'DO_NOT_DISPLAY_BALANCE' })
  assert.equal(view.canUpdate, true)
  assert.equal(view.label, '服务器已配置 API Key')
  assert(view.verificationHint.includes('不代表'))
  assert(!JSON.stringify(view).includes('DO_NOT_DISPLAY'))
  assert.equal(courseProviderPresentation({ canUpdate: true, activeRuns: 1 }).canUpdate, false)
  const watched = courseProviderPresentation({ canUpdate: true, activeRuns: 0, activeWatchers: 2 })
  assert.equal(watched.canUpdate, false)
  assert(watched.actionHint.includes('2 个持续监听'))
  assert(watched.taskState.includes('持续监听：2'))
  assert.equal(courseProviderPresentation({ canUpdate: true, activeRuns: 0 }).canUpdate, false)
  assert.equal(courseProviderPresentation({ canUpdate: true }).canUpdate, false)
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
