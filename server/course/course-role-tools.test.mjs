import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoleToolset } from './course-role-tools.mjs'

const candidate = () => ({ probabilityYes: .5, summary: 'A limited estimate', evidenceIds: ['e1'], evidenceAdequacy: 'limited',
  dissent: [], outcomeKnown: false, outcome: null })

test('role tool diagnostics identify required, enum and length constraints without rejected values', () => {
  const tools = createRoleToolset(['market', 'verification'])
  const missing = candidate(); delete missing.outcome
  assert.equal(tools.validate('propose_forecast', missing), false)
  const required = tools.validationErrors('propose_forecast').find(error => error.keyword === 'required')
  assert.equal(required.instancePath, '')
  assert.equal(required.schemaPath, '#/required')
  assert.deepEqual(required.params, { missingProperty: 'outcome' })
  assert.equal(tools.validate('propose_forecast', { ...candidate(), evidenceAdequacy: 'PRIVATE_REJECTED_VALUE', summary: 'SECRET'.repeat(400) }), false)
  const errors = tools.validationErrors('propose_forecast')
  assert.deepEqual(errors.find(error => error.keyword === 'enum'), { instancePath: '/evidenceAdequacy', schemaPath: '#/properties/evidenceAdequacy/enum',
    keyword: 'enum', message: 'must be equal to one of the allowed values', params: { allowedValues: ['adequate', 'limited'] } })
  assert.deepEqual(errors.find(error => error.keyword === 'maxLength').params, { limit: 2000 })
  assert.equal(errors.find(error => error.keyword === 'maxLength').instancePath, '/summary')
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_REJECTED_VALUE|SECRET/)
})

test('nested diagnostics use the active role enum and safe structural paths', () => {
  const tools = createRoleToolset(['market', 'verification'])
  const assignment = { roleId: 'SECRET_WRONG_ROLE', objective: 'Research', reason: 'Investigate sources' }
  assert.equal(tools.validate('draft_and_delegate', { question: 'Question', object: 'Object', interpretation: 'Interpretation',
    assignments: [assignment, { ...assignment, roleId: 'market' }, { ...assignment, roleId: 'verification' }] }), false)
  const error = tools.validationErrors('draft_and_delegate').find(error => error.keyword === 'enum')
  assert.equal(error.instancePath, '/assignments/0/roleId')
  assert.deepEqual(error.params.allowedValues, ['market', 'verification'])
  assert.doesNotMatch(JSON.stringify(error), /SECRET_WRONG_ROLE/)
})

test('unknown property names, values and unknown tool names never appear in public errors', () => {
  const tools = createRoleToolset(['market', 'verification'])
  const name = 'sk-PRIVATE_UNKNOWN_PROPERTY'
  assert.equal(tools.validate('propose_forecast', { ...candidate(), [name]: 'PRIVATE_UNKNOWN_VALUE' }), false)
  const errors = tools.validationErrors('propose_forecast')
  assert.equal(errors[0].keyword, 'additionalProperties')
  assert.deepEqual(errors[0].params, {})
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE|sk-/)
  assert.equal(tools.validate('PRIVATE_TOOL_NAME', {}), false)
  assert.doesNotMatch(JSON.stringify(tools.validationErrors('PRIVATE_TOOL_NAME')), /PRIVATE_TOOL_NAME/)
  assert.equal(tools.validate('toString', {}), false)
})

test('diagnostics are isolated per tool, defensive copies, and cleared after successful validation', () => {
  const tools = createRoleToolset(['market', 'verification'])
  assert.deepEqual(tools.validationErrors('propose_forecast'), [])
  tools.validate('propose_forecast', {})
  const errors = tools.validationErrors('propose_forecast')
  errors[0].params.missingProperty = 'MUTATED'; errors.pop()
  assert.notEqual(tools.validationErrors('propose_forecast')[0].params.missingProperty, 'MUTATED')
  tools.validate('mark_insufficient', {})
  assert.equal(tools.validationErrors('propose_forecast').length, 7)
  assert.equal(tools.validate('propose_forecast', candidate()), true)
  assert.deepEqual(tools.validationErrors('propose_forecast'), [])
  assert.equal(tools.validationErrors('mark_insufficient').length, 2)
})
