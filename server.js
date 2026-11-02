const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

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

function runLimited(fn) {
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error('shutdown'));
      return;
    }
    jobQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  if (shuttingDown) return;
  if (activeJobs >= MAX_CONCURRENT || jobQueue.length === 0) return;
  const { fn, resolve, reject } = jobQueue.shift();
  activeJobs += 1;
  Promise.resolve()
    .then(fn)
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

// --- tracked Multer: multerActive covers body writes AND abort/partial removal until Multer's own next() ---
const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: 50 * 1024 * 1024 }
});

function trackedUpload(field) {
  const inner = upload.single(field);
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
function sendLegacy500(res, msg) {
  try {
    if (res.destroyed) return;
    if (res.writableEnded) return;
    if (res.headersSent) {
      if (res.writable) { try { res.end(); } catch (e) { /* ignore */ } }
      return;
    }
    if (!res.writable) return;
    res.status(500).json({ error: msg });
  } catch (e) { /* never throws */ }
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
  const state = { paths: [], dirs: [], phase: 'received', aborted: false, cleaned: false };
  if (req.file && req.file.path) {
    state.paths.push(req.file.path);
    activePaths.add(req.file.path);
  }
  res.on('close', () => {
    state.aborted = !res.writableEnded;
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
      for (const entry of fs.readdirSync('/tmp')) {
        if (!entry.startsWith(prefix)) continue;
        const full = path.join('/tmp', entry);
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
      for (const entry of fs.readdirSync('/tmp/uploads')) {
        const full = path.join('/tmp/uploads', entry);
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

function runLibreOffice(inputPath, outputFormat) {
  const outputDir = path.dirname(inputPath);
  return execFileAsync(
    'libreoffice',
    ['--headless', '--convert-to', outputFormat, '--outdir', outputDir, inputPath],
    { timeout: 60000 }
  ).then(() => {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(outputDir, baseName + '.' + outputFormat);
  });
}

function runPdf2Docx(inputPath) {
  const outputDir = path.dirname(inputPath);
  const outputPath = path.join(outputDir, 'output.docx');
  return execFileAsync(
    'python3',
    ['-c', `
import sys
from pdf2docx import Converter

cv = Converter(sys.argv[1])
cv.convert(sys.argv[2])
cv.close()
`, inputPath, outputPath],
    { timeout: 120000 }
  ).then(() => outputPath);
}

function runGhostscript(inputPath, outputPath, dpi) {
  return execFileAsync(
    'gs',
    [
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
    ],
    { timeout: 60000 }
  );
}

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
    runLimited(async () => {
      if (res.destroyed || state.aborted || shuttingDown) {
        console.error('[cleanup] skipped reason=abort');
        sendLegacy500(res, 'Conversion failed');
        cleanupOnce();
        return;
      }
      state.phase = 'processing';
      const inputDir = '/tmp/convert_' + uuidv4();
      fs.mkdirSync(inputDir, { recursive: true });
      state.dirs.push(inputDir);
      activePaths.add(inputDir);
      const ext = (path.extname(file.originalname) || defaultExt).toLowerCase();
      const inputPath = path.join(inputDir, 'source' + ext);
      fs.renameSync(file.path, inputPath);
      try {
        let outputPath;
        if (outputFormat === 'docx') {
          outputPath = await runPdf2Docx(inputPath);
        } else {
          outputPath = await runLibreOffice(inputPath, outputFormat);
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
        cleanupOnce();
      }
    }).catch(() => {
      sendLegacy500(res, 'Conversion failed');
      cleanupOnce();
    });
  };
}

app.post('/convert/word-to-pdf', rateLimit, trackedUpload('file'), makeConvertRoute('pdf', '.docx', 'application/pdf'));
app.post('/convert/pdf-to-word', rateLimit, trackedUpload('file'), makeConvertRoute('docx', '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
app.post('/convert/excel-to-pdf', rateLimit, trackedUpload('file'), makeConvertRoute('pdf', '.xlsx', 'application/pdf'));
app.post('/convert/ppt-to-pdf', rateLimit, trackedUpload('file'), makeConvertRoute('pdf', '.pptx', 'application/pdf'));

// --- PDF compression with target size ---
app.post('/compress-pdf', rateLimit, trackedUpload('file'), (req, res) => {
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
    const inputDir = '/tmp/compress_' + uuidv4();
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
      const maxAttempts = 5;

      while (low <= high && attempts < maxAttempts) {
        const mid = Math.round((low + high) / 2);
        attempts += 1;

        const attemptOutput = path.join(inputDir, 'attempt_' + mid + '.pdf');
        try {
          await runGhostscript(inputPath, attemptOutput, mid);
        } catch (e) {
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
      console.error('Compression error:', error);
      sendLegacy500(res, 'Compression failed');
    } finally {
      state.phase = 'settled';
      cleanupOnce();
    }
  }).catch(() => {
    sendLegacy500(res, 'Compression failed');
    cleanupOnce();
  });
});

httpServer = app.listen(PORT, () => {
  console.log(`Converter server running on port ${PORT}`);
});
