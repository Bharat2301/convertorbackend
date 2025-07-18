<<<<<<< HEAD
Multi-Format Converter
A Node.js package for converting image, PDF, and audio files, with SVG compression capabilities.
Features

Image conversion (BMP, EPS, ICO, SVG, TGA, WBMP)
SVG compression
PDF to image conversion
PDF to Word (text) conversion
Audio conversion (AAC, AIFF, M4V, MMF, WMA, 3G2)

Installation
npm install multi-format-converter

Prerequisites

FFmpeg installed on your system for audio conversions
Node.js version >= 18

Usage
npx multi-format-converter <command> [options]

Commands

image - Convert image filesnpx multi-format-converter image -i input.jpg -o output.png -f png


compress-svg - Compress SVG filesnpx multi-format-converter compress-svg -i input.svg -o output.min.svg


pdf-to-image - Convert PDF to imagesnpx multi-format-converter pdf-to-image -i input.pdf -o output_dir -f png


pdf-to-word - Convert PDF to Wordnpx multi-format-converter pdf-to-word -i input.pdf -o output.docx


audio - Convert audio filesnpx multi-format-converter audio -i input.mp3 -o output.aac -f aac



Options

-i, --input <path>: Input file path
-o, --output <path>: Output file/directory path
-f, --format <format>: Target format (varies by command)

Development
# Clone the repository
git clone https://github.com/yourusername/multi-format-converter.git

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

License
MIT License
=======
# Packages
>>>>>>> f417f96535290e269420b018cd9bae42a0183889
