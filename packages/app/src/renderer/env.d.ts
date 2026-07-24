/**
 * env.d.ts — ambient declarations for values the RENDERER build injects.
 *
 * These are not imports and not globals that exist at runtime in Node: Vite's
 * `define` (see `vite.config.ts`) textually substitutes them at build time, so
 * by the time the bundle runs there is no identifier left — only a literal.
 * TypeScript cannot know that on its own, hence this file.
 *
 * SCOPE: `packages/app/tsconfig.json` is one project over main + preload +
 * renderer, so the declaration below is visible to all three, but only the
 * renderer build defines it. Do not reference `__APP_VERSION__` from
 * `src/main/**` or `src/preload/**` — it would typecheck and then be an
 * undefined identifier at runtime. The main process reads its version from
 * `app.getVersion()`.
 */

/**
 * The app version, read from `packages/app/package.json` at build time.
 *
 * package.json is the single source of truth: the same field feeds
 * `CFBundleShortVersionString`, `CFBundleVersion` and the DMG filename via
 * electron-builder, so anything the UI shows has to come from there rather than
 * from a string typed into the markup.
 */
declare const __APP_VERSION__: string;
