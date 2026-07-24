/**
 * thumbnails.ts — the main-process side of `engine:getThumbnail`.
 *
 * This is the Electron boundary for still frames: it owns the mode routing
 * (mock returns a canned image; real drives ffmpeg via the engine) and a small
 * on-disk JPEG cache under the app's userData dir, so a recents card or the
 * casting backdrop is generated at most once per (file, variant) until the file
 * changes. `handlers.ts` stays Electron-free and just calls the function this
 * builds.
 *
 * The real path reaches `generateStill` through a *dynamic* `import(
 * '@castgorilla/engine')` — exactly like `engine-host.ts` loads the real engine
 * — so the engine graph (including the asar-unpacked `castv2`) is never pulled
 * statically into the main bundle. In real mode the engine is already loaded, so
 * this resolves the cached module. The canned image is imported by relative path
 * from the mock's built dist, matching how `engine-host.ts` imports the mock, so
 * it is always available and needs no real engine.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CANNED_THUMBNAIL_DATA_URI } from '../../../engine/dist/mock/mock-engine.js';
import type { EngineMode, ThumbnailRequest } from '../shared/ipc.js';
import { logWarn } from './log.js';

/** Sub-directory of userData that holds the cached JPEGs. */
const CACHE_DIR_NAME = 'thumbnail-cache';

/**
 * Soft cap on cached files. The cache key includes size + mtime, so a re-encoded
 * file makes a NEW entry rather than overwriting — without a bound the dir would
 * grow unboundedly over a library's lifetime. On overflow we evict the oldest
 * files by mtime (best-effort, off the request path). ~512 JPEGs of a few KB
 * each is a fraction of a MB, so this is deliberately generous.
 */
const CACHE_MAX_ENTRIES = 512;

/** The shape `generateStill` presents; annotated locally so the app tier need
 *  not resolve `@castgorilla/engine`'s own published types (see engine-host). */
type GenerateStill = (
  input: string,
  opts?: { atSec?: number; variant?: 'thumb' | 'backdrop' },
) => Promise<string | null>;

/**
 * Build the `getThumbnail` provider for the current engine mode. In mock mode it
 * is a constant; in real mode it is the cache-backed ffmpeg path. Either way it
 * resolves to a data URI or `null` and never rejects.
 */
export function createThumbnailProvider(
  mode: EngineMode,
): (req: ThumbnailRequest) => Promise<string | null> {
  if (mode.mock) {
    return async () => CANNED_THUMBNAIL_DATA_URI;
  }
  return (req) => realThumbnail(req);
}

async function realThumbnail(req: ThumbnailRequest): Promise<string | null> {
  try {
    const stat = await fs.stat(req.file);
    if (!stat.isFile()) return null;

    const variant = req.variant ?? 'thumb';
    const cacheDir = path.join(app.getPath('userData'), CACHE_DIR_NAME);
    const cachePath = path.join(
      cacheDir,
      `${cacheKey(req.file, stat.mtimeMs, stat.size, variant)}.jpg`,
    );

    // --- Cache hit ---------------------------------------------------------
    const cached = await readCached(cachePath);
    if (cached) return cached;

    // --- Cache miss: generate via the engine -------------------------------
    const mod = (await import('@castgorilla/engine')) as { generateStill: GenerateStill };
    const dataUri = await mod.generateStill(req.file, {
      ...(req.atSec !== undefined ? { atSec: req.atSec } : {}),
      variant,
    });
    if (!dataUri) return null;

    await writeCached(cacheDir, cachePath, dataUri);
    return dataUri;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn('thumbnail', `getThumbnail failed for "${req.file}" — ${message}`);
    return null;
  }
}

/** A stable, filesystem-safe cache key for one (file, content, variant) tuple. */
function cacheKey(file: string, mtimeMs: number, size: number, variant: string): string {
  return createHash('sha256')
    .update(`${file}\0${Math.round(mtimeMs)}\0${size}\0${variant}`)
    .digest('hex')
    .slice(0, 32);
}

/** Read a cached JPEG back as a data URI, or null if absent/empty/unreadable. */
async function readCached(cachePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(cachePath);
    if (buf.length === 0) return null;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null; // miss
  }
}

/** Persist the generated JPEG (best-effort — a failed write just means a miss
 *  next time) and keep the cache within its soft cap. */
async function writeCached(cacheDir: string, cachePath: string, dataUri: string): Promise<void> {
  try {
    const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const jpeg = Buffer.from(b64, 'base64');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, jpeg);
    void pruneCache(cacheDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn('thumbnail', `could not cache thumbnail — ${message}`);
  }
}

/** Evict the oldest entries when the cache exceeds its cap. Best-effort. */
async function pruneCache(cacheDir: string): Promise<void> {
  try {
    const names = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.jpg'));
    if (names.length <= CACHE_MAX_ENTRIES) return;
    const stats = await Promise.all(
      names.map(async (name) => {
        const p = path.join(cacheDir, name);
        return { p, mtimeMs: (await fs.stat(p)).mtimeMs };
      }),
    );
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const doomed = stats.slice(0, stats.length - CACHE_MAX_ENTRIES);
    await Promise.all(doomed.map(({ p }) => fs.rm(p, { force: true })));
  } catch {
    /* prune is advisory; never let it break a request */
  }
}
