require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const cors = require('cors');
const tmp = require('tmp');
const { FileConverter } = require('multi-format-converter');
const imgToPDFModule = require('image-to-pdf');
const { exec } = require('child_process');
const util = require('util');
const { fileTypeFromBuffer } = require('file-type');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const libre = require('libreoffice-convert');
const { fromPath } = require('pdf2pic');
const sevenZip = require('node-7z');

const execPromise = util.promisify(exec);

// Determine the correct imgToPDF function
let imgToPDF = imgToPDFModule;
if (typeof imgToPDFModule !== 'function' && imgToPDFModule.default && typeof imgToPDFModule.default === 'function') {
  console.log('Using imgToPDFModule.default as imgToPDF function');
  imgToPDF = imgToPDFModule.default;
}

// Patch pdf-parse to handle ENOENT error
let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (err) {
  console.warn('pdf-parse initialization failed:', err.message);
  pdfParse = { renderPage: () => Promise.resolve(Buffer.from('')) };
}

const app = express();
const port = process.env.PORT || 5000;
const conversionTimeout = parseInt(process.env.CONVERSION_TIMEOUT) || 120000;

// Check for dependencies
async function checkDependencies() {
  const checks = [
    { name: 'GraphicsMagick', command: 'gm version' },
    { name: 'ImageMagick', command: 'convert -version' },
    { name: 'poppler-utils', command: 'pdftoppm -v' },
    { name: 'libvips', command: 'vips --version' },
    { name: 'ffmpeg', command: 'ffmpeg -version' },
  ];
  const results = {};

  for (const { name, command } of checks) {
    try {
      await execPromise(command);
      console.log(`${name} is installed and available`);
      results[name] = true;
    } catch (err) {
      console.warn(`${name} not found:`, err.message);
      results[name] = false;
    }
  }

  // Check module dependencies
  const modules = [
    { name: 'file-type', module: 'file-type' },
    { name: 'image-to-pdf', module: 'image-to-pdf' },
    { name: 'fluent-ffmpeg', module: 'fluent-ffmpeg' },
    { name: 'sharp', module: 'sharp' },
    { name: 'libreoffice-convert', module: 'libreoffice-convert' },
    { name: 'pdf2pic', module: 'pdf2pic' },
    { name: 'node-7z', module: 'node-7z' },
  ];

  for (const { name, module } of modules) {
    try {
      require(module);
      console.log(`${name} module is installed and available`);
      results[name] = true;
    } catch (err) {
      console.warn(`${name} module not found:`, err.message);
      results[name] = false;
    }
  }

  return results;
}

// Log environment variables and dependency status
(async () => {
  console.log('Environment variables:', {
    PORT: process.env.PORT,
    FRONTEND_URL: process.env.FRONTEND_URL,
    CONVERSION_TIMEOUT: process.env.CONVERSION_TIMEOUT,
    NODE_ENV: process.env.NODE_ENV,
  });
  const dependencies = await checkDependencies();
  if (!dependencies['poppler-utils']) {
    console.error('Critical: poppler-utils is not installed. PDF to image conversions will fail.');
  }
  if (!dependencies['ImageMagick']) {
    console.error('Critical: ImageMagick is not installed. GIF conversions will fail.');
  }
  if (!dependencies['file-type']) {
    console.error('Critical: file-type module is not installed. Image validation will fail.');
  }
  if (!dependencies['image-to-pdf']) {
    console.error('Critical: image-to-pdf module is not installed. Image to PDF conversions will fail.');
  }
  if (!dependencies['libvips']) {
    console.error('Critical: libvips is not installed. Image to PDF conversions may fail.');
  }
  if (!dependencies['ffmpeg']) {
    console.error('Critical: ffmpeg is not installed. Audio/Video conversions will fail.');
  }
})();

// Configure CORS for live deployment
const allowedOrigins = [
  ...(process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : ['http://localhost:5173', 'https://nion-ochre.vercel.app']),
];
const uniqueAllowedOrigins = [...new Set(allowedOrigins)];
if (!uniqueAllowedOrigins.includes('http://localhost:5173')) {
  uniqueAllowedOrigins.push('http://localhost:5173');
}
if (!uniqueAllowedOrigins.includes('https://nion-ochre.vercel.app')) {
  uniqueAllowedOrigins.push('https://nion-ochre.vercel.app');
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || uniqueAllowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error(`CORS request blocked from origin: ${origin}. Allowed origins: ${uniqueAllowedOrigins.join(', ')}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Middleware to log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.get('Origin') || 'unknown'}`);
  res.setHeader('X-Powered-By', 'File-Converter');
  next();
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'File Converter Backend is running',
    version: '1.0.0',
    allowedOrigins: uniqueAllowedOrigins,
    timestamp: new Date().toISOString(),
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.status(200).json({
    message: 'Server is running',
    allowedOrigins: uniqueAllowedOrigins,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  });
});

