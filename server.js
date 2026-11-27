const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const MiB = 1024 * 1024;

// --- temp roots, limits, concurrency knobs (LIVETOOLS_TMP is a test seam; default preserves production /tmp) ---
const TMP_ROOT = process.env.LIVETOOLS_TMP || '/tmp';
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const UPLOAD_LIMITS = { compressPdf: 100 * MiB, convert: 50 * MiB };
const LO_CONCURRENCY = 1;
const MAX_QUEUE_WAITERS = 4;
const TIMEOUTS = { libreOffice: 60000, pdf2docx: 120000, ghostscript: 60000 };
const GS_MAX_ATTEMPTS = 5;

// --- shutdown & request-accounting state ---
let shuttingDown = false;
let pendingRequests = 0;
let multerActive = 0;
let serverClosed = false;
let watchdog = null;
let httpServer = null;
const activePaths = new Set();

app.use(cors());

// --- request accounting: FIRST middleware, before any body parser (CORS above stays sync & first) ---
app.use((req, res, next) => {
  pendingRequests += 1;
  let decremented = false;
  const done = () => {
    if (decremented) return;
    decremented = true;
    pendingRequests -= 1;
    maybeShutdownExit('request-close');
  };
  res.on('close', done);

  if (shuttingDown) {
    // reject before Multer/express.json ever engage; Connection: close => socket not reusable with unread body
    try { res.set('Connection', 'close'); } catch (e) { /* ignore */ }
    if (!res.destroyed && !res.writableEnded) {
      if (!res.headersSent) {
        try { res.status(500).json({ error: 'Conversion failed' }); } catch (e) { /* ignore */ }
      } else {
        try { res.end(); } catch (e) { /* ignore */ }
      }
    }
    try { if (typeof req.resume === 'function') req.resume(); } catch (e) { /* ignore */ }
    return;
  }
  next();
});

app.use(express.json());

// --- minimal in-memory rate limiter (requests per IP per minute) ---
const RATE_LIMIT = 60;
const rateWindow = 60 * 1000;
const rateHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateHits) if (now > rec.reset) rateHits.delete(key);
}, 60 * 1000).unref();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  let rec = rateHits.get(key);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + rateWindow };
    rateHits.set(key, rec);
  }
  rec.count += 1;
  if (rec.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
}

// --- concurrency queue: LibreOffice/gs jobs are heavy, cap at 2 at a time ---
const MAX_CONCURRENT = 2;
const jobQueue = [];
let activeJobs = 0;

// --- LibreOffice mutex: at most 1 LO process; waiters live here, never in jobQueue ---
const loWaitQueue = [];
let loActive = 0;

// waiting jobs = global-queue waiters + LO mutex waiters.
// A job is shifted out of jobQueue BEFORE it tries to acquire the LO mutex,
// so it is present in exactly one of the two lists — never double-counted.
function queueDepth() {
  return jobQueue.length + loWaitQueue.length;
}

class QueueFullError extends Error {
  constructor() {
    super('Queue is full');
    this.code = 'QUEUE_FULL';
  }
}

function acquireLoMutex() {
  return new Promise((resolve, reject) => {
    if (shuttingDown) { reject(new Error('shutdown')); return; }
    if (loActive < LO_CONCURRENCY) {
      loActive += 1;
      resolve();
    } else {
      loWaitQueue.push({ resolve, reject });
    }
  });
}

function releaseLoMutex() {
  const next = loWaitQueue.shift();
  if (next) next.resolve(); // slot handed over; loActive unchanged
  else loActive -= 1;
}

function drainLoWaiters() {
  while (loWaitQueue.length) {
    const waiter = loWaitQueue.shift();
    try { waiter.reject(new Error('shutdown')); } catch (e) { /* ignore */ }
  }
}

function runLimited(fn, opts) {
  const needsLibreOffice = !!(opts && opts.libreOffice);
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error('shutdown'));
      return;
    }
    if (queueDepth() >= MAX_QUEUE_WAITERS) {
      reject(new QueueFullError());
      return;
    }
    jobQueue.push({ fn, resolve, reject, needsLibreOffice });
    pumpQueue();
  });
}

