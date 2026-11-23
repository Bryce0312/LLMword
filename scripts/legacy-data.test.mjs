import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyData, targetFor } from './legacy-data.mjs'

test('legacy data with one mode moves into that environment; mixed or unknown stays neutral', () => {
  assert.equal(targetFor(['mock']), join('mock', 'legacy'))
  assert.equal(targetFor(['live']), join('live', 'legacy'))
  assert.equal(targetFor(['mock', 'live']), 'legacy')
  assert.equal(targetFor([]), 'legacy')
})

test('dry-run lists files without moving them and apply moves the whole archive', t => {
  const root = mkdtempSync(join(tmpdir(), 'llmword-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['world.json', 'world.json.course.sqlite', 'world.json.course.sqlite-wal', 'world.json.monitor-public.json']) writeFileSync(join(root, name), '{}')
  const preview = migrateLegacyData({ root })
  assert.equal(preview.files.length, 4)
  assert.equal(existsSync(join(root, 'world.json')), true, 'dry-run must not move anything')
  migrateLegacyData({ root, apply: true })
  assert.equal(existsSync(join(root, 'world.json')), false)
  assert.equal(existsSync(join(root, 'legacy', 'world.json')), true)
  assert.equal(existsSync(join(root, 'legacy', 'world.json.course.sqlite-wal')), true)
})
