require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const cors = require('cors');
const tmp = require('tmp');
const { exec } = require('child_process');
const sevenZip = require('node-7z');
const aspose = require('aspose.pdf');

const app = express();
const port = process.env.PORT || 5000;
const conversionTimeout = parseInt(process.env.CONVERSION_TIMEOUT) || 120000;

// Configure CORS with frontend URL
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));

// Apply Aspose.PDF license (optional)
const applyAsposeLicense = () => {
  try {
    const licensePath = path.join(__dirname, 'Aspose.PDF.Node.lic');
    if (fs.existsSync(licensePath)) {
      const license = new aspose.License();
      license.setLicense(licensePath);
      console.log('Aspose.PDF license applied successfully.');
    } else {
      console.warn('Aspose.PDF license not found. Running in trial mode (watermarks may be added).');
    }
  } catch (err) {
    console.error('Failed to apply Aspose.PDF license:', err.message);
  }
};
applyAsposeLicense();

// All supported formats
const allFormats = [
  'bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg',
  'pdf', 'docx', 'txt', 'rtf', 'odt',
  'mp3', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma',
  'mp4', 'avi', 'mov', 'webm', 'mkv', 'flv', 'wmv',
  'zip', '7z',
  'epub', 'mobi', 'azw3'
];

// Supported formats for each conversion type
const supportedFormats = {
  image: allFormats,
  compressor: ['jpg', 'png', 'svg'],
  pdfs: allFormats,
  audio: allFormats,
  video: allFormats,
  document: allFormats,
  archive: allFormats,
  ebook: allFormats,
};

