import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';
import { handleApi } from './http.mjs';
import { createEvents } from './events.mjs';
import { createMonitor } from './monitor.mjs';
import { createProvider, paceMock } from './provider.mjs';
import { createProviderConnection, handleProviderConnection } from './provider-connection.mjs';
import { assertEnvironmentRuns } from './environment.mjs';

const environment = process.env.WORLD_ENV || 'auto';
if (!['auto', 'mock', 'live'].includes(environment)) throw new Error('WORLD_ENV must be auto, mock, or live');
if (environment === 'mock') process.env.WORLD_SEARCH_PROVIDER = 'fixture';
if (environment === 'live') process.env.WORLD_SEARCH_PROVIDER = 'deepseek';
const live = environment === 'mock' ? false : environment === 'live' || process.env.WORLD_MODEL === 'openai';
// The live entry may start before a key is saved from the browser. Legacy
// replay/monitor calls then fail explicitly instead of falling back to mock.
const useUnconfigured = environment === 'live' && !process.env.WORLD_API_KEY;
const root = fileURLToPath(new URL('../web/', import.meta.url));
const defaultStateFile = live ? 'world-live.json' : 'world.json';
const statePath = process.env.WORLD_STATE_PATH || fileURLToPath(new URL(`../.data/${defaultStateFile}`, import.meta.url));
const dataRoot = fileURLToPath(new URL('../.data/', import.meta.url));
const mockRoot = resolve(dataRoot, 'mock');
const liveRoot = resolve(dataRoot, 'live');
const resolvedState = resolve(statePath);
if (environment === 'mock' && (resolvedState === liveRoot || resolvedState.startsWith(liveRoot + sep))) throw new Error('模拟环境不能使用真实数据目录。');
if (environment === 'live' && (resolvedState === mockRoot || resolvedState.startsWith(mockRoot + sep))) throw new Error('真实环境不能使用模拟数据目录。');
mkdirSync(dirname(statePath), { recursive: true });
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
const unconfiguredLegacyProvider = {
  mode: 'live',
  async decide() {
    throw Object.assign(new Error('尚未配置模型凭据。'), { code: 'MODEL_NOT_CONFIGURED' });
  },
};
const provider = paceMock(useUnconfigured ? unconfiguredLegacyProvider : createProvider(), mockSpeed);
const world = createWorld({ statePath, provider });
const events = createEvents();
const mode = process.env.WORLD_MONITOR || (live ? 'off' : 'public');
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
// A live process may start without a key so the operator can save one from the
// browser. Until then no run or resume may call a real provider.
const unconfiguredProvider = {
  model: null,
  settings: null,
  configurationId: 'unconfigured-live',
  async complete() {
    throw Object.assign(new Error('尚未配置模型凭据。'), { code: 'MODEL_NOT_CONFIGURED' });
  },
};
if (useRuntime) {
  const { createResearchService } = await import('./runtime/research-service.mjs');
  runtimeProvider = live
    ? (useUnconfigured ? unconfiguredProvider : (await import('./runtime/model-provider.mjs')).createModelProvider())
    : (await import('./runtime/probe-provider.mjs')).createProbeProvider({ pacingMs: Math.round(mockSpeed * 700) });
  runtime = createResearchService({ path: process.env.WORLD_RUNTIME_PATH || `${statePath}.runtime.sqlite`,
    provider: runtimeProvider, modelMode: live ? 'live' : 'mock' });
}
if (workbenchMode === 'on') {
  const { createWorkbenchService } = await import('./domain/workbench-service.mjs');
  workbench = createWorkbenchService({ path: process.env.WORLD_DOMAIN_PATH || `${statePath}.domain.sqlite`, runtime, world });
}
const courseMode = process.env.WORLD_COURSE ?? (workbench ? 'on' : 'off');
if (!['on', 'off'].includes(courseMode)) throw new Error('WORLD_COURSE must be on or off');
if (courseMode === 'on') {
  if (!workbench) throw new Error('自动研究需要启用支持 SQLite 的工作台。');
  const { createCourseService } = await import('./course/course-service.mjs');
  const { createCourseMockProvider } = await import('./course/course-mock-provider.mjs');
  const { createWebResearchGateway } = await import('./course/web-tools.mjs');
  const courseProvider = live
    ? (useUnconfigured ? unconfiguredProvider : runtimeProvider || (await import('./runtime/model-provider.mjs')).createModelProvider())
    : createCourseMockProvider({ pacingMs: Math.round(mockSpeed * 550) });
  const sourceTools = createWebResearchGateway({ env: { ...process.env,
    WORLD_SEARCH_PROVIDER: process.env.WORLD_SEARCH_PROVIDER || (live ? 'deepseek' : 'fixture') } });
  const watchIntervalMs = Number(process.env.WORLD_COURSE_POLL_MS || 3600000);
  if (!Number.isInteger(watchIntervalMs) || watchIntervalMs < 1000 || watchIntervalMs > 86400000) throw new Error('自动检查间隔必须在1秒至1天之间。');
  course = createCourseService({ path: process.env.WORLD_COURSE_PATH || `${statePath}.course.sqlite`, workbench,
    provider: courseProvider, modelMode: live ? 'live' : 'mock', sourceTools, watchIntervalMs, evidencePolicy: 'quoted-claims-v1' });
  assertEnvironmentRuns(environment, course.listRuns())
  providerConnection = createProviderConnection({ locked: environment === 'mock', configured: live && Boolean(process.env.WORLD_API_KEY),
    getActiveCount: () => course.listRuns().filter(run => !['completed', 'insufficient', 'failed', 'cancelled'].includes(run.status)).length,
    getActiveWatchCount: () => course.listRequests().filter(item => course.getRequest(item.requestId).watch?.status === 'active' && item.watch !== false).length,
    getMode: () => course.capabilities.modelMode,
    async applyKey(apiKey) {
      // Credentials stay in the new provider/gateway closures, never .env,
      // checkpoints, process logs, public configuration or the browser cache.
      const nextEnv = { ...process.env, WORLD_MODEL: 'openai', WORLD_API_KEY: apiKey, WORLD_SEARCH_API_KEY: apiKey,
        WORLD_BASE_URL: process.env.WORLD_BASE_URL || 'https://api.deepseek.com', WORLD_MODEL_PROTOCOL: 'deepseek', WORLD_SEARCH_PROVIDER: 'deepseek',
        WORLD_MODEL_NAME: /^deepseek[-/]/i.test(process.env.WORLD_MODEL_NAME || '') ? process.env.WORLD_MODEL_NAME : 'deepseek-v4-pro',
        WORLD_MODEL_THINKING: process.env.WORLD_MODEL_THINKING || 'enabled',
        WORLD_MODEL_MAX_OUTPUT_TOKENS: process.env.WORLD_MODEL_MAX_OUTPUT_TOKENS || '32768',
        WORLD_MODEL_TIMEOUT_MS: process.env.WORLD_MODEL_TIMEOUT_MS || '180000' }
      const modelModule = await import('./runtime/model-provider.mjs')
      const nextProvider = modelModule.createModelProvider(nextEnv)
      const nextSources = createWebResearchGateway({ env: nextEnv })
      // The first key may be saved while old watchers exist: without any key
      // those plans cannot run. Once configured, replacing a key must not
      // silently take over running work or active watchers.
      const firstConfiguration = !providerConnection.status().configured
      if (!firstConfiguration && (course.listRuns().some(run => !['completed', 'insufficient', 'failed', 'cancelled'].includes(run.status)) ||
        course.listRequests().some(item => course.getRequest(item.requestId).watch?.status === 'active' && item.watch !== false))) throw new Error('Connection update requires idle research and watchers')
      let connection = 'failed'
      try { connection = (await modelModule.verifyModelCredentials(nextEnv)).connected ? 'connected' : 'failed' } catch { connection = 'failed' }
      const replacement = createCourseService({ path: process.env.WORLD_COURSE_PATH || `${statePath}.course.sqlite`, workbench,
        provider: nextProvider, modelMode: 'live', sourceTools: nextSources, watchIntervalMs, evidencePolicy: 'quoted-claims-v1' })
      try { await course.close() } catch (error) { await replacement.close(); throw error }
      course = replacement
      course.resume()
      return { connection }
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
      if (!['createRequest', 'check', 'stop', 'resumeResearchSummary'].includes(name)) return value
      return (...args) => {
        if (providerConnection?.changing) throw Object.assign(new Error('正在保存模型连接，请稍后继续。'), { code: 'PROVIDER_UPDATE_BUSY', status: 409 })
        if (name !== 'stop' && environment === 'live' && !providerConnection.status().configured) {
          throw Object.assign(new Error('请先在“模型连接”保存 DeepSeek API Key，再开始任务。'), { code: 'MODEL_NOT_CONFIGURED', status: 409 })
        }
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
  const modelReady = environment !== 'live' || Boolean(providerConnection?.status().configured || process.env.WORLD_API_KEY);
  if (modelReady) {
    runtime?.resume();
    course?.resume();
  }
  console.log(`世界事务所  http://127.0.0.1:${server.address().port}`);
});
server.on('close', () => {
  monitor.stop();
  void Promise.allSettled([runtime?.close(), course?.close()]).then(() => workbench?.close());
});
