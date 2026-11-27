'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTmp, startServer, get } = require('./helpers');

setupTmp();
process.env.GIT_SHA = 'deadbeefcafe1234567890abcdef1234567890ab';
const { app } = require('../server');

let srv;
before(async () => { srv = await startServer(app); });
after(async () => { await srv.close(); });

test('health endpoint exposes deployed Git SHA', async () => {
  const r = await get(srv.baseUrl, '/health');
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.status, 'ok');
  assert.ok(typeof body.timestamp === 'string');
  assert.strictEqual(body.gitSha, process.env.GIT_SHA);
});

test('health falls back to unknown when GIT_SHA unset', async () => {
  const saved = process.env.GIT_SHA;
  delete process.env.GIT_SHA;
  try {
    const r = await get(srv.baseUrl, '/health');
    const body = JSON.parse(r.body);
    assert.strictEqual(body.gitSha, 'unknown');
  } finally {
    process.env.GIT_SHA = saved;
  }
});