// Configure multer
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = allFormats.map(ext => `.${ext.toLowerCase()}`);
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Supported types: ${allFormats.join(', ')}`), false);
    }
  },
});

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');

async function ensureDirectories() {
  try {
    await fsPromises.mkdir(uploadsDir, { recursive: true });
    await fsPromises.mkdir(convertedDir, { recursive: true });
  } catch (err) {
    console.error('Error creating directories:', err.message);
    throw new Error('Failed to initialize server directories.');
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Conversion route
app.post('/api/convert', upload.array('files', 5), async (req, res) => {
  console.log('Received /api/convert request');
  let tempFiles = req.files ? req.files.map(f => f.path) : [];
  try {
    await ensureDirectories();
    const files = req.files;
    let formats;
    try {
      formats = JSON.parse(req.body.formats || '[]');
    } catch (parseError) {
      console.error('Error parsing formats:', parseError.message);
      return res.status(400).json({ error: 'Invalid formats data. Please provide valid JSON.' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }
    if (files.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 files allowed.' });
    }
    if (files.length !== formats.length) {
      return res.status(400).json({
        error: `Mismatch between files (${files.length}) and formats (${formats.length})`,
      });
    }

    const outputFiles = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formatInfo = formats[i];
      const inputExt = path.extname(file.originalname).toLowerCase().slice(1) || 'unknown';
      const outputExt = formatInfo.target?.toLowerCase().split(' ')[0];

      // Validate inputs
      if (!formatInfo.type || !outputExt) {
        throw new Error('Invalid format information: type and target are required.');
      }
      if (!Object.keys(supportedFormats).includes(formatInfo.type)) {
        throw new Error(`Unsupported conversion type: ${formatInfo.type}. Supported types: ${Object.keys(supportedFormats).join(', ')}`);
      }
      if (!supportedFormats[formatInfo.type].includes(outputExt)) {
        throw new Error(`Unsupported output format: ${outputExt} for type ${formatInfo.type}. Supported formats: ${supportedFormats[formatInfo.type].join(', ')}`);
      }
      if (!allFormats.includes(inputExt)) {
        throw new Error(`Unsupported input format: ${inputExt}. Supported formats: ${allFormats.join(', ')}`);
      }

      const inputPath = path.resolve(file.path);
      const outputPath = path.resolve(
        convertedDir,
        `${path.basename(file.filename, path.extname(file.filename))}_${Date.now()}.${outputExt}`
      );

      try {
        await fsPromises.access(inputPath);
      } catch {
        throw new Error(`Input file not found: ${file.originalname}`);
      }

      const outputType = ['bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg'].includes(outputExt) ? 'image' :
        ['pdf', 'docx', 'txt', 'rtf', 'odt'].includes(outputExt) ? 'document' :
          ['mp3', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma'].includes(outputExt) ? 'audio' :
            ['mp4', 'avi', 'mov', 'webm', 'mkv', 'flv', 'wmv'].includes(outputExt) ? 'video' :
              ['zip', '7z'].includes(outputExt) ? 'archive' :
                ['epub', 'mobi', 'azw3'].includes(outputExt) ? 'ebook' : formatInfo.type;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error('Conversion timed out'));
      }, conversionTimeout);

      try {
        switch (outputType) {
          case 'image':
          case 'compressor':
            await convertImage(inputPath, outputPath, outputExt);
            break;
          case 'document':
            await convertDocument(inputPath, outputPath, outputExt);
            break;
          case 'pdfs':
            await convertPdf(inputPath, outputPath, outputExt);
            break;
          case 'audio':
          case 'video':
            await convertMedia(inputPath, outputPath, outputExt);
            break;
          case 'archive':
            await convertArchive(inputPath, outputPath, outputExt);
            break;
          case 'ebook':
            await convertEbook(inputPath, outputPath, outputExt);
            break;
          default:
            throw new Error(`Unsupported conversion type: ${outputType}`);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      outputFiles.push({
        path: outputPath,
        name: path.basename(outputPath),
      });
      tempFiles.push(outputPath); // Track output files
    }

    res.json({
      files: outputFiles.map(file => ({
        name: file.name,
        path: `/converted/${file.name}`,
      })),
    });
  } catch (error) {
    console.error('Conversion error:', error.message);
    res.status(500).json({ error: error.message || 'Conversion failed.' });
  } finally {
    // Cleanup only input files (uploads), keep converted files
    await cleanupFiles(tempFiles.filter(file => file.startsWith(uploadsDir)));
  }
});

// Serve converted files and delete after download
app.get('/converted/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.resolve(convertedDir, filename);
  console.log(`Serving file: ${filePath}`);
  try {
    await fsPromises.access(filePath);
    res.download(filePath, filename, async (err) => {
      if (err) {
        console.error('Error sending file:', err.message);
        res.status(500).json({ error: 'Failed to send converted file.' });
      } else {
        console.log(`File sent successfully: ${filePath}`);
        await cleanupFiles([filePath]);
      }
    });
  } catch (err) {
    console.error('File not found:', filePath, err.message);
    res.status(404).json({ error: 'Converted file not found.' });
  }
});

// Delete file endpoint
app.delete('/api/delete/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.resolve(convertedDir, filename);
  try {
    await cleanupFiles([filePath]);
    res.status(200).json({ message: `File ${filename} deleted successfully.` });
  } catch (err) {
    console.error(`Error deleting file ${filePath}:`, err.message);
    res.status(500).json({ error: `Failed to delete file ${filename}.` });
  }
});

// Conversion functions
async function convertImage(inputPath, outputPath, format) {
  const imageFormats = ['bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg'];
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  let tempFiles = [];

  try {
    if (!imageFormats.includes(inputExt) && ['pdf', 'docx', 'txt', 'rtf', 'odt'].includes(inputExt)) {
      const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      tempFiles.push(tempPdfPath);
      await convertDocument(inputPath, tempPdfPath, 'pdf');
      await convertImage(tempPdfPath, outputPath, format);
      return;
    }

    if (imageFormats.includes(format)) {
      await sharp(inputPath)
        .toFormat(format)
        .toFile(outputPath);
      console.log(`Image conversion completed: ${outputPath}`);
    } else if (format === 'pdf') {
      const document = new aspose.Document(inputPath);
      const pdfSaveOptions = new aspose.PdfSaveOptions();
      await document.save(outputPath, pdfSaveOptions);
      console.log(`Image to PDF conversion completed: ${outputPath}`);
    } else if (format === 'docx') {
      const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      tempFiles.push(tempPdfPath);
      const document = new aspose.Document(inputPath);
      const pdfSaveOptions = new aspose.PdfSaveOptions();
      await document.save(tempPdfPath, pdfSaveOptions);
      await convertPdf(tempPdfPath, outputPath, 'docx');
      console.log(`Image to DOCX conversion completed: ${outputPath}`);
    } else {
      throw new Error(`Unsupported image output format: ${format}`);
    }
  } catch (err) {
    console.error(`Image conversion error: ${err.message}`);
    throw new Error(`Image conversion failed: ${err.message}`);
  } finally {
    await cleanupFiles(tempFiles);
  }
}

async function convertPdf(inputPath, outputPath, format) {
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  let tempFiles = [];

  try {
    if (inputExt !== 'pdf') {
      const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      tempFiles.push(tempPdfPath);
      await convertDocument(inputPath, tempPdfPath, 'pdf');
      await convertPdf(tempPdfPath, outputPath, format);
      return;
    }

    const document = new aspose.Document(inputPath);
    if (['jpg', 'png', 'gif'].includes(format)) {
      const imageSaveOptions = new aspose.ImageSaveOptions(format.toUpperCase());
      imageSaveOptions.pageSet = new aspose.PageSet(0, -2000); // Convert all pages
      await document.save(outputPath, imageSaveOptions);
      console.log(`PDF to ${format} conversion completed: ${outputPath}`);
    } else if (format === 'docx') {
      const docxSaveOptions = new aspose.DocxSaveOptions();
      await document.save(outputPath, docxSaveOptions);
      console.log(`PDF to DOCX conversion completed: ${outputPath}`);
    } else {
      throw new Error(`Unsupported PDF output format: ${format}`);
    }
  } catch (err) {
    console.error(`PDF conversion error: ${err.message}`);
    throw new Error(`PDF conversion failed: ${err.message}`);
  } finally {
    await cleanupFiles(tempFiles);
  }
}

async function convertDocument(inputPath, outputPath, format) {
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  const supportedDocumentFormats = ['docx', 'pdf', 'txt', 'rtf', 'odt'];
  let tempFiles = [];

  try {
    if (!supportedDocumentFormats.includes(format)) {
      throw new Error(`Unsupported output document format: ${format}`);
    }

    if (inputExt === 'pdf') {
      await convertPdf(inputPath, outputPath, format);
      return;
    }

    if (['bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg'].includes(inputExt)) {
      const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      tempFiles.push(tempPdfPath);
      await convertImage(inputPath, tempPdfPath, 'pdf');
      await convertPdf(tempPdfPath, outputPath, format);
      return;
    }

    // For non-PDF document inputs, convert to PDF using Calibre, then to target format
    if (['docx', 'txt', 'rtf', 'odt'].includes(inputExt)) {
      const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      tempFiles.push(tempPdfPath);
      await convertEbook(inputPath, tempPdfPath, 'pdf');
      await convertPdf(tempPdfPath, outputPath, format);
    } else {
      throw new Error(`Unsupported document input format: ${inputExt}`);
    }
    console.log(`Document conversion completed: ${outputPath}`);
  } catch (err) {
    console.error(`Document conversion error: ${err.message}`);
    throw new Error(`Document conversion failed: ${err.message}`);
  } finally {
    await cleanupFiles(tempFiles);
  }
}

async function convertMedia(inputPath, outputPath, format) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat(format)
      .on('end', () => {
        console.log(`Media conversion completed: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`Media conversion error: ${err.message}`);
        reject(new Error(`Media conversion failed: ${err.message}`));
      })
      .save(outputPath);
  });
}

