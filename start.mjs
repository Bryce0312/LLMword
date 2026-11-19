import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './server/world.mjs';
import { handleApi } from './server/http.mjs';
import { createEvents } from './server/events.mjs';
import { createMonitor } from './server/monitor.mjs';
import { createProvider, paceMock } from './server/provider.mjs';
import { createProviderConnection, handleProviderConnection } from './server/provider-connection.mjs';

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
let sqliteAvailable = false;
try { sqliteAvailable = Boolean(process.getBuiltinModule?.('node:sqlite')?.DatabaseSync); } catch {}
const workbenchMode = process.env.WORLD_WORKBENCH ?? (sqliteAvailable ? 'on' : 'off');
if (!['on', 'off'].includes(workbenchMode)) throw new Error('WORLD_WORKBENCH must be on or off');
if (process.env.WORLD_RUNTIME && !['probe', 'off'].includes(process.env.WORLD_RUNTIME)) throw new Error('WORLD_RUNTIME must be probe or off');
const useRuntime = process.env.WORLD_RUNTIME === 'probe' || (workbenchMode === 'on' && process.env.WORLD_RUNTIME !== 'off');
if ((useRuntime || workbenchMode === 'on') && !sqliteAvailable) throw new Error('新版工作台需要可加载 node:sqlite 的 Node.js，本机已验证 v23.5.0。');
let runtime;
let workbench;
let runtimeProvider;
let course;
let providerConnection;
if (useRuntime) {
  const { createResearchService } = await import('./server/runtime/research-service.mjs');
  runtimeProvider = process.env.WORLD_MODEL === 'openai'
    ? (await import('./server/runtime/model-provider.mjs')).createModelProvider()
    : (await import('./server/runtime/probe-provider.mjs')).createProbeProvider({ pacingMs: Math.round(mockSpeed * 700) });
  runtime = createResearchService({ path: process.env.WORLD_RUNTIME_PATH || `${statePath}.runtime.sqlite`,
    provider: runtimeProvider, modelMode: process.env.WORLD_MODEL === 'openai' ? 'live' : 'mock' });
}
if (workbenchMode === 'on') {
  const { createWorkbenchService } = await import('./server/domain/workbench-service.mjs');
  workbench = createWorkbenchService({ path: process.env.WORLD_DOMAIN_PATH || `${statePath}.domain.sqlite`, runtime, world });
}
const courseMode = process.env.WORLD_COURSE ?? (workbench ? 'on' : 'off');
if (!['on', 'off'].includes(courseMode)) throw new Error('WORLD_COURSE must be on or off');
if (courseMode === 'on') {
  if (!workbench) throw new Error('自动研究需要启用支持 SQLite 的工作台。');
  const { createCourseService, createCourseMockProvider } = await import('./server/course/course-service.mjs');
  const { createWebResearchGateway } = await import('./server/course/web-tools.mjs');
  const live = process.env.WORLD_MODEL === 'openai';
  const courseProvider = live
    ? runtimeProvider || (await import('./server/runtime/model-provider.mjs')).createModelProvider()
    : createCourseMockProvider({ pacingMs: Math.round(mockSpeed * 550) });
  const sourceTools = createWebResearchGateway({ env: { ...process.env,
    WORLD_SEARCH_PROVIDER: process.env.WORLD_SEARCH_PROVIDER || (live ? 'deepseek' : 'fixture') } });
  const watchIntervalMs = Number(process.env.WORLD_COURSE_POLL_MS || 3600000);
  if (!Number.isInteger(watchIntervalMs) || watchIntervalMs < 1000 || watchIntervalMs > 86400000) throw new Error('自动检查间隔必须在1秒至1天之间。');
  course = createCourseService({ path: process.env.WORLD_COURSE_PATH || `${statePath}.course.sqlite`, workbench,
    provider: courseProvider, modelMode: live ? 'live' : 'mock', sourceTools, watchIntervalMs });
  providerConnection = createProviderConnection({ configured: Boolean(process.env.WORLD_API_KEY),
    getActiveCount: () => course.listRuns().filter(run => !['completed', 'insufficient', 'failed', 'cancelled'].includes(run.status)).length,
    getActiveWatchCount: () => course.listRequests().filter(item => course.getRequest(item.requestId).watch?.status === 'active' && item.watch !== false).length,
    getMode: () => course.capabilities.modelMode,
    async applyKey(apiKey) {
      // Credentials stay in the new provider/gateway closures, never .env,
      // checkpoints, process logs, public configuration or the browser cache.
      const nextEnv = { ...process.env, WORLD_MODEL: 'openai', WORLD_API_KEY: apiKey, WORLD_SEARCH_API_KEY: apiKey,
        WORLD_BASE_URL: 'https://api.deepseek.com', WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_SEARCH_PROVIDER: 'deepseek',
        WORLD_MODEL_NAME: /^deepseek[-/]/i.test(process.env.WORLD_MODEL_NAME || '') ? process.env.WORLD_MODEL_NAME : 'deepseek-v4-pro',
        WORLD_MODEL_THINKING: process.env.WORLD_MODEL_THINKING || 'enabled',
        WORLD_MODEL_MAX_OUTPUT_TOKENS: process.env.WORLD_MODEL_MAX_OUTPUT_TOKENS || '32768',
        WORLD_MODEL_TIMEOUT_MS: process.env.WORLD_MODEL_TIMEOUT_MS || '180000' }
      const nextProvider = (await import('./server/runtime/model-provider.mjs')).createModelProvider(nextEnv)
      const nextSources = createWebResearchGateway({ env: nextEnv })
      if (course.listRuns().some(run => !['completed', 'insufficient', 'failed', 'cancelled'].includes(run.status)) ||
        course.listRequests().some(item => course.getRequest(item.requestId).watch?.status === 'active' && item.watch !== false)) throw new Error('Connection update requires idle research and watchers')
      const replacement = createCourseService({ path: process.env.WORLD_COURSE_PATH || `${statePath}.course.sqlite`, workbench,
        provider: nextProvider, modelMode: 'live', sourceTools: nextSources, watchIntervalMs })
      try { await course.close() } catch (error) { await replacement.close(); throw error }
      course = replacement
      course.resume()
    },
  })
}

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
    if (await handleProviderConnection(providerConnection, request, response)) return;
    if (providerConnection?.changing && url.pathname.startsWith('/api/v1/course/')) {
      response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: { code: 'PROVIDER_UPDATE_BUSY', message: '正在保存模型连接，请稍后继续。' } }));
      return;
    }
    const requestCourse = course && new Proxy(course, { get(target, name) {
      const value = target[name]
      if (!['createRequest', 'check', 'stop'].includes(name)) return value
      return (...args) => {
        if (providerConnection?.changing) throw Object.assign(new Error('正在保存模型连接，请稍后继续。'), { code: 'PROVIDER_UPDATE_BUSY', status: 409 })
        return value(...args)
      }
    } })
    await handleApi({ world, events, monitor, mode: provider.mode, runtime, workbench, course: requestCourse }, request, response);
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
  const filename = resolve(root, path === '/' ? (workbench ? 'index.html' : 'legacy.html') : `.${path}`);
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
  runtime?.resume();
  course?.resume();
  console.log(`世界事务所  http://127.0.0.1:${server.address().port}`);
});
server.on('close', () => {
  monitor.stop();
  void Promise.allSettled([runtime?.close(), course?.close()]).then(() => workbench?.close());
});
