/**
 * package-zip.js — Wrap the packaged app into the distributable archive.
 *
 * Exists so the version in the archive name is read from package.json rather
 * than interpolated by the shell. A hardcoded or shell-expanded version drifts
 * silently; a release then ships a zip whose name disagrees with the app
 * inside it.
 *
 * Run by: npm run build:zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { version } = require('../package.json');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'dist', 'ClankerCom-win32-x64');
const ARCHIVE = path.join(ROOT, 'dist', `clankercom-${version}-win-x64.zip`);

if (!fs.existsSync(SOURCE_DIR)) {
  console.error(
    `No packaged app at ${SOURCE_DIR}.\n` +
      `Run "npm run build:app" first, or "npm run build" for the whole pipeline.`
  );
  process.exit(1);
}

// Compress-Archive is used rather than a bundled zip library to keep the
// dependency list to what the app itself needs.
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${SOURCE_DIR}\\*' -DestinationPath '${ARCHIVE}' -Force`,
  ],
  { stdio: 'inherit' }
);

const sizeMb = (fs.statSync(ARCHIVE).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt ${path.basename(ARCHIVE)} (${sizeMb} MB)`);
console.log(`Publish with: gh release create v${version} "${ARCHIVE}" --title "ClankerCom v${version}"`);