async function convertArchive(inputPath, outputPath, format) {
  if (format === 'zip' || format === '7z') {
    return new Promise((resolve, reject) => {
      sevenZip.add(outputPath, inputPath, { $raw: { '-t': format } })
        .on('end', () => {
          console.log(`Archive conversion completed: ${outputPath}`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`Archive conversion error: ${err.message}`);
          reject(new Error(`Archive conversion failed: ${err.message}`));
        });
    });
  } else {
    throw new Error(`Unsupported archive format: ${format}`);
  }
}

async function convertEbook(inputPath, outputPath, format) {
  return new Promise((resolve, reject) => {
    exec(`ebook-convert "${inputPath}" "${outputPath}"`, (err) => {
      if (err) {
        console.error(`Ebook conversion error: ${err.message}`);
        return reject(new Error(`Ebook conversion failed: ${err.message}`));
      }
      console.log(`Ebook conversion completed: ${outputPath}`);
      resolve();
    });
  });
}

async function cleanupFiles(filePaths) {
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second
  for (const filePath of filePaths) {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        await fsPromises.access(filePath);
        await fsPromises.unlink(filePath);
        console.log(`Deleted file: ${filePath}`);
        break;
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`File already deleted or does not exist: ${filePath}`);
          break;
        } else if (err.code === 'EPERM') {
          attempts++;
          console.warn(`EPERM error on attempt ${attempts} for ${filePath}. Retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          if (attempts === maxRetries) {
            console.error(`Failed to delete file ${filePath} after ${maxRetries} attempts: ${err.message}`);
          }
        } else {
          console.error(`Error deleting file ${filePath}: ${err.message}`);
          break;
        }
      }
    }
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start server
async function startServer() {
  try {
    await ensureDirectories();
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();