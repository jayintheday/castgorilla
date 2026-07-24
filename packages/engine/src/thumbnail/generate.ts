/**
 * thumbnail/generate.ts — still-frame extraction for poster thumbnails and the
 * casting-view backdrop.
 *
 * A STANDALONE engine function (deliberately NOT part of the frozen `Engine`
 * interface): the app reaches it via `import('@castgorilla/engine')` and the
 * main-process disk cache, never off a live session. It produces ONE JPEG frame
 * and returns it as a `data:image/jpeg;base64,…` URI, or `null` on any failure
 * (unreadable file, no decodable frame, ffmpeg missing). It NEVER throws.
 *
 * Same split as the HLS path: `buildStillArgs()` is a pure argv builder (unit
 * tested, no IO) and `pickStillTimestamp()` is the pure timestamp chooser; the
 * process spawn lives in `generateStill()`.
 *
 * NOTE on the spawn: unlike the HLS tier this does NOT reuse `FfmpegProcess` —
 * that class decodes stdout as UTF-8 to parse `-progress` key=value lines, which
 * would corrupt the binary JPEG we pipe out of stdout. We spawn directly and
 * collect stdout as raw Buffers instead.
 */

import { spawn } from 'node:child_process';
import { resolveFfmpeg, type FfmpegTools } from '../ffmpeg/binary.js';
import { formatSeconds } from '../ffmpeg/args.js';

export type ThumbnailVariant = 'thumb' | 'backdrop';

export interface GenerateStillOptions {
  /** Timestamp to grab, in seconds. When omitted a sensible default is chosen. */
  atSec?: number;
  /** Output sizing/quality preset. Defaults to 'thumb'. */
  variant?: ThumbnailVariant;
}

/** Per-variant output box (max dimensions) and JPEG quality (lower = better). */
const VARIANT_PRESETS: Record<ThumbnailVariant, { w: number; h: number; quality: number }> = {
  // Poster-ish card thumbnail — small but crisp.
  thumb: { w: 320, h: 180, quality: 3 },
  // Casting-view backdrop — larger; CSS blurs/darkens it, so a slightly softer
  // JPEG quality keeps the payload down without any visible cost.
  backdrop: { w: 960, h: 540, quality: 5 },
};

/**
 * Fixed offset used when we know nothing about the file's duration: far enough
 * in to clear a black/logo intro on most content, small enough that a short clip
 * still very likely has a frame there (and the short-file retry covers the rest).
 */
const DEFAULT_STILL_OFFSET_SEC = 15;

/** Files at/under this length are treated as "very short" — grab frame 0. */
const SHORT_FILE_SEC = 2;

/** Hard ceiling on how long a single still extraction may run before we kill it. */
const STILL_TIMEOUT_MS = 15_000;

/**
 * Choose the timestamp to grab, purely (no IO):
 *  - an explicit `atSec` wins, clamped to `[0, duration-1]` when duration known;
 *  - otherwise, with a known duration, ~20% in (capped at 60s) to clear intros;
 *  - with an unknown duration, a small fixed offset;
 *  - a very short file always resolves to 0.
 * Always returns a finite value >= 0.
 */
export function pickStillTimestamp(opts: { atSec?: number; durationSec?: number } = {}): number {
  const dur =
    opts.durationSec !== undefined && Number.isFinite(opts.durationSec) && opts.durationSec > 0
      ? opts.durationSec
      : undefined;

  // A very short file has nothing interesting past the start — and seeking near
  // its end risks landing past the last frame.
  if (dur !== undefined && dur <= SHORT_FILE_SEC) return 0;

  if (opts.atSec !== undefined && Number.isFinite(opts.atSec)) {
    const ts = Math.max(0, opts.atSec);
    // Never seek to or past the end, or ffmpeg returns no frame.
    return dur !== undefined ? Math.min(ts, Math.max(0, dur - 1)) : ts;
  }

  if (dur !== undefined) return Math.min(60, dur * 0.2);

  return DEFAULT_STILL_OFFSET_SEC;
}

