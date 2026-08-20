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

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: 50 * 1024 * 1024 }
});

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
    jobQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  if (activeJobs >= MAX_CONCURRENT || jobQueue.length === 0) return;
  const { fn, resolve, reject } = jobQueue.shift();
  activeJobs += 1;
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => {
      activeJobs -= 1;
      pumpQueue();
    });
}

// --- helpers ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
from docx import Document
from docx.shared import Pt

cv = Converter(sys.argv[1])
cv.convert(sys.argv[2])
cv.close()

doc = Document(sys.argv[2])
for para in doc.paragraphs:
    for run in para.runs:
        run.font.size = Pt(8)
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                for run in para.runs:
                    run.font.size = Pt(8)
doc.save(sys.argv[2])
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

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}

function tempSweep() {
  const cutoff = Date.now() - 3600 * 1000;
  for (const prefix of ['convert_', 'compress_']) {
    try {
      for (const entry of fs.readdirSync('/tmp')) {
        if (!entry.startsWith(prefix)) continue;
        const full = path.join('/tmp', entry);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) cleanTempDir(full);
        } catch (e) {
          /* entry vanished, ignore */
        }
      }
    } catch (e) {
      /* /tmp unreadable, ignore */
    }
  }
}
setInterval(tempSweep, 30 * 60 * 1000).unref();
tempSweep();

function requireUploadedFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return null;
  }
  return req.file;
}

function sendFileResponse(res, inputDir, filePath, contentType, downloadName) {
  if (!fs.existsSync(filePath)) {
    cleanTempDir(inputDir);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed: output file not created' });
    else res.end();
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"');
  const fileStream = fs.createReadStream(filePath);
  fileStream.on('error', (err) => {
    console.error('FileStream error:', err);
    cleanTempDir(inputDir);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    else res.end();
  });
  fileStream.pipe(res);
  const cleanup = () => cleanTempDir(inputDir);
  res.on('finish', cleanup);
  res.on('close', cleanup);
}

// --- document conversions ---
function makeConvertRoute(outputFormat, defaultExt, contentType) {
  return (req, res) => {
    const file = requireUploadedFile(req, res);
    if (!file) return;

    runLimited(async () => {
      const inputDir = '/tmp/convert_' + uuidv4();
      fs.mkdirSync(inputDir, { recursive: true });
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
        sendFileResponse(res, inputDir, outputPath, contentType, downloadName);
      } catch (error) {
        cleanTempDir(inputDir);
        console.error('Conversion error:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
        else res.end();
      }
    }).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
      else res.end();
    });
  };
}

app.post('/convert/word-to-pdf', rateLimit, upload.single('file'), makeConvertRoute('pdf', '.docx', 'application/pdf'));
app.post('/convert/pdf-to-word', rateLimit, upload.single('file'), makeConvertRoute('docx', '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
app.post('/convert/excel-to-pdf', rateLimit, upload.single('file'), makeConvertRoute('pdf', '.xlsx', 'application/pdf'));
app.post('/convert/ppt-to-pdf', rateLimit, upload.single('file'), makeConvertRoute('pdf', '.pptx', 'application/pdf'));

// --- PDF compression with target size ---
app.post('/compress-pdf', rateLimit, upload.single('file'), (req, res) => {
  const file = requireUploadedFile(req, res);
  if (!file) return;

  runLimited(async () => {
    const targetSizeKB = parseInt(req.body.targetSize, 10) || 500;
    const targetBytes = targetSizeKB * 1024;
    const inputDir = '/tmp/compress_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, 'input.pdf');
    const outputPath = path.join(inputDir, 'output.pdf');
    fs.renameSync(file.path, inputPath);

    try {
      const originalSize = fs.statSync(inputPath).size;

      if (originalSize <= targetBytes) {
        sendFileResponse(res, inputDir, inputPath, 'application/pdf', 'compressed.pdf');
        return;
      }

      const resolutions = [200, 150, 100, 72, 50, 30];
      let bestPath = null;
      let bestSize = Infinity;

      for (const dpi of resolutions) {
        const attemptOutput = path.join(inputDir, 'attempt_' + dpi + '.pdf');
        try {
          await runGhostscript(inputPath, attemptOutput, dpi);
        } catch (e) {
          continue;
        }

        if (!fs.existsSync(attemptOutput)) continue;

        const attemptSize = fs.statSync(attemptOutput).size;

        if (attemptSize < bestSize) {
          bestSize = attemptSize;
          bestPath = attemptOutput;
        }

        if (attemptSize <= targetBytes) break;
      }

      if (!bestPath) {
        throw new Error('Compression failed');
      }

      if (bestPath !== outputPath) {
        fs.copyFileSync(bestPath, outputPath);
      }

      sendFileResponse(res, inputDir, outputPath, 'application/pdf', 'compressed.pdf');
    } catch (error) {
      cleanTempDir(inputDir);
      console.error('Compression error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Compression failed' });
      else res.end();
    }
  }).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Compression failed' });
    else res.end();
  });
});

app.listen(PORT, () => {
  console.log(`Converter server running on port ${PORT}`);
});
