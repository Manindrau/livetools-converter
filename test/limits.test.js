'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTmp, startServer, postMultipart, postJson, waitFor } = require('./helpers');

const tmp = setupTmp();
const { app, _internals } = require('../server');

let srv;
before(async () => { srv = await startServer(app); });
after(async () => { await srv.close(); });

const MiB = 1024 * 1024;

test('configured limits: compress 100 MiB, convert 50 MiB', () => {
  assert.strictEqual(_internals.UPLOAD_LIMITS.compressPdf, 100 * MiB);
  assert.strictEqual(_internals.UPLOAD_LIMITS.convert, 50 * MiB);
});

test('missing file returns 400 JSON', async () => {
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', { fileSize: 0, omitFile: true, fields: { targetSize: '500' } });
  assert.strictEqual(r.status, 400);
  const body = JSON.parse(r.body);
  assert.strictEqual(typeof body.error, 'string');
});

test('wrong multipart field returns 400 JSON', async () => {
  const r = await postMultipart(srv.baseUrl, '/convert/word-to-pdf', {
    fileSize: 16,
    field: 'wrongfield',
    filename: 'a.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.strictEqual(r.status, 400);
  const body = JSON.parse(r.body);
  assert.match(body.error, /invalid upload/i);
});

test('malformed JSON body returns 400 JSON', async () => {
  const r = await postJson(srv.baseUrl, '/compress-pdf', '{"broken":');
  assert.strictEqual(r.status, 400);
  const body = JSON.parse(r.body);
  assert.match(body.error, /invalid json/i);
});

test('compress-pdf rejects 100 MiB + 1 byte with 413 JSON', async () => {
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', {
    fileSize: 100 * MiB + 1,
    filename: 'big.pdf',
    fields: { targetSize: '500' }
  });
  assert.strictEqual(r.status, 413);
  const body = JSON.parse(r.body);
  assert.match(body.error, /100 MB/);
});

test('word-to-pdf rejects 50 MiB + 1 byte with 413 JSON', async () => {
  const r = await postMultipart(srv.baseUrl, '/convert/word-to-pdf', {
    fileSize: 50 * MiB + 1,
    filename: 'big.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.strictEqual(r.status, 413);
  const body = JSON.parse(r.body);
  assert.match(body.error, /50 MB/);
});

test('pdf-to-word rejects 50 MiB + 1 byte with 413 JSON', async () => {
  const r = await postMultipart(srv.baseUrl, '/convert/pdf-to-word', {
    fileSize: 50 * MiB + 1,
    filename: 'big.pdf'
  });
  assert.strictEqual(r.status, 413);
  const body = JSON.parse(r.body);
  assert.match(body.error, /50 MB/);
});

test('compress-pdf accepts 51 MiB (above convert limit, below compress limit)', async () => {
  const targetSizeKB = 1024 * 1024; // 1 GiB target => passthrough path, no converter invoked
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', {
    fileSize: 51 * MiB,
    filename: 'mid.pdf',
    fields: { targetSize: String(targetSizeKB) }
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-disposition'] || '', /compressed\.pdf/);
});

test('upload limiter leaves no partial files behind', async () => {
  await waitFor(() => fs.readdirSync(path.join(tmp, 'uploads')).length === 0, 5000, 'uploads dir drained');
});