function pumpQueue() {
  if (shuttingDown) return;
  if (activeJobs >= MAX_CONCURRENT || jobQueue.length === 0) return;
  const { fn, resolve, reject, needsLibreOffice } = jobQueue.shift();
  activeJobs += 1;
  const run = needsLibreOffice
    ? acquireLoMutex().then(() => Promise.resolve().then(fn).finally(releaseLoMutex))
    : Promise.resolve().then(fn);
  run
    .then(resolve, reject)
    .finally(() => {
      activeJobs -= 1;
      pumpQueue();
      maybeShutdownExit('job-finished');
    });
}

function drainJobQueue() {
  while (jobQueue.length) {
    const { reject } = jobQueue.shift();
    try { reject(new Error('shutdown')); } catch (e) { /* ignore */ }
  }
}

// kills every in-flight child process group (timeout/abort paths kill per-request;
// this one is the graceful-shutdown sweep)
function killActiveChildren(reason) {
  for (const child of Array.from(activeChildren)) {
    killProcessTree(child, 'SIGTERM', reason);
  }
  if (activeChildren.size > 0) {
    const esc = setTimeout(() => {
      for (const child of Array.from(activeChildren)) {
        killProcessTree(child, 'SIGKILL', reason + '-escalate');
      }
    }, 2000);
    if (esc && typeof esc.unref === 'function') esc.unref();
  }
}

// --- tracked Multer: multerActive covers body writes AND abort/partial removal until Multer's own next() ---
// route-specific file-size caps: one Multer instance per limit class
function makeUpload(maxBytes) {
  return multer({ dest: UPLOAD_DIR, limits: { fileSize: maxBytes } });
}
const uploadDefault = makeUpload(UPLOAD_LIMITS.convert); // 50 MiB (existing routes unchanged)
const uploadCompress = makeUpload(UPLOAD_LIMITS.compressPdf); // 100 MiB

function trackedUpload(uploader, field) {
  const inner = uploader.single(field);
  return (req, res, next) => {
    multerActive += 1;
    let called = false;
    const cb = (err) => {
      if (called) return;
      called = true;
      multerActive -= 1;
      maybeShutdownExit('multer-done');
      next(err);
    };
    try {
      inner(req, res, cb);
    } catch (e) {
      cb(e);
    }
  };
}

// --- helpers ---
function sendJsonError(res, status, msg) {
  try {
    if (res.destroyed) return;
    if (res.writableEnded) return;
    if (res.headersSent) {
      if (res.writable) { try { res.end(); } catch (e) { /* ignore */ } }
      return;
    }
    if (!res.writable) return;
    res.status(status).json({ error: msg });
  } catch (e) { /* never throws */ }
}

function sendLegacy500(res, msg) {
  sendJsonError(res, 500, msg);
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error('[cleanup] FAILED path=' + dir + ' code=' + (e && e.code));
    return false;
  }
}

// --- request-scoped cleanup (idempotent; activePaths protects in-flight files from the sweep) ---
function attachRequestCleanup(req, res) {
  const state = { paths: [], dirs: [], phase: 'received', aborted: false, cleaned: false, cancelActive: null };
  if (req.file && req.file.path) {
    state.paths.push(req.file.path);
    activePaths.add(req.file.path);
  }
  res.on('close', () => {
    state.aborted = !res.writableEnded;
    if (state.aborted && state.phase === 'processing' && typeof state.cancelActive === 'function') {
      // client went away mid-job: kill the in-flight process group
      try { state.cancelActive('client-abort'); } catch (e) { /* ignore */ }
    }
    if (state.phase !== 'processing' && state.phase !== 'responding') {
      cleanupOnce();
    }
  });
  function cleanupOnce() {
    if (state.cleaned) return;
    state.cleaned = true;
    for (const p of state.paths.concat(state.dirs)) {
      activePaths.delete(p);
      cleanTempDir(p);
    }
  }
  return { state, cleanupOnce };
}