// Initialize FileConverter
let converter;
try {
  converter = new FileConverter({ pdfParse });
  console.log('FileConverter initialized successfully');
} catch (err) {
  console.error('Failed to initialize FileConverter:', err.message, err.stack);
  process.exit(1);
}

// Supported formats
const allFormats = [
  'bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg',
  'pdf', 'docx', 'txt', 'rtf', 'odt',
  'mp3', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma',
  'mp4', 'avi', 'mov', 'webm', 'mkv', 'flv', 'wmv',
  'zip', '7z',
  'epub', 'mobi', 'azw3',
  'aac', 'aiff', 'm4v', 'mmf', 'wma', '3g2',
];

const supportedFormats = {
  image: ['bmp', 'eps', 'ico', 'svg', 'tga', 'wbmp', 'jpg', 'png', 'gif', 'tiff', 'webp', 'pdf'],
  compressor: ['jpg', 'png', 'svg'],
  pdfs: ['jpg', 'png', 'gif', 'docx', 'pdf', 'txt', 'rtf', 'odt'],
  audio: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'm4v', 'mmf', '3g2'],
  video: ['mp4', 'avi', 'mov', 'webm', 'mkv', 'flv', 'wmv'],
  document: ['docx', 'pdf', 'txt', 'rtf', 'odt'],
  archive: ['zip', '7z'],
  ebook: ['epub', 'mobi', 'azw3'],
};

const supportedImageToPdfFormats = ['jpg', 'jpeg', 'png'];

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
    console.log('Directories created:', { uploadsDir, convertedDir });
  } catch (err) {
    console.error('Error creating directories:', err.message, err.stack);
    throw new Error('Failed to initialize server directories.');
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', allowedOrigins: uniqueAllowedOrigins, timestamp: new Date().toISOString() });
});

// Validation functions
async function validateImage(inputPath) {
  try {
    const buffer = await fsPromises.readFile(inputPath);
    const type = await fileTypeFromBuffer(buffer);
    if (!type || !supportedImageToPdfFormats.includes(type.ext.toLowerCase())) {
      throw new Error(`Invalid or unsupported image format: ${type ? type.ext : 'unknown'}. Supported formats: ${supportedImageToPdfFormats.join(', ')}`);
    }
    console.log(`Image validation successful for ${inputPath}: ${type.ext}`);
    return true;
  } catch (err) {
    console.error(`Image validation failed for ${inputPath}: ${err.message}`);
    return false;
  }
}

async function validatePDF(inputPath) {
  try {
    const dataBuffer = await fsPromises.readFile(inputPath);
    await pdfParse(dataBuffer);
    console.log(`PDF validation successful for ${inputPath}`);
    return true;
  } catch (err) {
    console.error(`PDF validation failed for ${inputPath}: ${err.message}`);
    return false;
  }
}

// Conversion helper functions
async function convertImageToPDF(inputPath, outputPath) {
  try {
    const isValidImage = await validateImage(inputPath);
    if (!isValidImage) {
      throw new Error(`Invalid image file: ${inputPath}`);
    }
    console.log('imgToPDF type:', typeof imgToPDF, 'isFunction:', typeof imgToPDF === 'function');
    if (typeof imgToPDF !== 'function') {
      throw new Error('imgToPDF is not a function. Check image-to-pdf module installation.');
    }
    const imgStream = fs.createReadStream(inputPath);
    const pdfStream = fs.createWriteStream(outputPath);
    await new Promise((resolve, reject) => {
      imgToPDF([inputPath], 'A4').pipe(pdfStream);
      pdfStream.on('finish', () => {
        console.log(`Converted image to PDF: ${outputPath}`);
        resolve();
      });
      pdfStream.on('error', (err) => {
        console.error(`PDF stream error: ${err.message}`);
        reject(new Error(`Failed to write PDF: ${err.message}`));
      });
      imgStream.on('error', (err) => {
        console.error(`Image stream error: ${err.message}`);
        reject(new Error(`Failed to read image: ${err.message}`));
      });
    });
  } catch (err) {
    console.error(`Image to PDF conversion failed: ${err.message}`);
    throw new Error(`Failed to convert image to PDF: ${err.message}`);
  }
}

