/**
 * binary.ts — ffmpeg/ffprobe resolution + capability check.
 *
 * Resolution order for each binary:
 *   1. env override (CASTGORILLA_FFMPEG / CASTGORILLA_FFPROBE)
 *   2. PATH
 *   3. /opt/homebrew/bin (Apple Silicon Homebrew default)
 *
 * Requires ffmpeg >= 8 and the encoders castgorilla depends on:
 *   h264_videotoolbox, hevc_videotoolbox, aac_at, eac3.
 * Any failure throws a single clear error naming what is missing and how to fix
 * it (brew install ffmpeg).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const HOMEBREW_BIN = '/opt/homebrew/bin';
const MIN_MAJOR_VERSION = 8;
const REQUIRED_ENCODERS = ['h264_videotoolbox', 'hevc_videotoolbox', 'aac_at', 'eac3'] as const;

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  /** Full version string as reported by `ffmpeg -version` (first token line). */
  version: string;
  /** Set of encoder names available in this ffmpeg build. */
  encoders: Set<string>;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Look up an executable on PATH without spawning `which` (portable). */
function findOnPath(name: string): string | null {
  const rawPath = process.env['PATH'] ?? '';
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveBinary(name: 'ffmpeg' | 'ffprobe', envVar: string): string {
  // 1. Explicit env override — if set it must be valid, otherwise fail loudly.
  const override = process.env[envVar];
  if (override && override.length > 0) {
    if (!isExecutable(override)) {
      throw new Error(
        `${envVar} points at "${override}" but it is not an executable file. ` +
          `Unset ${envVar} or point it at a real ${name} binary.`,
      );
    }
    return override;
  }

  // 2. PATH.
  const onPath = findOnPath(name);
  if (onPath) return onPath;

  // 3. Homebrew default.
  const brew = path.join(HOMEBREW_BIN, name);
  if (isExecutable(brew)) return brew;

  throw new Error(
    `Could not find ${name}. Looked at $${envVar}, your PATH, and ${HOMEBREW_BIN}. ` +
      `Install it with: brew install ffmpeg`,
  );
}

function parseMajorVersion(versionLine: string): number | null {
  // e.g. "ffmpeg version 8.1.1 Copyright ..." or "ffmpeg version n8.1"
  const m = versionLine.match(/version\s+n?(\d+)\./i);
  if (!m || m[1] === undefined) return null;
  return Number(m[1]);
}

function parseEncoders(encodersOutput: string): Set<string> {
  const set = new Set<string>();
  for (const line of encodersOutput.split('\n')) {
    // Encoder lines look like: " V....D h264_videotoolbox   VideoToolbox H.264 Encoder"
    // A leading 6-char capability flag block, then the encoder name.
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (m && m[1]) set.add(m[1]);
  }
  return set;
}

/**
 * Resolve and validate ffmpeg + ffprobe. Throws a single clear error on any
 * problem (missing binary, too-old version, missing encoders).
 */
export async function resolveFfmpeg(): Promise<FfmpegTools> {
  const ffmpeg = resolveBinary('ffmpeg', 'CASTGORILLA_FFMPEG');
  const ffprobe = resolveBinary('ffprobe', 'CASTGORILLA_FFPROBE');

  // Version + encoders come from ffmpeg itself.
  let versionOut: string;
  let encodersOut: string;
  try {
    const [ver, enc] = await Promise.all([
      execFileAsync(ffmpeg, ['-hide_banner', '-version']),
      execFileAsync(ffmpeg, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 }),
    ]);
    versionOut = ver.stdout;
    encodersOut = enc.stdout;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run "${ffmpeg}": ${detail}. Try: brew install ffmpeg`);
  }

  const versionLine = versionOut.split('\n')[0]?.trim() ?? '';
  const major = parseMajorVersion(versionLine);
  if (major === null) {
    throw new Error(`Could not parse ffmpeg version from: "${versionLine}"`);
  }
  if (major < MIN_MAJOR_VERSION) {
    throw new Error(
      `ffmpeg ${major} is too old (need >= ${MIN_MAJOR_VERSION}). Found: "${versionLine}". ` +
        `Upgrade with: brew upgrade ffmpeg`,
    );
  }

  const encoders = parseEncoders(encodersOut);
  const missing = REQUIRED_ENCODERS.filter((e) => !encoders.has(e));
  if (missing.length > 0) {
    throw new Error(
      `ffmpeg at "${ffmpeg}" is missing required encoder(s): ${missing.join(', ')}. ` +
        `castgorilla needs a Homebrew macOS ffmpeg with VideoToolbox + AudioToolbox. ` +
        `Reinstall with: brew reinstall ffmpeg`,
    );
  }

  return { ffmpeg, ffprobe, version: versionLine, encoders };
}
