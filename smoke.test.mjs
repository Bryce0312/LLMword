import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./server/app.mjs', import.meta.url));

async function launch(statePath, t) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: '0', WORLD_MODEL: 'mock', WORLD_STATE_PATH: statePath, WORLD_MONITOR: 'off', WORLD_MOCK_PACING: '0', WORLD_WORKBENCH: 'off', WORLD_RUNTIME: 'off' },
  });
  const exited = once(child, 'exit');
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostics += chunk; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  t.after(stop);
  const address = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    exited.then(() => reject(new Error(`Server stopped before it was ready: ${diagnostics}`)), reject);
  });
  return { address, stop };
}

async function json(address, route, body) {
  const options = body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const response = await fetch(`${address}/api/${route}`, options);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('HTTP demo serves assets, isolates branches and learns from revealed results', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'world-lab-smoke-'));
  const statePath = join(dir, 'state.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await launch(statePath, t);
  const { address } = first;
  const html = await fetch(address);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /世界事务所/);
  const art = await fetch(`${address}/assets/lab.png`, { method: 'HEAD' });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/png');
  const foreignRun = await fetch(`${address}/api/run`, {
    method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}',
  });
  assert.equal(foreignRun.status, 403);

  const initial = await json(address, 'world');
  assert.equal(initial.mode, 'mock');
  assert.equal(initial.step, 0);
  assert.ok(initial.agents.length >= 4);
  assert.ok(initial.tools.length >= 6);
  assert.ok(!initial.evidence.some((item) => item.id === 'amd-8k'));
  assert.equal(initial.learning.resolved, 0);

  const baseline = await json(address, 'run', { branch: 'base' });
  const prediction = baseline.forecast.probability;
  assert.ok(prediction > 0 && prediction < 1);
  assert.ok(new Set(baseline.trace.map((record) => record.agentId).filter(Boolean)).size >= 4);
  assert.ok(new Set(baseline.trace.map((record) => record.tool).filter(Boolean)).size >= 4);

  const hypothetical = await json(address, 'run', { branch: 'broad' });
  assert.equal(hypothetical.learning.resolved, 0);
  assert.deepEqual(hypothetical.factors, baseline.factors);
  assert.deepEqual(hypothetical.evidence, baseline.evidence);

  const revealed = await json(address, 'advance', {});
  assert.equal(revealed.step, 1);
  assert.ok(revealed.evidence.some((item) => item.id === 'amd-8k'));
  assert.equal(revealed.learning.resolved, 1);
  assert.equal(revealed.learning.history[0].probability, prediction);
  assert.ok(Math.abs(revealed.learning.brier - (prediction - 1) ** 2) < 0.001);
  await first.stop();

  const second = await launch(statePath, t);
  assert.equal((await json(second.address, 'world')).learning.resolved, 1);
  const followUp = await json(second.address, 'run', { branch: 'base' });
  assert.notEqual(followUp.forecast.target, baseline.forecast.target);
  const settled = await json(second.address, 'advance', {});
  assert.equal(settled.learning.resolved, 2);
  const reset = await json(second.address, 'reset', {});
  assert.equal(reset.step, 0);
  assert.equal(reset.learning.resolved, 0);
  await second.stop();
});