export interface BuildStillArgsOpts {
  /** Absolute path to the source media file. */
  input: string;
  /** Already-resolved timestamp in seconds (see `pickStillTimestamp`). */
  atSec: number;
  /** Output sizing/quality preset. Defaults to 'thumb'. */
  variant?: ThumbnailVariant;
}

/**
 * Build the exact ffmpeg argv to extract ONE JPEG frame to stdout.
 *
 * Fast input seek (`-ss` before `-i`) for speed, a single video frame from the
 * first video stream, downscaled to fit the variant box WITHOUT upscaling
 * (`min(box,src)` + `force_original_aspect_ratio=decrease`, so aspect is kept
 * and a small source is never blown up), encoded as MJPEG through `image2pipe`.
 * The scale expressions are single-quoted so their commas are not read as
 * filtergraph separators.
 */
export function buildStillArgs(opts: BuildStillArgsOpts): string[] {
  const variant = opts.variant ?? 'thumb';
  const { w, h, quality } = VARIANT_PRESETS[variant];
  const ts = Math.max(0, Number.isFinite(opts.atSec) ? opts.atSec : 0);

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // Fast keyframe input seek — plenty accurate for a poster frame.
    '-ss',
    formatSeconds(ts),
    '-i',
    opts.input,
    // First video stream only (ignores audio/subtitle/data streams).
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
    '-q:v',
    String(quality),
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    'pipe:1',
  ];
}

/**
 * Resolve (and cache) the ffmpeg binary. `resolveFfmpeg()` validates version +
 * encoders on every call (two child spawns); a thumbnail does not need to pay
 * that repeatedly, so we memoise the in-flight promise exactly like the prober.
 */
let toolsPromise: Promise<FfmpegTools> | undefined;
function getFfmpeg(): Promise<FfmpegTools> {
  toolsPromise ??= resolveFfmpeg();
  return toolsPromise;
}

/** True when a buffer begins with the JPEG SOI marker (FF D8). */
function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Run one ffmpeg still extraction. Resolves to the JPEG bytes, or `null` on any
 * failure/timeout. Never throws, never leaves a stray process: the timer
 * SIGKILLs a run that overruns, and every terminal path clears it.
 */
function runStill(
  ffmpeg: string,
  input: string,
  atSec: number,
  variant: ThumbnailVariant,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = buildStillArgs({ input, atSec, variant });
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let done = false;
    let killed = false;

    const settle = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, STILL_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    // Drain stderr so a full pipe can never block the child.
    child.stderr?.resume();

    child.on('error', () => settle(null));
    child.on('close', (code) => {
      if (killed) {
        settle(null);
        return;
      }
      const buf = Buffer.concat(chunks);
      settle(code === 0 && looksLikeJpeg(buf) ? buf : null);
    });
  });
}

/**
 * Grab a still frame from `input` and return it as a `data:image/jpeg;base64,…`
 * URI, or `null` on any failure (ffmpeg missing, unreadable file, no decodable
 * frame). Never throws.
 *
 * If the chosen offset yields no frame (e.g. the file is shorter than the
 * default offset) we retry once at 0 — the pure `pickStillTimestamp` cannot
 * know the file length, so this is where the "very short file" guard actually
 * bites.
 */
export async function generateStill(
  input: string,
  opts: GenerateStillOptions = {},
): Promise<string | null> {
  let ffmpeg: string;
  try {
    ffmpeg = (await getFfmpeg()).ffmpeg;
  } catch {
    // ffmpeg missing / too old / wrong encoders — no thumbnails, but not fatal.
    return null;
  }

  const variant = opts.variant ?? 'thumb';
  const ts = pickStillTimestamp({ atSec: opts.atSec });

  let jpeg = await runStill(ffmpeg, input, ts, variant);
  if (!jpeg && ts > 0) {
    // Short-file / bad-offset fallback: the very first frame always exists if
    // the file has any video at all.
    jpeg = await runStill(ffmpeg, input, 0, variant);
  }
  if (!jpeg) return null;

  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
