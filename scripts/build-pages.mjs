// 生成 GitHub Pages 只读回放版：欢迎页、教程，以及用封存 mock 数据渲染的研究室。
// 用法：node scripts/build-pages.mjs（输出到 pages-dist/，再把该目录发布到 gh-pages 分支）
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trimReplaySnapshot } from './pages-replay/trim.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'web')
const out = join(root, 'pages-dist')
const replaySource = join(root, 'scripts', 'pages-replay')
const OMIT = new Set(['legacy.html', 'app.js', 'records.css', 'actors.css'])
const BINARY = new Set(['.png', '.woff2', '.ico'])

const BANNER = `
<div class="pages-demo-note" role="note">
  <strong>模拟回放演示</strong>
  <span>· 数据来自封存的模拟运行，不代表真实模型结果；发起真实预测请<a href="https://codespaces.new/Bryce0312/LLMword">用 Codespaces</a> 或本地 <code>npm start</code>。</span>
</div>
<style>
  .pages-demo-note { position: fixed; left: 12px; bottom: 12px; z-index: 60; max-width: 52ch; display: grid; gap: 4px; padding: 10px 12px; border: 3px solid #efb85f; background: #251f2c; color: #f7e6ba; font-size: 12px; line-height: 1.5; box-shadow: 4px 4px 0 #120f15; }
  .pages-demo-note strong { font-size: 13px; color: #efb85f; }
  .pages-demo-note a { color: #efb85f; }
  .pages-demo-note code { font-family: var(--mono, monospace); }
  .wb-replay-board { margin: 0 0 18px; }
  .wb-replay-board .wb-board-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .wb-replay-board .wb-card-probability small { display: block; font-size: 11px; opacity: .8; }
  .wb-replay-readonly strong { color: #efb85f; }
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

const snapshot = trimReplaySnapshot(JSON.parse(await readFile(join(replaySource, 'snapshot.json'), 'utf8')))
await mkdir(join(out, 'replay'), { recursive: true })
await writeFile(join(out, 'replay', 'snapshot.json'), JSON.stringify(snapshot))
await writeFile(join(out, 'replay', 'replay-data.js'), 'window.__LLMWORD_REPLAY__ = ' + JSON.stringify(snapshot) + ';\n')
await writeFile(join(out, 'replay', 'replay-shim.js'), await readFile(join(replaySource, 'replay-shim.js'), 'utf8'))

const indexPath = join(out, 'index.html')
const index = await readFile(indexPath, 'utf8')
const moduleTag = '<script type="module" src="workbench.js"></script>'
if (!index.includes(moduleTag)) throw new Error('index.html 缺少 workbench.js 模块入口，无法注入回放脚本。')

// 首帧：同步改写空 hash，并在 <body> 上预置公开页标记，避免先把研究室画出来再跳转。
const bootHead = '<script>(function(){var h=location.hash;if(!h||h==="#"||h==="#/"){try{history.replaceState(null,"","#/welcome")}catch(e){location.replace("#/welcome")}}})();<\/script>'
const bootBody = '<script>(function(){var h=location.hash;if(h&&h!=="#"&&h!=="#/"&&h.indexOf("#/welcome")!==0&&h.indexOf("#/guide")!==0)document.body.removeAttribute("data-public-page")})();<\/script>'

let html = index.replace('<head>', '<head>\n  ' + bootHead)
html = html.replace('<body class="wb-body"', '<body data-public-page="true" class="wb-body"')
html = html.replace(/(<body\b[^>]*>)/, '$1\n  ' + bootBody)
html = html.replace(moduleTag, '<script src="replay/replay-data.js"></script>\n  <script src="replay/replay-shim.js"></script>\n  ' + moduleTag)
await writeFile(indexPath, html)
await writeFile(join(out, '.nojekyll'), '')
console.log('pages-dist ready: ' + out)
