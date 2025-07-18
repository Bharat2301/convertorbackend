require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const cors = require('cors');
const tmp = require('tmp');
const { FileConverter } = require('multi-format-converter');

// Patch pdf-parse to handle ENOENT error
let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (err) {
  console.warn('pdf-parse initialization failed:', err.message);
  pdfParse = { renderPage: () => Promise.resolve(Buffer.from('')) };
}

const app = express();
const port = process.env.PORT || 5001;
const conversionTimeout = parseInt(process.env.CONVERSION_TIMEOUT) || 120000;

// Log environment variables for debugging
console.log('Environment variables:', {
  PORT: process.env.PORT,
  FRONTEND_URL: process.env.FRONTEND_URL,
  CONVERSION_TIMEOUT: process.env.CONVERSION_TIMEOUT,
  NODE_ENV: process.env.NODE_ENV,
});

// Configure CORS with multiple allowed origins
const allowedOrigins = [
  ...(process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : ['http://localhost:5173', 'https://nion-ochre.vercel.app']),
];
const uniqueAllowedOrigins = [...new Set(allowedOrigins)]; // Remove duplicates
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

// Root endpoint to confirm server is running
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'File Converter Backend is running',
    version: '1.0.0',
    allowedOrigins: uniqueAllowedOrigins,
    timestamp: new Date().toISOString(),
  });
});

// Test endpoint to verify server status and CORS
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
  process.exit(1); // Exit to ensure Render logs the error
}

// Supported formats
const supportedFormats = {
  image: ['bmp', 'eps', 'ico', 'svg', 'tga', 'wbmp'],
  compressor: ['svg'],
  pdfs: ['jpg', 'png', 'gif', 'docx'],
  audio: ['aac', 'aiff', 'm4v', 'mmf', 'wma', '3g2'],
};

const allFormats = [
  ...supportedFormats.image,
  ...supportedFormats.compressor,
  ...supportedFormats.pdfs,
  ...supportedFormats.audio,
  'pdf',
];

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
      const outputExt = formatInfo.target?.toLowerCase();
      const conversionType = formatInfo.type;
      const subSection = formatInfo.subSection;

      if (!formatInfo.type || !outputExt || !subSection) {
        throw new Error('Invalid format information: type, subSection, and target are required.');
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

      console.log(`Converting ${file.originalname} to ${outputExt} (type: ${conversionType}, subSection: ${subSection})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error('Conversion timed out'));
      }, conversionTimeout);

      try {
        switch (conversionType) {
          case 'image':
            await converter.convertImage({ input: inputPath, output: outputPath, format: outputExt });
            break;
          case 'compressor':
            await converter.compressSvg({ input: inputPath, output: outputPath });
            break;
          case 'pdfs':
            if (['jpg', 'png', 'gif'].includes(outputExt)) {
              await converter.pdfToImage({ input: inputPath, output: convertedDir, format: outputExt });
              const outputBaseName = path.basename(inputPath, '.pdf');
              const generatedPath = path.join(convertedDir, `${outputBaseName}-1.${outputExt}`);
              if (await fsPromises.access(generatedPath).then(() => true).catch(() => false)) {
                await fsPromises.rename(generatedPath, outputPath);
              } else {
                throw new Error(`PDF to image output not found: ${generatedPath}`);
              }
            } else if (outputExt === 'docx') {
              await converter.pdfToWord({ input: inputPath, output: outputPath });
            }
            break;
          case 'audio':
            await converter.convertAudio({ input: inputPath, output: outputPath, format: outputExt });
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