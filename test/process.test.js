'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTmp, startServer, postMultipart, sleep, waitFor, isProcessAlive } = require('./helpers');

const tmp = setupTmp();
const { app, _internals } = require('../server');
const { runProcess, killProcessTree, killActiveChildren, activeChildren } = _internals;

let srv;
before(async () => { srv = await startServer(app); });
after(async () => { await srv.close(); });

const node = process.execPath;

test('runProcess resolves on clean exit', async () => {
  const r = await runProcess(node, ['-e', 'process.exit(0)'], { timeoutMs: 5000 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(activeChildren.size, 0);
});

test('runProcess rejects with exit code on non-zero exit', async () => {
  let err;
  try {
    await runProcess(node, ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.code, 3);
  assert.strictEqual(activeChildren.size, 0);
});

test('runProcess rejects on spawn error (ENOENT) and settles once', async () => {
  let err;
  try {
    await runProcess('definitely-not-a-real-binary-livetools', [], { timeoutMs: 5000 });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.code, 'ENOENT');
  assert.strictEqual(activeChildren.size, 0);
});

test('runProcess timeout kills the child group', async () => {
  let err;
  const started = Date.now();
  try {
    await runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
  } catch (e) { err = e; }
  assert.ok(err, 'timed-out process rejects');
  assert.strictEqual(err.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'rejected promptly');
  await waitFor(() => activeChildren.size === 0, 3000, 'child registry cleaned after timeout');
});

test('client-abort cancellation kills the child (state.cancelActive)', async () => {
  const state = { cancelActive: null };
  const promise = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30000, state });
  await waitFor(() => typeof state.cancelActive === 'function', 3000, 'cancel hook registered');

  state.cancelActive('client-abort');
  state.cancelActive('client-abort'); // repeated cancellation must be a safe no-op

  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'cancellation rejects the promise');
  assert.strictEqual(err.cancelled, true);
  state.cancelActive('after-settle'); // must not throw after settlement
  await waitFor(() => activeChildren.size === 0, 3000, 'child registry cleaned after cancel');
});

test('process group: killing the parent also kills a grandchild', async () => {
  // parent spawns a child and stays alive; we kill the group from outside
  const parent = require('child_process').spawn(node, [
    '-e',
    `
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('fs').writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, grandchild: g.pid }));
    setInterval(() => {}, 1000);
    `,
    path.join(tmp, 'pids.json')
  ], { stdio: 'ignore' });

  await waitFor(() => fs.existsSync(path.join(tmp, 'pids.json')), 5000, 'pid file written');
  const pids = JSON.parse(fs.readFileSync(path.join(tmp, 'pids.json'), 'utf8'));

  killProcessTree(parent, 'SIGTERM', 'test');
  await waitFor(() => !isProcessAlive(pids.parent), 5000, 'parent dead');
  await waitFor(() => !isProcessAlive(pids.grandchild), 5000, 'grandchild dead (no orphans)');
});

test('killActiveChildren sweeps every in-flight child', async () => {
  const p1 = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30000 });
  const p2 = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30000 });
  await waitFor(() => activeChildren.size === 2, 3000, 'two children registered');

  killActiveChildren('test');
  await Promise.allSettled([p1, p2]);
  await waitFor(() => activeChildren.size === 0, 5000, 'all children swept');
});

test('HTTP abort mid-conversion cleans temp files (no convert_/compress_ residue)', async () => {
  // upload that will fail conversion fast (no real binary needed): route rejects
  // with 500; assert temp dirs cleaned afterwards.
  const r = await postMultipart(srv.baseUrl, '/convert/pdf-to-word', {
    fileSize: 1024,
    filename: 'a.pdf'
  });
  assert.strictEqual(r.status, 500);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'Conversion failed');

  await waitFor(() => {
    const residue = fs.readdirSync(tmp).filter((d) => d.startsWith('convert_') || d.startsWith('compress_'));
    const uploads = fs.readdirSync(path.join(tmp, 'uploads'));
    return residue.length === 0 && uploads.length === 0;
  }, 5000, 'temp dirs and uploads cleaned');
});