// --- temp sweep: 3 scopes, 1h age gate, activePaths skip, per-item error capture ---
function tempSweep() {
  const cutoff = Date.now() - 3600 * 1000;
  let dirsRemoved = 0;
  let uploadsRemoved = 0;
  let errors = 0;
  for (const prefix of ['convert_', 'compress_']) {
    try {
      for (const entry of fs.readdirSync(TMP_ROOT)) {
        if (!entry.startsWith(prefix)) continue;
        const full = path.join(TMP_ROOT, entry);
        try {
          if (activePaths.has(full)) continue;
          if (fs.statSync(full).mtimeMs < cutoff) {
            if (cleanTempDir(full)) dirsRemoved += 1;
            else errors += 1;
          }
        } catch (e) { /* entry vanished, ignore */ }
      }
    } catch (e) { /* /tmp unreadable, ignore */ }
  }
  // Uploads scope: skip entirely while any Multer request is in flight (multerActive > 0).
  // A file currently being written — or a stalled partial that never reached
  // attachRequestCleanup() — is not in activePaths yet; its mtime may exceed the age
  // cutoff if the client stalls, so age alone cannot protect it. multerActive is
  // incremented before Multer starts and decremented only in Multer's own callback
  // (after writes/removal attempts complete), so this gate covers the whole window.
  if (multerActive === 0) {
    try {
      for (const entry of fs.readdirSync(UPLOAD_DIR)) {
        const full = path.join(UPLOAD_DIR, entry);
        try {
          if (activePaths.has(full)) continue;
          if (fs.statSync(full).mtimeMs < cutoff) {
            if (cleanTempDir(full)) uploadsRemoved += 1;
            else errors += 1;
          }
        } catch (e) { /* entry vanished, ignore */ }
      }
    } catch (e) { /* /tmp/uploads absent, ignore */ }
  }
  if (dirsRemoved > 0 || uploadsRemoved > 0 || errors > 0) {
    console.log('[cleanup] sweep uploads=' + uploadsRemoved + ' dirs=' + dirsRemoved + ' errors=' + errors);
  }
}
setInterval(tempSweep, 30 * 60 * 1000).unref();
tempSweep();

// --- shutdown: five graceful gates + 6s watchdog force valve ---
function maybeShutdownExit(reason) {
  if (!shuttingDown) return;
  if (httpServer && typeof httpServer.closeIdleConnections === 'function') {
    try { httpServer.closeIdleConnections(); } catch (e) { /* ignore */ }
  }
  if (
    pendingRequests === 0 &&
    multerActive === 0 &&
    activeJobs === 0 &&
    jobQueue.length === 0 &&
    loWaitQueue.length === 0 &&
    activeChildren.size === 0 &&
    serverClosed === true
  ) {
    console.log('[shutdown] exit: all counters zero; serverClosed=true (' + reason + ')');
    try { tempSweep(); } catch (e) { /* ignore */ }
    process.exit(0);
  }
}

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    '[shutdown] begin signal=' + signal +
    ' pending=' + pendingRequests +
    ' multer=' + multerActive +
    ' jobs=' + activeJobs +
    ' queued=' + jobQueue.length +
    ' serverClosed=' + serverClosed
  );
  if (httpServer) {
    httpServer.close(() => {
      serverClosed = true;
      maybeShutdownExit('server-closed');
    });
    if (typeof httpServer.closeIdleConnections === 'function') {
      try { httpServer.closeIdleConnections(); } catch (e) { /* ignore */ }
    }
  } else {
    serverClosed = true;
  }
  drainJobQueue();
  drainLoWaiters();
  killActiveChildren('shutdown');
  maybeShutdownExit('signal');
  watchdog = setTimeout(() => {
    console.warn(
      '[shutdown] watchdog fired; forcing exit pending=' + pendingRequests +
      ' multer=' + multerActive +
      ' jobs=' + activeJobs +
      ' queued=' + jobQueue.length +
      ' serverClosed=' + serverClosed
    );
    try { tempSweep(); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 6000);
  if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
}

process.on('SIGTERM', () => beginShutdown('SIGTERM'));
process.on('SIGINT', () => beginShutdown('SIGINT'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gitSha: process.env.GIT_SHA || 'unknown'
  });
});

function requireUploadedFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return null;
  }
  return req.file;
}

function safeFilename(name, fallback) {
  // strip anything that could break the Content-Disposition header
  const cleaned = String(name || '')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

// --- process-group-aware child execution ---
const activeChildren = new Set();

function killProcessTree(child, signal, reason) {
  if (!child || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return; // already reaped
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => { /* ignore */ });
      return;
    }
    try {
      process.kill(-child.pid, signal); // whole process group (spawned detached)
    } catch (e) {
      if (e && e.code === 'ESRCH') return;
      try { child.kill(signal); } catch (e2) { /* race: already gone */ }
    }
  } catch (e) { /* never throws */ }
}

