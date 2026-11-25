import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] || 'pages-dist')
const port = Number(process.argv[3] || 8899)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' }

createServer(async (request, response) => {
  let pathname
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) } catch { response.writeHead(400).end(); return }
  if (!pathname.startsWith('/LLMword/')) { response.writeHead(404).end('not found'); return }
  const relative = pathname.slice('/LLMword/'.length) || 'index.html'
  const file = resolve(join(root, relative))
  if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
  } catch { response.writeHead(404).end('not found') }
}).listen(port, '127.0.0.1', () => console.log(`pages at http://127.0.0.1:${port}/LLMword/`))
