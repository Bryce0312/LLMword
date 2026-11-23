import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const cwd = fileURLToPath(new URL('../', import.meta.url))
const offline = process.argv.includes('--offline')
async function testFiles(directory) {
  const files = []
  for (const item of await readdir(new URL('../' + directory + '/', import.meta.url), { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...await testFiles(directory + '/' + item.name))
    else if (item.name.endsWith('.test.mjs')) files.push(directory + '/' + item.name)
  }
  return files
}
const selected = offline ? (await Promise.all(['server', 'scripts', 'web'].map(testFiles))).flat().sort() : []
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...selected], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = '', errors = ''
child.stdout.on('data', (data) => { output += data })
child.stderr.on('data', (data) => { errors += data })
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
const read = (key) => Number(output.match(new RegExp('^# ' + key + ' ([0-9.]+)$', 'm'))?.[1] ?? NaN)
const result = { finishedAt: new Date().toISOString(), nodeVersion: process.version, command: 'node --test --test-reporter=tap',
  scope: offline ? 'server/scripts/web: no root HTTP suites' : 'full',
  exitCode: code, tests: read('tests'), passed: read('pass'), failed: read('fail'), skipped: read('skipped'), cancelled: read('cancelled'), durationMs: read('duration_ms') }
if (!Number.isFinite(result.tests) || result.tests === 0 || result.passed !== result.tests || result.failed !== 0 || result.skipped !== 0 || result.cancelled !== 0) result.exitCode ||= 1
await mkdir(new URL('../docs/evidence/', import.meta.url), { recursive: true })
await writeFile(new URL('../docs/evidence/' + (offline ? 'collaboration-offline-regression-summary.json' : 'collaboration-regression-summary.json'), import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
if (result.exitCode) { console.error(output.split('\n').filter((line) => /not ok|error:|failureType:/.test(line)).join('\n')); if (errors) console.error(errors.slice(-2000)) }
process.exitCode = result.exitCode