// options: timeoutMs (0 = none), state (request state for client-abort cancellation)
function runProcess(command, args, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 0;
  const state = opts.state || null;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe']
      });
    } catch (e) {
      reject(e);
      return;
    }

    activeChildren.add(child);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let exitTimer = null;
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        if (stderr.length < 8192) stderr += d;
      });
      child.stderr.on('error', () => { /* ignore */ });
    }

    function settle(fn, arg) {
      if (settled) return false; // first settlement wins (spawn-error vs close race)
      settled = true;
      if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
      activeChildren.delete(child);
      // replace with a no-op (not null) so late/repeated cancels stay safe
      if (state) state.cancelActive = () => {};
      fn(arg);
      return true;
    }

    function escalate(reason) {
      const esc = setTimeout(() => {
        if (!settled) killProcessTree(child, 'SIGKILL', reason + '-escalate');
      }, 2000);
      if (typeof esc.unref === 'function') esc.unref();
    }

    if (state) {
      // repeated calls after settlement or first cancel are no-ops
      state.cancelActive = (reason) => {
        if (settled || cancelled) return;
        cancelled = true;
        killProcessTree(child, 'SIGTERM', reason);
        escalate(reason);
      };
    }

    child.on('error', (err) => {
      // spawn failure (ENOENT, EACCES, ...) — settle once
      settle(reject, err);
    });

    child.on('exit', (code, signal) => {
      if (cancelled) {
        const err = new Error(command + ' cancelled');
        err.cancelled = true;
        settle(reject, err);
        return;
      }
      if (timedOut) {
        const err = new Error(command + ' timed out after ' + timeoutMs + 'ms');
        err.timedOut = true;
        settle(reject, err);
        return;
      }
      if (code === 0) {
        settle(resolve, { code, signal, stderr });
        return;
      }
      const err = new Error(
        command + ' exited with code ' + code +
        (stderr ? ': ' + stderr.slice(0, 500) : '')
      );
      err.code = code;
      err.signal = signal;
      settle(reject, err);
    });

    if (timeoutMs > 0) {
      exitTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killProcessTree(child, 'SIGTERM', 'timeout');
        escalate('timeout');
      }, timeoutMs);
      if (typeof exitTimer.unref === 'function') exitTimer.unref();
    }
  });
}

// Per-job UserInstallation profile: profileDir lives inside the job's temp dir,
// so request cleanup / temp sweep remove it with the rest of the job.
function libreOfficeArgs(inputPath, outputFormat, profileDir) {
  return [
    '-env:UserInstallation=file://' + profileDir,
    '--headless',
    '--convert-to', outputFormat,
    '--outdir', path.dirname(inputPath), inputPath
  ];
}

function runLibreOffice(inputPath, outputFormat, state) {
  const outputDir = path.dirname(inputPath);
  const profileDir = path.join(outputDir, 'lo_profile');
  return runProcess('libreoffice', libreOfficeArgs(inputPath, outputFormat, profileDir), {
    timeoutMs: TIMEOUTS.libreOffice,
    state
  }).then(() => {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(outputDir, baseName + '.' + outputFormat);
  });
}

function runPdf2Docx(inputPath, state) {
  const outputDir = path.dirname(inputPath);
  const outputPath = path.join(outputDir, 'output.docx');
  return runProcess('python3', ['-c', `
import sys
from pdf2docx import Converter

cv = Converter(sys.argv[1])
cv.convert(sys.argv[2])
cv.close()
`, inputPath, outputPath], {
    timeoutMs: TIMEOUTS.pdf2docx,
    state
  }).then(() => outputPath);
}

function runGhostscript(inputPath, outputPath, dpi, state) {
  return runProcess('gs', [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      '-dDownsampleColorImages=true',
      '-dDownsampleGrayImages=true',
      '-dDownsampleMonoImages=true',
      `-dColorImageResolution=${dpi}`,
      `-dGrayImageResolution=${dpi}`,
      `-dMonoImageResolution=${dpi}`,
      '-dAutoFilterColorImages=false',
      '-dColorImageDownsampleType=/Bicubic',
      '-sOutputFile=' + outputPath,
      inputPath
    ], {
      timeoutMs: TIMEOUTS.ghostscript,
      state
    }
  );
}

