// Minimal PNG-to-ICO converter. ICO (Vista+) supports embedding PNG data directly,
// so we wrap the source PNG in an ICO header without re-encoding.
//
// Usage: node png-to-ico.js <source.png> <out.ico>

const fs = require('fs');

const [, , src, dst] = process.argv;
if (!src || !dst) {
  console.error('Usage: node png-to-ico.js <source.png> <out.ico>');
  process.exit(1);
}

const png = fs.readFileSync(src);
if (png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  console.error('Source is not a valid PNG.');
  process.exit(1);
}

const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);

const ICONDIR = Buffer.alloc(6);
ICONDIR.writeUInt16LE(0, 0);
ICONDIR.writeUInt16LE(1, 2);
ICONDIR.writeUInt16LE(1, 4);

const ENTRY = Buffer.alloc(16);
ENTRY.writeUInt8(width >= 256 ? 0 : width, 0);
ENTRY.writeUInt8(height >= 256 ? 0 : height, 1);
ENTRY.writeUInt8(0, 2);
ENTRY.writeUInt8(0, 3);
ENTRY.writeUInt16LE(1, 4);
ENTRY.writeUInt16LE(32, 6);
ENTRY.writeUInt32LE(png.length, 8);
ENTRY.writeUInt32LE(22, 12);

fs.writeFileSync(dst, Buffer.concat([ICONDIR, ENTRY, png]));
console.log(`Wrote ${dst} (${width}x${height}, ${png.length} bytes embedded)`);
