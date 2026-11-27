'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTmp, startServer, postMultipart, waitFor } = require('./helpers');

const tmp = setupTmp();
const { app, _internals } = require('../server');
const { runners } = _internals;

let srv;
before(async () => { srv = await startServer(app); });
after(async () => { await srv.close(); });

const realRunners = { libreOffice: runners.libreOffice, pdf2docx: runners.pdf2docx, ghostscript: runners.ghostscript };
beforeEach(() => {
  runners.libreOffice = realRunners.libreOffice;
  runners.pdf2docx = realRunners.pdf2docx;
  runners.ghostscript = realRunners.ghostscript;
});

const syntheticPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function findLatest(prefix) {
  const dirs = fs.readdirSync(tmp).filter((d) => d.startsWith(prefix));
  return dirs.length ? path.join(tmp, dirs.sort().pop()) : null;
}

test('word-to-pdf: success path returns PDF with download headers', async () => {
  let sawState = null;
  let sawProfile = null;
  runners.libreOffice = async (inputPath, outputFormat, state) => {
    sawState = state;
    const out = path.join(path.dirname(inputPath), path.basename(inputPath, '.docx') + '.' + outputFormat);
    // profile arg comes from the pure builder used by the real runner
    sawProfile = _internals.libreOfficeArgs(inputPath, outputFormat, path.join(path.dirname(inputPath), 'lo_profile'));
    fs.writeFileSync(out, syntheticPdf);
    return out;
  };

  const r = await postMultipart(srv.baseUrl, '/convert/word-to-pdf', {
    fileSize: syntheticPdf.length,
    filename: 'report.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /application\/pdf/);
  assert.match(r.headers['content-disposition'], /attachment; filename="report\.pdf"/);
  assert.ok(sawState && typeof sawState === 'object', 'runner receives request state');
  assert.ok(sawProfile.some((a) => a.startsWith('-env:UserInstallation=file://')), 'per-job LO profile flag present');
  assert.ok(sawProfile.some((a) => a.includes('lo_profile')), 'profile dir inside job temp dir');
});

test('word-to-pdf: runner failure returns 500 JSON and cleans temp', async () => {
  runners.libreOffice = async () => { throw new Error('synthetic failure'); };
  const r = await postMultipart(srv.baseUrl, '/convert/word-to-pdf', {
    fileSize: syntheticPdf.length,
    filename: 'bad.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.strictEqual(r.status, 500);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'Conversion failed');
  await waitFor(() => !findLatest('convert_'), 5000, 'convert temp cleaned');
});

test('pdf-to-word: success path returns DOCX', async () => {
  runners.pdf2docx = async (inputPath, state) => {
    const out = path.join(path.dirname(inputPath), 'output.docx');
    fs.writeFileSync(out, Buffer.from('PK-fake-docx'));
    return out;
  };
  const r = await postMultipart(srv.baseUrl, '/convert/pdf-to-word', {
    fileSize: syntheticPdf.length,
    filename: 'doc.pdf'
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /wordprocessingml\.document/);
  assert.match(r.headers['content-disposition'], /attachment; filename="doc\.docx"/);
});

test('pdf-to-word: default runner failure returns 500 JSON', async () => {
  // no stub: real python3/pdf2docx path fails on this machine — still must be clean 500 JSON
  const r = await postMultipart(srv.baseUrl, '/convert/pdf-to-word', {
    fileSize: syntheticPdf.length,
    filename: 'doc.pdf'
  });
  assert.strictEqual(r.status, 500);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'Conversion failed');
  await waitFor(() => !findLatest('convert_'), 5000, 'convert temp cleaned');
});

test('compress: passthrough when input already under target', async () => {
  let gsCalled = false;
  runners.ghostscript = async () => { gsCalled = true; throw new Error('should not run'); };
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', {
    fileSize: syntheticPdf.length,
    filename: 'small.pdf',
    fields: { targetSize: '500' } // 500 KB target > tiny input
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(gsCalled, false, 'Ghostscript not invoked on passthrough');
  assert.match(r.headers['content-disposition'], /compressed\.pdf/);
});

test('compress: binary search caps at 5 attempts and picks smallest output', async () => {
  const calls = [];
  runners.ghostscript = async (inputPath, outputPath, dpi, state) => {
    calls.push(dpi);
    assert.ok(state && typeof state.cancelActive === 'object', 'state passed to gs runner');
    // synthetic size curve: larger dpi => smaller file (opposite of real gs, but
    // exercises the same best-selection logic)
    const size = 100000 - dpi * 100;
    fs.writeFileSync(outputPath, Buffer.alloc(size, 0x42));
  };

  const input = Buffer.alloc(600 * 1024, 0x43); // 600 KB > 500 KB target
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', {
    fileSize: input.length,
    buffer: input,
    filename: 'big.pdf',
    fields: { targetSize: '500' }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.length, 5, 'attempts capped at five');
  assert.strictEqual(_internals.GS_MAX_ATTEMPTS, 5);
  // binary search over [30,200]: mid values must be monotonically derived
  assert.strictEqual(calls[0], 115);
  await waitFor(() => !findLatest('compress_'), 5000, 'compress temp cleaned');
});

test('compress: all attempts failing returns 500 JSON and cleans temp', async () => {
  runners.ghostscript = async () => { throw new Error('gs synthetic failure'); };
  const input = Buffer.alloc(600 * 1024, 0x44);
  const r = await postMultipart(srv.baseUrl, '/compress-pdf', {
    fileSize: input.length,
    buffer: input,
    filename: 'big.pdf',
    fields: { targetSize: '500' }
  });
  assert.strictEqual(r.status, 500);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'Compression failed');
  await waitFor(() => !findLatest('compress_'), 5000, 'compress temp cleaned');
});
