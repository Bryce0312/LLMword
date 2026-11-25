// 生成 GitHub Pages 静态展示版：只包含欢迎页与教程，两者都不依赖后端接口。
// 用法：node scripts/build-pages.mjs（输出到 pages-dist/，再把该目录发布到 gh-pages 分支）
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'web')
const out = join(root, 'pages-dist')
const OMIT = new Set(['legacy.html', 'app.js', 'records.css', 'actors.css'])
const BINARY = new Set(['.png', '.woff2', '.ico'])

const BANNER = `
<div class="pages-demo-note" role="note">
  <strong>静态展示页</strong>
  <span>只有欢迎页与教程能离线浏览。要做真实预测，请 <a href="https://codespaces.new/Bryce0312/LLMword">在 Codespaces 打开</a>，或在本地运行 <code>npm start</code>。</span>
</div>
<style>
  .pages-demo-note { position: fixed; left: 12px; bottom: 12px; z-index: 60; max-width: 52ch; display: grid; gap: 4px; padding: 10px 12px; border: 3px solid #efb85f; background: #251f2c; color: #f7e6ba; font-size: 12px; line-height: 1.5; box-shadow: 4px 4px 0 #120f15; }
  .pages-demo-note strong { font-size: 13px; color: #efb85f; }
  .pages-demo-note a { color: #efb85f; }
  .pages-demo-note code { font-family: var(--mono, monospace); }
</style>`

function rewrite(name, text) {
  const extension = extname(name)
  let next = text
  if (extension === '.css') next = next.replace(/url\((['"]?)\/assets\//g, 'url($1assets/')
  else next = next.replace(/(['"`])\/assets\//g, '$1assets/').replace(/(['"`])\/demo\//g, '$1demo/')
  // GitHub Pages 对 .mjs 的 MIME 不稳定，统一改名成 .js 并同步导入路径。
  next = next.replace(/\.mjs(['"`])/g, '.js$1')
  if (extension === '.html') {
    next = next.replace(/(href|src)="\//g, '$1="')
    if (name === 'index.html') next = next.replace('</body>', BANNER + '\n</body>')
  }
  return next
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { await walk(join(dir, entry.name)); continue }
    if (entry.name.endsWith('.test.mjs') || OMIT.has(entry.name)) continue
    const from = join(dir, entry.name)
    const target = entry.name.replace(/\.mjs$/, '.js')
    const to = join(out, from.slice(source.length + 1, -entry.name.length), target)
    await mkdir(join(to, '..'), { recursive: true })
    if (BINARY.has(extname(entry.name))) await writeFile(to, await readFile(from))
    else await writeFile(to, rewrite(entry.name, await readFile(from, 'utf8')))
  }
}

await rm(out, { recursive: true, force: true })
await walk(source)
await writeFile(join(out, '.nojekyll'), '')
console.log('pages-dist ready: ' + out)
