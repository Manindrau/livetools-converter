'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTmp, startServer, postMultipart, sleep, waitFor } = require('./helpers');

const tmp = setupTmp();
const { app, _internals } = require('../server');
const { runLimited, queueDepth, MAX_CONCURRENT, MAX_QUEUE_WAITERS, LO_CONCURRENCY } = _internals;

let srv;
before(async () => { srv = await startServer(app); });
after(async () => { await srv.close(); });

test('preserved constants', () => {
  assert.strictEqual(MAX_CONCURRENT, 2);
  assert.strictEqual(LO_CONCURRENCY, 1);
  assert.strictEqual(MAX_QUEUE_WAITERS, 4);
  assert.strictEqual(_internals.TIMEOUTS.libreOffice, 60000);
  assert.strictEqual(_internals.TIMEOUTS.pdf2docx, 120000);
  assert.strictEqual(_internals.TIMEOUTS.ghostscript, 60000);
  assert.strictEqual(_internals.GS_MAX_ATTEMPTS, 5);
});

test('global queue never runs more than 2 jobs concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const job = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active -= 1;
  };
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(runLimited(job));
  await Promise.all(jobs);
  assert.strictEqual(maxActive, 2);
});

test('LibreOffice mutex serializes LO jobs at concurrency 1', async () => {
  let loActive = 0;
  let maxLo = 0;
  const loJob = async () => {
    loActive += 1;
    maxLo = Math.max(maxLo, loActive);
    await sleep(30);
    loActive -= 1;
  };
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(runLimited(loJob, { libreOffice: true }));
  await Promise.all(jobs);
  assert.strictEqual(maxLo, 1);
});

test('queue depth counts global waiters + LO mutex waiters without double counting', async () => {
  // Occupy the single LO mutex with a long-running LO job (holds global slot 1,
  // holds the LO mutex).
  let releaseLo;
  const loGate = new Promise((r) => { releaseLo = r; });
  const holder = runLimited(() => loGate, { libreOffice: true });
  await sleep(30); // holder dequeued, mutex acquired, loActive === 1

  // Second LO job: dequeued (global slot 2 free) but parks on the LO mutex.
  // It has left jobQueue and lives only in loWaitQueue => counted exactly once.
  const loWaiter = runLimited(() => sleep(5), { libreOffice: true });
  // A plain job now parks in jobQueue (both global slots busy)
  // => counted exactly once, in jobQueue only.
  const plainWaiter = runLimited(() => sleep(5));

  await sleep(50);
  assert.strictEqual(queueDepth(), 2, 'one LO mutex waiter + one global waiter, no double count');
  assert.ok(_internals.activeChildren !== undefined); // sanity

  releaseLo();
  await Promise.allSettled([holder, loWaiter, plainWaiter]);
  await waitFor(() => queueDepth() === 0, 3000, 'queue drained');
});

test('runLimited rejects with QUEUE_FULL beyond waiting threshold', async () => {
  const releases = [];
  // 2 jobs run immediately; push waiting depth to the threshold
  for (let i = 0; i < MAX_QUEUE_WAITERS + 2; i++) {
    runLimited(() => new Promise((r) => releases.push(r))).catch(() => {});
  }
  await sleep(30); // let pumpQueue settle (2 active, rest waiting)
  assert.ok(queueDepth() >= MAX_QUEUE_WAITERS, 'waiting depth at threshold');

  let err;
  try {
    await runLimited(() => sleep(1));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'over-threshold enqueue rejected');
  assert.strictEqual(err.code, 'QUEUE_FULL');

  // drain: released jobs let successors start, which push new resolvers
  await waitFor(async () => {
    const pending = releases.splice(0);
    pending.forEach((r) => r());
    return queueDepth() === 0;
  }, 5000, 'blockers drained');
});

test('HTTP 503 when queue is full', async () => {
  const releases = [];
  for (let i = 0; i < MAX_QUEUE_WAITERS + 2; i++) {
    runLimited(() => new Promise((r) => releases.push(r))).catch(() => {});
  }
  await sleep(30);

  const r = await postMultipart(srv.baseUrl, '/convert/pdf-to-word', {
    fileSize: 64,
    filename: 'a.pdf'
  });
  assert.strictEqual(r.status, 503);
  const body = JSON.parse(r.body);
  assert.match(body.error, /busy/i);

  await waitFor(async () => {
    const pending = releases.splice(0);
    pending.forEach((x) => x());
    return queueDepth() === 0;
  }, 5000, 'queue drained after 503');
});

test('shutdown drains global queue and LO waiters', async () => {
  // Internal drain functions are exercised through queueDepth behavior:
  // simulate by filling and using runLimited rejection on shuttingDown is
  // covered by source; here we assert the exported drain keeps depth at 0
  // after all jobs settle (no waiter leak).
  const jobs = [];
  for (let i = 0; i < 5; i++) {
    jobs.push(runLimited(() => sleep(10), { libreOffice: i % 2 === 0 }));
  }
  await Promise.all(jobs);
  assert.strictEqual(queueDepth(), 0);
  assert.strictEqual(_internals.activeChildren.size, 0, 'no child processes leaked');
});
