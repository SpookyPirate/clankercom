/**
 * package-app.js — Freeze the app into dist/ClankerCom-win32-x64.
 *
 * This exists rather than a one-line electron-packager invocation because the
 * CLI form was silently shipping a broken build.
 *
 * npm scripts run through cmd.exe on Windows, where `^` is the escape
 * character. `--ignore=^/dist` therefore reached the packager as `/dist` —
 * unanchored — which matched every nested `dist` directory in the dependency
 * tree. The MCP SDK's entire `dist/` was stripped, the packaged app threw
 * "Cannot find module …/sdk/dist/cjs/server/mcp.js" on load, and the window
 * opened with no hub behind it. Nothing in the build output said so.
 *
 * Expressing the patterns as real regexes in Node removes the shell from the
 * path entirely.
 *
 * Run by: npm run build:app
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');

/**
 * Anchored to the project root, so a pattern can never match the same name
 * nested inside node_modules. Paths arrive with a leading slash.
 */
const IGNORE = [
  /^\/dist($|\/)/,
  /^\/dist-bridge($|\/)/,
  /^\/docs($|\/)/,
  // scripts/ is developer tooling and stays out — except listen.js, which is
  // how an installed agent stays reachable while idle. The README tells people
  // to run it, so it has to be in the thing they download. Note this ignores
  // the directory's *children*, not the directory itself: ignoring `/scripts`
  // outright would drop everything inside it regardless of this exception.
  /^\/scripts\/(?!listen\.js$)/,
  /^\/\.git($|\/)/,
  /\.md$/,
];

/**
 * Build from an already-downloaded Electron zip when one is available.
 *
 * The packager fetches the Electron binary from GitHub every build. On a
 * machine where outbound HTTPS is blocked or GitHub is having a bad day, that
 * fails with a 503 and takes the whole release with it — even though the exact
 * zip is sitting in the local cache, because the cache lookup still wants to
 * check a remote checksum first.
 *
 * Pointing at the cached file skips the network entirely. Falls back to the
 * normal download when there is nothing cached, so a clean machine still works.
 */
function cachedElectronZip() {
  const version = require('electron/package.json').version;
  const wanted = `electron-v${version}-win32-x64.zip`;
  const cacheRoot =
    process.env.ELECTRON_CACHE ||
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');

  if (!fs.existsSync(cacheRoot)) return null;
  for (const entry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, entry, wanted);
    if (fs.existsSync(candidate)) return path.join(cacheRoot, entry);
  }
  return null;
}

const zipDir = cachedElectronZip();
if (zipDir) console.log(`Using cached Electron from ${zipDir}`);

packager({
  dir: ROOT,
  ...(zipDir ? { electronZipDir: zipDir } : {}),
  name: 'ClankerCom',
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  icon: path.join(ROOT, 'build', 'icon.ico'),
  // Both live beside the asar as real files. The listener in particular has to
  // be runnable by a user who downloaded a zip: packed inside app.asar it is
  // invisible to plain Node, and the README tells people to run it.
  extraResource: [
    path.join(ROOT, 'dist-bridge', 'clankercom-bridge.exe'),
    path.join(ROOT, 'dist-bridge', 'clankercom-listen.exe'),
  ],
  ignore: IGNORE,
})
  .then(([appPath]) => {
    console.log(`Packaged to ${appPath}`);
  })
  .catch((error) => {
    console.error('Packaging failed:', error);
    process.exit(1);
  });
