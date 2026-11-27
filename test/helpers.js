'use strict';
// Shared helpers for backend tests. Requiring this module has no side effects
// beyond exporting functions.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Must be called BEFORE requiring ../server.js in each test file.
function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livetools-test-'));
  process.env.LIVETOOLS_TMP = dir;
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  return dir;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        server,
        baseUrl: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function buildMultipartParts(fields, file, fileSize) {
  const boundary = '----livetools' + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      String(value) + '\r\n'
    ));
  }
  const header = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + (file.field || 'file') + '"; filename="' + (file.filename || 'file.pdf') + '"\r\n' +
    'Content-Type: ' + (file.contentType || 'application/pdf') + '\r\n\r\n'
  );
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  return { boundary, header, footer, chunks };
}

// Streams a multipart POST. The file payload is sent as repeated chunks so we
// can push >100 MiB without allocating it all at once.
function postMultipart(baseUrl, route, opts) {
  const fields = opts.fields || {};
  const fileSize = opts.fileSize || 0;
  const { boundary, header, footer, chunks } = buildMultipartParts(fields, opts, fileSize);
  const chunkBuf = opts.buffer || Buffer.alloc(opts.chunkSize || 1024 * 1024, 0x41);
  const hasFile = !opts.omitFile;
  const fileHeaderLen = hasFile ? header.length : 0;
  const fileLen = hasFile ? fileSize : 0;
  const contentLength = chunks.reduce((n, c) => n + c.length, 0) +
    fileHeaderLen + fileLen + footer.length;

  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + route);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': contentLength
      }
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(bufs).toString('utf8')
      }));
      res.on('error', reject);
    });

    let responseSeen = false;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      // A late socket reset while the server is answering 413 is not a test
      // failure if the response already arrived.
      if (responseSeen) return;
      settled = true;
      reject(err);
    };
    req.on('error', fail);
    req.on('response', () => { responseSeen = true; settled = true; });

    for (const c of chunks) req.write(c);
    if (hasFile) req.write(header);
    let written = 0;
    function writeBody() {
      while (written < fileLen) {
        const n = Math.min(chunkBuf.length, fileLen - written);
        const slice = n === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, n);
        written += n;
        if (!req.write(slice)) {
          req.once('drain', writeBody);
          return;
        }
      }
      req.write(footer);
      req.end();
    }
    writeBody();
  });
}

function postJson(baseUrl, route, body, method) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + route);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(bufs).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if ((method || 'POST') === 'POST') req.write(payload);
    req.end();
  });
}

function get(baseUrl, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + route);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET'
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(bufs).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 3000);
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out: ' + (label || 'condition'));
    await sleep(50);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  setupTmp,
  startServer,
  postMultipart,
  postJson,
  get,
  sleep,
  waitFor,
  isProcessAlive
};
