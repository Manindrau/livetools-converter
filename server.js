const express = require('express');
const multer = require('multer');
const cors = require('cors');
const libre = require('libreoffice-convert');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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

app.post('/convert/word-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path;
    const outputPath = `/tmp/output_${uuidv4()}.pdf`;

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.doc', '.docx'].includes(ext)) {
      fs.unlinkSync(inputPath);
      return res.status(400).json({ error: 'Only .doc and .docx files are supported' });
    }

    const inputBuffer = fs.readFileSync(inputPath);

    libre.convert(inputBuffer, '.pdf', undefined, (err, result) => {
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      if (err) {
        console.error('Conversion error:', err);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        return res.status(500).json({ error: 'Conversion failed: ' + err.message });
      }

      fs.writeFileSync(outputPath, result);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/convert/pdf-to-word', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path + '.pdf';
    fs.renameSync(req.file.path, inputPath);
    const outputPath = `/tmp/output_${uuidv4()}.docx`;

    const inputBuffer = fs.readFileSync(inputPath);

    libre.convert(inputBuffer, '.docx', undefined, (err, result) => {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

      if (err) {
        console.error('Conversion error:', err);
        return res.status(500).json({ error: 'Conversion failed: ' + err.message });
      }

      fs.writeFileSync(outputPath, result);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.docx')}"`);

      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/convert/excel-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path;
    const outputPath = `/tmp/output_${uuidv4()}.pdf`;

    const inputBuffer = fs.readFileSync(inputPath);

    libre.convert(inputBuffer, '.pdf', undefined, (err, result) => {
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      if (err) {
        console.error('Conversion error:', err);
        return res.status(500).json({ error: 'Conversion failed: ' + err.message });
      }

      fs.writeFileSync(outputPath, result);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/convert/ppt-to-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path;
    const outputPath = `/tmp/output_${uuidv4()}.pdf`;

    const inputBuffer = fs.readFileSync(inputPath);

    libre.convert(inputBuffer, '.pdf', undefined, (err, result) => {
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      if (err) {
        console.error('Conversion error:', err);
        return res.status(500).json({ error: 'Conversion failed: ' + err.message });
      }

      fs.writeFileSync(outputPath, result);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname.replace(/\.[^.]+$/, '.pdf')}"`);

      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Converter server running on port ${PORT}`);
});
