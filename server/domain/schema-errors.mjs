const messages = Object.freeze({ required: 'must have required property', enum: 'must be equal to one of the allowed values',
  maxLength: 'must NOT exceed the schema string length', minLength: 'must meet the schema string length',
  maxItems: 'must NOT exceed the schema item count', minItems: 'must meet the schema item count',
  minimum: 'must meet the schema minimum', maximum: 'must NOT exceed the schema maximum',
  type: 'must have the schema type', additionalProperties: 'must NOT have additional properties', uniqueItems: 'must NOT have duplicate items' })
const pointerParts = pointer => pointer.replace(/^#/, '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
const pointerPart = part => part.replace(/~/g, '~0').replace(/\//g, '~1')
function schemaValue(schema, path) {
  let value = schema
  for (const part of pointerParts(path)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = value[part]
  }
  return value
}
function safeInstancePath(schema, path) {
  let current = schema; const safe = []
  for (const part of pointerParts(path)) {
    if (current?.type === 'array' && /^(?:0|[1-9]\d*)$/.test(part)) current = current.items
    else if (current?.properties && Object.hasOwn(current.properties, part)) current = current.properties[part]
    else return '' // Never echo an unexpected, possibly sensitive property name.
    safe.push(pointerPart(part))
  }
  return safe.length ? '/' + safe.join('/') : ''
}

/** Only static schema constraints and structural positions, never rejected values. */
export function publicValidationErrors(errors, schema) {
  return (errors || []).slice(0, 12).map(error => {
    const keyword = Object.hasOwn(messages, error.keyword) ? error.keyword : 'schema'
    const constraint = schemaValue(schema, error.schemaPath)
    let params = {}
    if (keyword === 'required' && Array.isArray(constraint) && constraint.includes(error.params?.missingProperty)) params = { missingProperty: error.params.missingProperty }
    else if (keyword === 'enum' && Array.isArray(constraint)) params = { allowedValues: structuredClone(constraint) }
    else if (keyword === 'type' && (typeof constraint === 'string' || Array.isArray(constraint))) params = { type: structuredClone(constraint) }
    else if (['maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum'].includes(keyword) && Number.isFinite(constraint)) params = { limit: constraint }
    else if (keyword === 'uniqueItems') params = Object.fromEntries(['i', 'j'].filter(key => Number.isSafeInteger(error.params?.[key])).map(key => [key, error.params[key]]))
    return { instancePath: safeInstancePath(schema, error.instancePath || ''), schemaPath: constraint === undefined ? '#' : error.schemaPath,
      keyword, message: messages[keyword] || 'must satisfy the tool schema', params }
  })
}
