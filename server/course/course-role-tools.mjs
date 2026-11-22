import Ajv from 'ajv'
import { COURSE_ROLE_IDS } from './course-context.mjs'
import { nativeTool, validators } from './course-contracts.mjs'

// The global contracts remain the legacy baseline. Each run receives its own
// schemas and validators so deleted roles cannot leak back through tool enums.
export function createRoleToolset(roleIds) {
  const tools = new Map(), checks = new Map()
  const ajv = new Ajv({ allErrors: true, strict: true })
  const replaceRoles = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.enum) && value.enum.length === COURSE_ROLE_IDS.length && COURSE_ROLE_IDS.every(id => value.enum.includes(id))) value.enum = [...roleIds]
    for (const child of Object.values(value)) replaceRoles(child)
  }
  return {
    native(name) {
      if (!tools.has(name)) {
        const tool = structuredClone(nativeTool(name))
        replaceRoles(tool.function.parameters)
        tool.function.description = tool.function.description.replace('十角色目录', '本轮可用角色目录')
        tools.set(name, tool)
      }
      return structuredClone(tools.get(name))
    },
    validate(name, value) {
      if (!validators[name]) return false
      if (!checks.has(name)) checks.set(name, ajv.compile(this.native(name).function.parameters))
      return checks.get(name)(value)
    },
  }
}
