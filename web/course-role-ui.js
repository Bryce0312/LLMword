import { uiContent, dataContent } from './workbench-core.js'
import { COURSE_ROLE_LABELS, courseRoleName, normalizeCourseRole } from './course-team.mjs'

/** Only a known role ID paired with its original factory label is system UI. */
export function courseRoleNameContent(roleId, name, tag = 'span', cls = '') {
  const role = normalizeCourseRole(roleId)
  const text = courseRoleName(role, name)
  const canonical = role && COURSE_ROLE_LABELS[role]
  return (canonical && text === canonical ? uiContent : dataContent)(tag, cls, text)
}