async function convertPngToGif(inputPath, outputPath) {
  try {
    await execPromise(`convert "${inputPath}" "${outputPath}"`);
    console.log(`Converted PNG to GIF: ${outputPath}`);
  } catch (err) {
    console.error(`PNG to GIF conversion failed: ${err.message}`);
    throw new Error(`Failed to convert PNG to GIF: ${err.message}`);
  }
}

async function convertImage(inputPath, outputPath, format) {
  const imageFormats = ['bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg'];
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  if (!imageFormats.includes(inputExt) && ['pdf', 'docx', 'txt', 'rtf', 'odt'].includes(inputExt)) {
    const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
    try {
      await convertDocument(inputPath, tempPdfPath, 'pdf');
      await convertImage(tempPdfPath, outputPath, format);
      await fsPromises.unlink(tempPdfPath).catch(err => console.error(`Error cleaning up temp PDF: ${err.message}`));
    } catch (err) {
      console.error(`Image conversion preprocessing failed: ${err.message}`);
      throw err;
    }
    return;
  }
  if (imageFormats.includes(format)) {
    await sharp(inputPath)
      .toFormat(format)
      .toFile(outputPath);
    console.log(`Image conversion completed: ${outputPath}`);
  } else if (format === 'pdf' || format === 'docx') {
    let tempPdfPath;
    try {
      if (format === 'pdf') {
        tempPdfPath = outputPath;
      } else {
        tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
      }
      await convertImageToPDF(inputPath, tempPdfPath);
      if (format === 'docx') {
        const pdfBuffer = await fsPromises.readFile(tempPdfPath);
        await new Promise((resolve, reject) => {
          libre.soffice = process.env.LIBREOFFICE_PATH || 'soffice'; // Use env variable or default
          tmp.dir({ unsafeCleanup: true }, (err, tempDir, cleanupCallback) => {
            if (err) return reject(new Error(`Failed to create temporary directory: ${err.message}`));
            libre.convert(pdfBuffer, '.docx', { tmpDir: tempDir }, (err, docxBuffer) => {
              if (err) {
                cleanupCallback();
                return reject(new Error(`PDF to DOCX conversion failed: ${err.message}`));
              }
              fsPromises.writeFile(outputPath, docxBuffer)
                .then(() => {
                  cleanupCallback();
                  resolve();
                })
                .catch((writeErr) => {
                  cleanupCallback();
                  reject(writeErr);
                });
            });
          });
        });
        await fsPromises.unlink(tempPdfPath).catch(err => console.error(`Error cleaning up temp PDF: ${err.message}`));
      }
      console.log(`Image conversion to ${format} completed: ${outputPath}`);
    } catch (err) {
      if (tempPdfPath && format === 'docx') {
        await fsPromises.unlink(tempPdfPath).catch(err => console.error(`Error cleaning up temp PDF: ${err.message}`));
      }
      throw err;
    }
  } else {
    throw new Error(`Unsupported image output format: ${format}`);
  }
}

