const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

function convertWithLibreOffice(inputPath, outputFormat) {
  const outputDir = path.dirname(inputPath);
  const cmd = `libreoffice --headless --convert-to ${outputFormat} --outdir "${outputDir}" "${inputPath}"`;
  execSync(cmd, { timeout: 60000 });
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.join(outputDir, baseName + '.' + outputFormat);
}

app.post('/convert/word-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputDir = '/tmp/convert_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const inputPath = path.join(inputDir, 'source' + ext);
    fs.renameSync(req.file.path, inputPath);

    const outputPath = convertWithLibreOffice(inputPath, 'pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.rmSync(inputDir, { recursive: true, force: true });
    });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed: ' + error.message });
  }
});

app.post('/convert/pdf-to-word', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputDir = '/tmp/convert_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, 'source.pdf');
    fs.renameSync(req.file.path, inputPath);

    const outputPath = convertWithLibreOffice(inputPath, 'docx');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.docx')}"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.rmSync(inputDir, { recursive: true, force: true });
    });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed: ' + error.message });
  }
});

app.post('/convert/excel-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputDir = '/tmp/convert_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const inputPath = path.join(inputDir, 'source' + ext);
    fs.renameSync(req.file.path, inputPath);

    const outputPath = convertWithLibreOffice(inputPath, 'pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.rmSync(inputDir, { recursive: true, force: true });
    });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed: ' + error.message });
  }
});

app.post('/convert/ppt-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputDir = '/tmp/convert_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const inputPath = path.join(inputDir, 'source' + ext);
    fs.renameSync(req.file.path, inputPath);

    const outputPath = convertWithLibreOffice(inputPath, 'pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.rmSync(inputDir, { recursive: true, force: true });
    });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed: ' + error.message });
  }
});

app.post('/compress-pdf', upload.single('file'), async (req, res) => {
  let inputDir = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const targetSizeKB = parseInt(req.body.targetSize) || 500;
    const targetBytes = targetSizeKB * 1024;
    inputDir = '/tmp/compress_' + uuidv4();
    fs.mkdirSync(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, 'input.pdf');
    const outputPath = path.join(inputDir, 'output.pdf');
    
    fs.renameSync(req.file.path, inputPath);

    const originalSize = fs.statSync(inputPath).size;

    if (originalSize <= targetBytes) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="compressed.pdf"`);
      fs.createReadStream(inputPath).pipe(res);
      res.on('finish', () => { if (inputDir) fs.rmSync(inputDir, { recursive: true, force: true }); });
      return;
    }

    const resolutions = [200, 150, 100, 72, 50, 30];
    let bestPath = null;
    let bestSize = Infinity;

    for (const dpi of resolutions) {
      const attemptOutput = path.join(inputDir, 'attempt_' + dpi + '.pdf');
      const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dNOPAUSE -dBATCH -dQUIET ` +
        `-dDownsampleColorImages=true -dDownsampleGrayImages=true -dDownsampleMonoImages=true ` +
        `-dColorImageResolution=${dpi} -dGrayImageResolution=${dpi} -dMonoImageResolution=${dpi} ` +
        `-dAutoFilterColorImages=false -dColorImageDownsampleType=/Bicubic ` +
        `-sOutputFile="${attemptOutput}" "${inputPath}"`;
      
      try {
        execSync(cmd, { timeout: 60000 });
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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compressed.pdf"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      if (inputDir) fs.rmSync(inputDir, { recursive: true, force: true });
    });

    fileStream.on('error', () => {
      if (inputDir) fs.rmSync(inputDir, { recursive: true, force: true });
    });
  } catch (error) {
    console.error('Compression error:', error);
    res.status(500).json({ error: 'Compression failed: ' + error.message });
    if (inputDir) fs.rmSync(inputDir, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`Converter server running on port ${PORT}`);
});
