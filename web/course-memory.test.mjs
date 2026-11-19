import { test } from 'node:test'
import assert from 'node:assert/strict'
import { courseMemoryPolicyLines } from './course-memory.mjs'

test('memory policy text follows saved numbers and explicit refresh/retention flags', () => {
  const lines = courseMemoryPolicyLines({ policy: { shortTermDays: 3, maxJudgments: 2, maxReports: 4, longTermDays: 45, maxRelations: 5, maxEvidence: 9, retrievalIsNotDeletion: true, historicalEvidenceRequiresRefresh: true } })
  assert(lines[0].includes('3 天，最多 2 次'))
  assert(lines[1].includes('45 天，最多 5 条关系与 9 条'))
  assert(lines[2].includes('不会因此自动删除'))
  assert(lines[3].includes('重新读取'))
})

test('old memory snapshots do not acquire an invented new policy or default limits', () => {
  assert.deepEqual(courseMemoryPolicyLines({ reportCount: 3, relationCount: 8 }), [])
  assert.deepEqual(courseMemoryPolicyLines(null), [])
  assert.deepEqual(courseMemoryPolicyLines({ policy: {} }), [])
  assert.deepEqual(courseMemoryPolicyLines({ policy: { shortTermDays: -7, maxJudgments: 4, longTermDays: '90' } }), [])
})
