import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './server/world.mjs';
import { handleApi } from './server/http.mjs';
import { createEvents } from './server/events.mjs';
import { createMonitor } from './server/monitor.mjs';
import { createProvider, paceMock } from './server/provider.mjs';

const root = fileURLToPath(new URL('./web/', import.meta.url));
const defaultStateFile = process.env.WORLD_MODEL === 'openai' ? 'world-live.json' : 'world.json';
const statePath = process.env.WORLD_STATE_PATH || fileURLToPath(new URL(`./.data/${defaultStateFile}`, import.meta.url));
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');

const mediaTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);
const mockSpeed = Number(process.env.WORLD_MOCK_PACING ?? 1);
if (!Number.isFinite(mockSpeed) || mockSpeed < 0 || mockSpeed > 2) throw new Error('WORLD_MOCK_PACING must be between 0 and 2');
const provider = paceMock(createProvider(), mockSpeed);
const world = createWorld({ statePath, provider });
const events = createEvents();
const mode = process.env.WORLD_MONITOR || 'public';
if (!['public', 'demo', 'off'].includes(mode)) throw new Error('WORLD_MONITOR must be public, demo, or off');
const intervalMs = Number(process.env.WORLD_POLL_MS ?? (mode === 'demo' ? 4000 : 300000));
if (!Number.isInteger(intervalMs) || intervalMs < (mode === 'public' ? 60000 : 1000) || intervalMs > 86400000) {
  throw new Error('WORLD_POLL_MS is outside the allowed range for the selected monitor');
}
const monitor = createMonitor({
  mode, path: process.env.WORLD_MONITOR_PATH || `${statePath}.monitor-${mode}.json`,
  intervalMs, events, provider, mockPacing: mockSpeed,
});

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) || (origin && origin !== `http://${host}`)) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: '请从本机研究室页面调用 API。' }));
      return;
    }
    await handleApi({ world, events, monitor, mode: provider.mode }, request, response);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('Invalid URL');
    return;
  }
  const filename = resolve(root, path === '/' ? 'index.html' : `.${path}`);
  if (!filename.startsWith(`${resolve(root)}${sep}`)) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const file = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': mediaTypes.get(extname(filename)) ?? 'application/octet-stream',
      'Content-Length': file.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }).end(request.method === 'HEAD' ? undefined : file);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) {
      response.writeHead(404).end('Not found');
      return;
    }
    throw error;
  }
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error.message);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '服务暂时无法响应' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  monitor.start();
  console.log(`世界事务所  http://127.0.0.1:${server.address().port}`);
});
server.on('close', () => monitor.stop());