// Indirection so tests can substitute synthetic converters for the real
// binaries; production behavior is unchanged (routes resolve through this map).
const runners = {
  libreOffice: runLibreOffice,
  pdf2docx: runPdf2Docx,
  ghostscript: runGhostscript
};

// --- response streaming with actual-source-closure settlement ---
function sendFileResponse(res, filePath, contentType, downloadName) {
  return new Promise((resolve) => {
    let settled = false;
    let outcome = null;
    let sourceClosed = false;
    let finishing = false;
    let tornDown = false;
    let fileStream = null;
    let onStreamError = null;
    let onFin = null;
    let onClose = null;
    let onResError = null;
    let onSourceClose = null;
    let warnTimer = null;

    function removeOurListeners() {
      if (fileStream && onStreamError) fileStream.removeListener('error', onStreamError);
      if (fileStream && onSourceClose) fileStream.removeListener('close', onSourceClose);
      if (onFin) res.removeListener('finish', onFin);
      if (onClose) res.removeListener('close', onClose);
      if (onResError) res.removeListener('error', onResError);
      if (warnTimer) { clearInterval(warnTimer); warnTimer = null; }
    }

    function tryFinalize() {
      if (settled) return;
      if (!fileStream) {
        settled = true;
        removeOurListeners();
        resolve(outcome);
        return;
      }
      if (!sourceClosed) return;
      settled = true;
      removeOurListeners();
      resolve(outcome);
    }

    function armSourceWait() {
      if (!fileStream) { sourceClosed = true; tryFinalize(); return; }
      if (!onSourceClose) {
        onSourceClose = () => {
          sourceClosed = true;
          if (warnTimer) { clearInterval(warnTimer); warnTimer = null; }
          tryFinalize();
        };
        fileStream.once('close', onSourceClose);
      }
      if (fileStream.closed === true) {
        if (warnTimer) { clearInterval(warnTimer); warnTimer = null; }
        sourceClosed = true;
        tryFinalize();
        return;
      }
      if (!warnTimer) {
        warnTimer = setInterval(() => {
          console.warn('[stream] warn: waiting for source close');
        }, 5000);
        if (warnTimer && typeof warnTimer.unref === 'function') warnTimer.unref();
      }
    }

    function teardownSource() {
      if (tornDown || !fileStream) return;
      tornDown = true;
      try { fileStream.unpipe(res); } catch (e) { /* ignore */ }
      if (!fileStream.destroyed) fileStream.destroy();
      armSourceWait();
    }

    function send500(msg) {
      try {
        if (res.destroyed) return;
        if (res.writableEnded) return;
        if (res.headersSent) {
          if (res.writable) { try { res.end(); } catch (e) { /* ignore */ } }
          return;
        }
        if (!res.writable) return;
        res.status(500).json({ error: msg });
      } catch (e) {
        try { console.error('FileStream error:', e); } catch (x) { /* ignore */ }
      }
    }

    function handleFatal(o, msg, logErr) {
      try {
        if (logErr !== undefined) console.error('FileStream error:', logErr);
        if (outcome === null) outcome = o;
        send500(msg);
      } finally {
        teardownSource();
        tryFinalize();
      }
    }

    try {
      if (!fs.existsSync(filePath)) {
        outcome = 'missing';
        send500('Conversion failed: output file not created');
        tryFinalize();
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"');
      fileStream = fs.createReadStream(filePath);
      onStreamError = (err) => {
        if (settled || tornDown) return;
        handleFatal('stream-error', 'Conversion failed', err);
      };
      onResError = () => {
        if (settled) return;
        handleFatal('res-error', 'Conversion failed');
      };
      onFin = () => {
        if (settled) return;
        if (outcome === null) outcome = 'finished';
        finishing = true;
        teardownSource();
        tryFinalize();
      };
      onClose = () => {
        if (settled || finishing) return;
        if (outcome === null) outcome = 'closed-before-finish';
        teardownSource();
        tryFinalize();
      };
      fileStream.on('error', onStreamError);
      res.once('finish', onFin);
      res.once('close', onClose);
      res.on('error', onResError);
      fileStream.pipe(res);
    } catch (e) {
      handleFatal('sync-throw', 'Conversion failed', e);
    }
  });
}

// --- document conversions ---
function makeConvertRoute(outputFormat, defaultExt, contentType) {
  return (req, res) => {
    const { state, cleanupOnce } = attachRequestCleanup(req, res);

    if (shuttingDown) {
      sendLegacy500(res, 'Conversion failed');
      cleanupOnce();
      return;
    }

    const file = requireUploadedFile(req, res);
    if (!file) {
      cleanupOnce();
      return;
    }

    state.phase = 'queued';
    // LibreOffice routes (anything converting TO pdf via LO) serialize on the LO mutex;
    // pdf-to-word runs python and does not take it.
    const needsLibreOffice = outputFormat !== 'docx';
    runLimited(async () => {
      if (res.destroyed || state.aborted || shuttingDown) {
        console.error('[cleanup] skipped reason=abort');
        sendLegacy500(res, 'Conversion failed');
        cleanupOnce();
        return;
      }
      state.phase = 'processing';
      const inputDir = path.join(TMP_ROOT, 'convert_' + uuidv4());
      fs.mkdirSync(inputDir, { recursive: true });
      state.dirs.push(inputDir);
      activePaths.add(inputDir);
      const ext = (path.extname(file.originalname) || defaultExt).toLowerCase();
      const inputPath = path.join(inputDir, 'source' + ext);
      fs.renameSync(file.path, inputPath);
      try {
        let outputPath;
        if (outputFormat === 'docx') {
          outputPath = await runners.pdf2docx(inputPath, state);
        } else {
          outputPath = await runners.libreOffice(inputPath, outputFormat, state);
        }
        const stem = safeFilename(path.basename(file.originalname, path.extname(file.originalname)), 'document');
        const downloadName = stem + (outputFormat === 'docx' ? '.docx' : '.pdf');
        if (res.destroyed || state.aborted) {
          // client disconnected during processing — do not start streaming a dead response
          console.error('[cleanup] skipped reason=abort');
          return;
        }
        state.phase = 'responding';
        await sendFileResponse(res, outputPath, contentType, downloadName);
      } catch (error) {
        console.error('Conversion error:', error);
        sendLegacy500(res, 'Conversion failed');
      } finally {
        state.phase = 'settled';
        state.cancelActive = null;
        cleanupOnce();
      }
    }, { libreOffice: needsLibreOffice }).catch((err) => {
      if (err && err.code === 'QUEUE_FULL') {
        sendJsonError(res, 503, 'Server is busy. Please try again shortly.');
      } else {
        sendLegacy500(res, 'Conversion failed');
      }
      cleanupOnce();
    });
  };
}

app.post('/convert/word-to-pdf', rateLimit, trackedUpload(uploadDefault, 'file'), makeConvertRoute('pdf', '.docx', 'application/pdf'));
app.post('/convert/pdf-to-word', rateLimit, trackedUpload(uploadDefault, 'file'), makeConvertRoute('docx', '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
app.post('/convert/excel-to-pdf', rateLimit, trackedUpload(uploadDefault, 'file'), makeConvertRoute('pdf', '.xlsx', 'application/pdf'));
app.post('/convert/ppt-to-pdf', rateLimit, trackedUpload(uploadDefault, 'file'), makeConvertRoute('pdf', '.pptx', 'application/pdf'));

// --- PDF compression with target size ---
app.post('/compress-pdf', rateLimit, trackedUpload(uploadCompress, 'file'), (req, res) => {
  const { state, cleanupOnce } = attachRequestCleanup(req, res);

  if (shuttingDown) {
    sendLegacy500(res, 'Compression failed');
    cleanupOnce();
    return;
  }

  const file = requireUploadedFile(req, res);
  if (!file) {
    cleanupOnce();
    return;
  }

  state.phase = 'queued';
  runLimited(async () => {
    if (res.destroyed || state.aborted || shuttingDown) {
      console.error('[cleanup] skipped reason=abort');
      sendLegacy500(res, 'Compression failed');
      cleanupOnce();
      return;
    }
    state.phase = 'processing';
    const targetSizeKB = parseInt(req.body.targetSize, 10) || 500;
    const targetBytes = targetSizeKB * 1024;
    const inputDir = path.join(TMP_ROOT, 'compress_' + uuidv4());
    fs.mkdirSync(inputDir, { recursive: true });
    state.dirs.push(inputDir);
    activePaths.add(inputDir);
    const inputPath = path.join(inputDir, 'input.pdf');
    const outputPath = path.join(inputDir, 'output.pdf');
    fs.renameSync(file.path, inputPath);

    try {
      const originalSize = fs.statSync(inputPath).size;

      if (originalSize <= targetBytes) {
        if (res.destroyed || state.aborted) {
          // client disconnected during processing — do not start streaming a dead response
          console.error('[cleanup] skipped reason=abort');
          return;
        }
        state.phase = 'responding';
        await sendFileResponse(res, inputPath, 'application/pdf', 'compressed.pdf');
        return;
      }

      let low = 30;
      let high = 200;
      let bestPath = null;
      let bestSize = Infinity;
      let attempts = 0;
      const maxAttempts = GS_MAX_ATTEMPTS;

      while (low <= high && attempts < maxAttempts) {
        const mid = Math.round((low + high) / 2);
        attempts += 1;

        const attemptOutput = path.join(inputDir, 'attempt_' + mid + '.pdf');
        try {
          await runners.ghostscript(inputPath, attemptOutput, mid, state);
        } catch (e) {
          if (e && e.cancelled) throw e; // client abort: stop searching immediately
          high = mid - 1;
          continue;
        }

        if (!fs.existsSync(attemptOutput)) {
          high = mid - 1;
          continue;
        }

        const attemptSize = fs.statSync(attemptOutput).size;

        if (attemptSize < bestSize) {
          bestSize = attemptSize;
          bestPath = attemptOutput;
        }

        if (attemptSize <= targetBytes) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (!bestPath) {
        throw new Error('Compression failed');
      }

      if (bestPath !== outputPath) {
        fs.copyFileSync(bestPath, outputPath);
      }

      if (res.destroyed || state.aborted) {
        // client disconnected during processing — do not start streaming a dead response
        console.error('[cleanup] skipped reason=abort');
        return;
      }
      state.phase = 'responding';
      await sendFileResponse(res, outputPath, 'application/pdf', 'compressed.pdf');
    } catch (error) {
      if (error && (error.cancelled || state.aborted)) {
        console.error('[cleanup] skipped reason=abort');
      } else {
        console.error('Compression error:', error);
        sendLegacy500(res, 'Compression failed');
      }
    } finally {
      state.phase = 'settled';
      state.cancelActive = null;
      cleanupOnce();
    }
  }).catch((err) => {
    if (err && err.code === 'QUEUE_FULL') {
      sendJsonError(res, 503, 'Server is busy. Please try again shortly.');
    } else {
      sendLegacy500(res, 'Compression failed');
    }
    cleanupOnce();
  });
});

// --- central JSON error handler: multer limit/validation failures & anything unhandled ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // drain any body still in flight so the error response is delivered
  // cleanly instead of racing a socket reset
  try { if (req && typeof req.resume === 'function') req.resume(); } catch (e) { /* ignore */ }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const mib = Math.round((req.path === '/compress-pdf' ? UPLOAD_LIMITS.compressPdf : UPLOAD_LIMITS.convert) / MiB);
    sendJsonError(res, 413, 'File exceeds the ' + mib + ' MB upload limit.');
    return;
  }
  if (err && err.code && String(err.code).startsWith('LIMIT_')) {
    sendJsonError(res, 400, 'Invalid upload: ' + (err.message || err.code));
    return;
  }
  if (err && err.type === 'entity.parse.failed') {
    sendJsonError(res, 400, 'Invalid JSON body.');
    return;
  }
  if (err && err.code === 'QUEUE_FULL') {
    sendJsonError(res, 503, 'Server is busy. Please try again shortly.');
    return;
  }
  console.error('Unhandled error:', err);
  sendJsonError(res, 500, 'Internal server error.');
});

if (require.main === module) {
  httpServer = app.listen(PORT, () => {
    console.log(`Converter server running on port ${PORT}`);
  });
}

module.exports = {
  app,
  // test seams (no behavior change when unused)
  _internals: {
    runLimited,
    queueDepth,
    runProcess,
    killProcessTree,
    killActiveChildren,
    activeChildren,
    runners,
    libreOfficeArgs,
    makeUpload,
    UPLOAD_LIMITS,
    MAX_CONCURRENT,
    MAX_QUEUE_WAITERS,
    LO_CONCURRENCY,
    TIMEOUTS,
    GS_MAX_ATTEMPTS,
    QueueFullError,
    TMP_ROOT
  }
};
