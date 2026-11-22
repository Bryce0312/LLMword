import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPageExcerpt } from './page-excerpt.mjs'

const assertRealHints = (value, expectedCount = 3) => {
  assert.equal(value.citationHints.length, expectedCount)
  assert.equal(new Set(value.citationHints).size, value.citationHints.length)
  for (const hint of value.citationHints) {
    assert(Array.from(hint).length >= 8 && Array.from(hint).length <= 240)
    assert(value.text.includes(hint), 'Hints must be contiguous fragments of the saved source, not rewritten quotes')
  }
}

test('repeated sale ads and interface lines cannot displace stock rows and real source sentences', () => {
  const source = ['🎁 Black Friday: 50% off Unlimited and 30% off Pro annual plans',
    '🎁 Black Friday: 50% off Unlimited and 30% off Pro annual plans', 'Skip to main content', 'Sign in',
    'Subscribe now for $1', 'Privacy Preference Center', 'Manage Consent Preferences', 'We use cookies to improve this site.',
    'NVIDIA Corporation (NVDA)', 'NASDAQ: NVDA · Real-Time Price · USD',
    'Date | Open | High | Low | Close | Volume', '---|---|---|---|---|---',
    'Nov 20, 2026 | 143.52 | 143.73 | 124.50 | 125.53 | 633,336,951',
    'Nov 19, 2026 | 152.92 | 158.13 | 145.71 | 145.98 | 322,940,099',
    'NVIDIA reported quarterly revenue of USD 115 billion.',
    'NVIDIA reported quarterly revenue of USD 115 billion.'].join('\n\n')
  const value = selectPageExcerpt(source, 'Nov 20, 2026')
  assert.equal(value.text, source.slice(value.excerptStart))
  assert.equal(value.focusMatched, true)
  assertRealHints(value)
  assert.match(value.citationHints[0], /^Nov 20, 2026/)
  assert(value.citationHints.some(hint => hint.includes('Nov 19, 2026')))
  assert(value.citationHints.some(hint => hint.includes('quarterly revenue')))
  assert.doesNotMatch(value.citationHints.join('\n'), /Black Friday|Sign in|Subscribe|cookies|Privacy Preference|Manage Consent/)
  const complete = selectPageExcerpt(source)
  assert.equal(complete.text, source); assertRealHints(complete)
  assert.doesNotMatch(complete.citationHints.join('\n'), /Black Friday|Sign in|Subscribe|cookies|Privacy Preference|Manage Consent/)
})

test('a real focused key sentence outranks unrelated older numerical material', () => {
  const source = ['Archive revenue was USD 100 million in 2021.', 'Archive revenue was USD 110 million in 2022.',
    'A public notice states the board will review the supplier agreement.', 'The new policy remains subject to regulatory approval.',
    'The company has not confirmed the proposed acquisition.'].join('\n')
  const value = selectPageExcerpt(source, 'supplier agreement')
  assertRealHints(value)
  assert.equal(value.citationHints[0], 'A public notice states the board will review the supplier agreement.')
  assert.equal(value.text, source)
})

test('missing focus remains honest while useful fallback hints exclude advertising', () => {
  const source = ['🎁 Black Friday: 50% off annual plans', 'Revenue reached USD 120 million.',
    'Operating profit reached USD 20 million.', 'Management said the forecast remains uncertain.'].join('\n')
  const value = selectPageExcerpt(source, 'Revenue 9999')
  assert.equal(value.focusMatched, false); assert.equal(value.focusMatch, 'not-found')
  assert.equal(value.excerptStrategy, 'keyword-fallback')
  assertRealHints(value)
  assert.doesNotMatch(value.citationHints.join('\n'), /9999|Black Friday/)
  assert.equal(value.text, source)
})

test('real sentences on one line supply distinct hints without rewriting dates, decimals or punctuation', () => {
  const source = 'The closing price was USD 125.53 on Nov 20, 2026. The board has not confirmed the reported management change. Analysts described the near-term outlook as uncertain.'
  const value = selectPageExcerpt(source)
  assertRealHints(value)
  assert(value.citationHints.some(hint => hint.includes('USD 125.53 on Nov 20, 2026.')))
  assert.equal(value.text, source)
})

test('hint filtering never alters the saved text or manufactures extra useful sentences', () => {
  const source = '立即订阅\n登录\n隐私偏好设置\n公司表示最新计划仍需等待监管机构批准。\n公司表示最新计划仍需等待监管机构批准。'
  const value = selectPageExcerpt(source)
  assertRealHints(value, 1)
  assert.equal(value.citationHints[0], '公司表示最新计划仍需等待监管机构批准。')
  assert.equal(value.text, source)
  const long = selectPageExcerpt('🎁 Black Friday: 50% off annual plans\n' + '真实原文内容'.repeat(1000), undefined, 4000)
  assert.equal(long.text, Array.from('🎁 Black Friday: 50% off annual plans\n' + '真实原文内容'.repeat(1000)).slice(0, 4000).join(''))
  assert.equal(Array.from(long.text).length, 4000)
})
