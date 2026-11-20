import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dataRoot = fileURLToPath(new URL('../.data/', import.meta.url))

/** Read only the stored run modes; unknown or unreadable databases return an empty list. */
export function modesFromCourseDb(path) {
  if (!existsSync(path)) return []
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return db.prepare('SELECT record_json FROM course_runs').all()
      .map(row => { try { return JSON.parse(row.record_json).modelMode } catch { return null } })
      .filter(mode => mode === 'mock' || mode === 'live')
  } catch {
    return []
  } finally {
    db?.close()
  }
}

/** A single known mode goes to that environment; mixed or unknown data stays in a neutral folder. */
export function targetFor(modes = []) {
  const unique = new Set(modes)
  if (unique.size === 1 && unique.has('mock')) return join('mock', 'legacy')
  if (unique.size === 1 && unique.has('live')) return join('live', 'legacy')
  return 'legacy'
}

export function planLegacyMigration(root = dataRoot) {
  const files = readdirSync(root)
    .filter(name => name === 'world.json' || name.startsWith('world.json.'))
    .map(name => join(root, name))
    .filter(path => statSync(path).isFile())
  if (!files.length) return { target: null, files: [], destination: null }
  const course = files.find(path => basename(path) === 'world.json.course.sqlite')
  const target = targetFor(course ? modesFromCourseDb(course) : [])
  return { target, files, destination: join(root, target) }
}

export function migrateLegacyData({ root = dataRoot, apply = false } = {}) {
  const plan = planLegacyMigration(root)
  if (!plan.files.length) {
    console.log('没有发现根目录旧归档。')
    return plan
  }
  console.log(`目标：${plan.destination}`)
  for (const file of plan.files) console.log(`${apply ? '移动' : '将移动'} ${basename(file)}`)
  if (!apply) {
    console.log('当前为 dry-run；确认服务已停止后加 --apply 执行。')
    return plan
  }
  for (const file of plan.files) {
    const destination = join(plan.destination, basename(file))
    if (existsSync(destination)) throw new Error(`目标已存在，停止迁移：${destination}`)
  }
  mkdirSync(plan.destination, { recursive: true })
  for (const file of plan.files) renameSync(file, join(plan.destination, basename(file)))
  console.log(`已移动 ${plan.files.length} 个文件。`)
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateLegacyData({ apply: process.argv.includes('--apply') })
}