async function convertPdf(inputPath, outputPath, format) {
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  if (inputExt !== 'pdf') {
    const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
    try {
      await convertDocument(inputPath, tempPdfPath, 'pdf');
      await convertPdf(tempPdfPath, outputPath, format);
      await fsPromises.unlink(tempPdfPath).catch(err => console.error(`Error cleaning up temp PDF: ${err.message}`));
    } catch (err) {
      console.error(`PDF conversion preprocessing failed: ${err.message}`);
      throw err;
    }
    return;
  }
  if (['jpg', 'png', 'gif'].includes(format)) {
    try {
      const isValidPDF = await validatePDF(inputPath);
      if (!isValidPDF) {
        throw new Error(`Invalid or corrupted PDF file: ${inputPath}`);
      }
      const outputBaseName = path.basename(inputPath, '.pdf');
      const tempOutputPath = path.join(convertedDir, `${outputBaseName}`);
      let formatOption = format === 'jpg' ? '-jpeg' : `-${format}`;
      if (format === 'gif') {
        formatOption = '-png';
        const tempPngPath = path.join(convertedDir, `${outputBaseName}.png`);
        await execPromise(`pdftoppm -png -singlefile "${inputPath}" "${tempOutputPath}"`);
        if (await fsPromises.access(tempPngPath).then(() => true).catch(() => false)) {
          await convertPngToGif(tempPngPath, outputPath);
          await fsPromises.unlink(tempPngPath).catch(err => console.error(`Error cleaning up temp PNG: ${err.message}`));
        } else {
          throw new Error(`PDF to PNG intermediate output not found: ${tempPngPath}`);
        }
      } else {
        await execPromise(`pdftoppm ${formatOption} -singlefile "${inputPath}" "${tempOutputPath}"`);
        const generatedPath = path.join(convertedDir, `${outputBaseName}.${format}`);
        if (await fsPromises.access(generatedPath).then(() => true).catch(() => false)) {
          await fsPromises.rename(generatedPath, outputPath);
        } else {
          throw new Error(`PDF to image output not found: ${generatedPath}`);
        }
      }
    } catch (pdfError) {
      throw new Error(`PDF to image conversion failed for ${inputPath} to ${format}: ${pdfError.message}`);
    }
  } else if (format === 'docx') {
    const pdfBuffer = await fsPromises.readFile(inputPath);
    await new Promise((resolve, reject) => {
      libre.soffice = process.env.LIBREOFFICE_PATH || 'soffice'; // Use env variable or default
      tmp.dir({ unsafeCleanup: true }, (err, tempDir, cleanupCallback) => {
        if (err) return reject(new Error(`Failed to create temporary directory: ${err.message}`));
        libre.convert(pdfBuffer, '.docx', { tmpDir: tempDir }, (err, docxBuffer) => {
          if (err) {
            cleanupCallback();
            return reject(new Error(`PDF to DOCX conversion failed: ${err.message}`));
          }
          fsPromises.writeFile(outputPath, docxBuffer)
            .then(() => {
              cleanupCallback();
              resolve();
            })
            .catch((writeErr) => {
              cleanupCallback();
              reject(writeErr);
            });
        });
      });
    });
    console.log(`PDF to DOCX conversion completed: ${outputPath}`);
  } else {
    throw new Error(`Unsupported PDF output format: ${format}`);
  }
}

