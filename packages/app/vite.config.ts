/**
 * vite.config.ts — the RENDERER build (and dev server).
 *
 * `vite` / `vite build` operate on this. Root is `src/renderer`; output goes to
 * `dist/renderer`. `base: './'` makes the packaged `file://` load work with
 * relative asset URLs.
 *
 * NOTE the two different roots: Vite's `root` is `src/renderer`, but THIS file
 * sits at the package root, so every path below is resolved against
 * `import.meta.dirname` rather than written relative to the Vite root.
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = import.meta.dirname;

/**
 * The single source of truth for the app version.
 *
 * package.json's `version` is what electron-builder writes into
 * `CFBundleShortVersionString` / `CFBundleVersion` and the DMG filename, so the
 * renderer must not carry its own copy — it is READ from the same file at build
 * time and injected as `__APP_VERSION__` (declared in
 * `src/renderer/env.d.ts`). Hardcoding it here would recreate exactly the drift
 * this replaces: markup that said "v1.4" over a bundle stamped 0.0.0.
 *
 * Read + JSON.parse rather than `import pkg from './package.json'`: this config
 * is executed by Node (after an esbuild transform), and a plain readFileSync
 * needs no import attributes, no bundler JSON plugin, and no assumptions about
 * how the config itself is loaded.
 *
 * FATAL on a malformed version, never a fallback. A default here would ship a
 * plausible-looking but wrong version silently, which is the entire failure this
 * change exists to remove — and `'0.0.0'` would be the worst possible choice of
 * default, since that is the exact value the packaged bundle wrongly carried
 * before the fix. Stopping the build is the only honest outcome.
 *
 * `readFileSync` already throws on a missing or unreadable file, so the only
 * case left to handle is a file that parses but has no usable `version`.
 */
function readAppVersion(pkgPath: string): string {
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version =
    typeof pkg === 'object' && pkg !== null && 'version' in pkg
      ? (pkg as { version: unknown }).version
      : undefined;

  // Deliberately NOT String(version): that would turn a missing field into the
  // literal "undefined" and ship it as the version.
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      `${pkgPath} has no usable "version" (found ${JSON.stringify(version)}). ` +
        `That field is the single source of truth for the app version: it feeds ` +
        `CFBundleShortVersionString, CFBundleVersion and the DMG filename via ` +
        `electron-builder, and the version shown in the app's sidebar via ` +
        `__APP_VERSION__. Set it to a version string, e.g. "1.0.0".`,
    );
  }
  return version;
}

const version = readAppVersion(resolve(root, 'package.json'));

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  define: {
    // JSON.stringify, not bare interpolation: `define` performs a raw textual
    // substitution, so the replacement has to be a valid JS *expression* —
    // 1.0.0 alone is a syntax error where "1.0.0" is a string literal.
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130', // Electron 43 ships Chromium 138; be conservative.
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  clearScreen: false,
});
