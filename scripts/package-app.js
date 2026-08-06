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
  /^\/scripts($|\/)/,
  /^\/\.git($|\/)/,
  /\.md$/,
];

packager({
  dir: ROOT,
  name: 'ClankerCom',
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  icon: path.join(ROOT, 'build', 'icon.ico'),
  extraResource: [path.join(ROOT, 'dist-bridge', 'clankercom-bridge.exe')],
  ignore: IGNORE,
})
  .then(([appPath]) => {
    console.log(`Packaged to ${appPath}`);
  })
  .catch((error) => {
    console.error('Packaging failed:', error);
    process.exit(1);
  });