async function convertDocument(inputPath, outputPath, format) {
  const inputExt = path.extname(inputPath).toLowerCase().slice(1);
  const supportedDocumentFormats = ['docx', 'pdf', 'txt', 'rtf', 'odt'];
  if (['bmp', 'eps', 'gif', 'ico', 'png', 'svg', 'tga', 'tiff', 'wbmp', 'webp', 'jpg', 'jpeg'].includes(inputExt)) {
    const tempPdfPath = path.join(convertedDir, `temp_${Date.now()}.pdf`);
    try {
      await convertImageToPDF(inputPath, tempPdfPath);
      await convertDocument(tempPdfPath, outputPath, format);
      await fsPromises.unlink(tempPdfPath).catch(err => console.error(`Error cleaning up temp PDF: ${err.message}`));
    } catch (err) {
      console.error(`Document conversion preprocessing failed: ${err.message}`);
      throw err;
    }
    return;
  }
  if (!supportedDocumentFormats.includes(format)) {
    throw new Error(`Unsupported output document format: ${format}`);
  }
  const buffer = await fsPromises.readFile(inputPath);
  await new Promise((resolve, reject) => {
    libre.soffice = process.env.LIBREOFFICE_PATH || 'soffice'; // Use env variable or default
    tmp.dir({ unsafeCleanup: true }, (err, tempDir, cleanupCallback) => {
      if (err) return reject(new Error(`Failed to create temporary directory: ${err.message}`));
      libre.convert(buffer, `.${format}`, { tmpDir: tempDir }, (err, convertedBuf) => {
        if (err) {
          cleanupCallback();
          return reject(new Error(`Document conversion failed: ${err.message}`));
        }
        fsPromises.writeFile(outputPath, convertedBuf)
          .then(() => {
            cleanupCallback();
            resolve();
          })
          .catch((writeErr) => {
            cleanupCallback();
            reject(writeErr);
          });
      });
    });
  });
  console.log(`Document conversion completed: ${outputPath}`);
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

async function convertCompressor(inputPath, outputPath, format) {
  if (format === 'svg') {
    await converter.compressSvg({ input: inputPath, output: outputPath });
  } else if (['jpg', 'png'].includes(format)) {
    await sharp(inputPath)
      .toFormat(format, { quality: 80 })
      .toFile(outputPath);
    console.log(`Image compression completed: ${outputPath}`);
  } else {
    throw new Error(`Unsupported compressor output format: ${format}`);
  }
}

// Conversion route
app.post('/api/convert', upload.array('files', 5), async (req, res) => {
  console.log('Received /api/convert request', {
    files: req.files ? req.files.map(f => f.originalname) : [],
    formats: req.body.formats,
  });
  let tempFiles = req.files ? req.files.map(f => f.path) : [];
  try {
    await ensureDirectories();
    const files = req.files;
    let formats;
    try {
      formats = JSON.parse(req.body.formats || '[]');
      console.log('Parsed formats:', formats);
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
      const conversionType = formatInfo.type;

      if (!formatInfo.type || !outputExt) {
        throw new Error('Invalid format information: type and target are required.');
      }
      if (!Object.keys(supportedFormats).includes(conversionType)) {
        throw new Error(`Unsupported conversion type: ${conversionType}. Supported types: ${Object.keys(supportedFormats).join(', ')}`);
      }
      if (!supportedFormats[conversionType].includes(outputExt)) {
        throw new Error(`Unsupported output format: ${outputExt} for type ${conversionType}. Supported formats: ${supportedFormats[conversionType].join(', ')}`);
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

      // Validate input based on conversion type
      if (conversionType === 'pdfs' && inputExt === 'pdf') {
        const isValidPDF = await validatePDF(inputPath);
        if (!isValidPDF) {
          throw new Error(`Invalid or corrupted PDF file: ${file.originalname}`);
        }
      } else if (conversionType === 'image' && outputExt === 'pdf') {
        const isValidImage = await validateImage(inputPath);
        if (!isValidImage) {
          throw new Error(`Invalid or unsupported image file: ${file.originalname}`);
        }
      }

      console.log(`Converting ${file.originalname} to ${outputExt} (type: ${conversionType})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error('Conversion timed out'));
      }, conversionTimeout);

      try {
        switch (conversionType) {
          case 'image':
            await convertImage(inputPath, outputPath, outputExt);
            break;
          case 'compressor':
            await convertCompressor(inputPath, outputPath, outputExt);
            break;
          case 'pdfs':
            await convertPdf(inputPath, outputPath, outputExt);
            break;
          case 'audio':
          case 'video':
            await convertMedia(inputPath, outputPath, outputExt);
            break;
          case 'document':
            await convertDocument(inputPath, outputPath, outputExt);
            break;
          case 'archive':
            await convertArchive(inputPath, outputPath, outputExt);
            break;
          case 'ebook':
            await convertEbook(inputPath, outputPath, outputExt);
            break;
          default:
            throw new Error(`Unsupported conversion type: ${conversionType}`);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      outputFiles.push({
        path: outputPath,
        name: path.basename(outputPath),
      });
      tempFiles.push(outputPath);
    }

    res.json({
      files: outputFiles.map(file => ({
        name: file.name,
        path: `/converted/${file.name}`,
      })),
    });
  } catch (error) {
    console.error('Conversion error:', error.message, error.stack);
    res.status(500).json({ error: error.message || 'Conversion failed.' });
  } finally {
    await cleanupFiles(tempFiles.filter(file => file.startsWith(uploadsDir)));
  }
});

// Serve converted files
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

// Cleanup files with retry logic
async function cleanupFiles(filePaths) {
  const maxRetries = 3;
  const retryDelay = 1000;
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
          console.error(`Error deleting file ${filePath}:`, err.message);
          break;
        }
      }
    }
  }
}

// Periodic cleanup of old files
setInterval(async () => {
  try {
    const files = await fsPromises.readdir(convertedDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(convertedDir, file);
      const stats = await fsPromises.stat(filePath);
      if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
        await cleanupFiles([filePath]);
      }
    }
  } catch (err) {
    console.error('Error in periodic cleanup:', err.message);
  }
}, 60 * 60 * 1000);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start server
async function startServer() {
  try {
    await ensureDirectories();
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
      console.log(`CORS allowed origins: ${uniqueAllowedOrigins.join(', ')}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message, err.stack);
    process.exit(1);
  }
}

startServer();