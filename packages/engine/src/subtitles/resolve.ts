/**
 * subtitles/resolve.ts — orchestrate embedded + sidecar subtitles into a set of
 * local WebVTT files the media server can then publish.
 *
 * Flow:
 *   1. embedded TEXT streams (isText) → extract each to <workDir>/sub-e<idx>.vtt
 *   2. sidecars (discovered next to the media, plus any explicit extra paths)
 *      → convert each to <workDir>/sub-s<n>.vtt
 *   3. assign trackIds sequentially from 1 (embedded first, then sidecars)
 *
 * Bitmap subtitles (hdmv_pgs / dvd_sub, isText === false) are EXCLUDED and
 * returned separately as `unsupported` so callers can message clearly. A single
 * track failing to extract/convert is logged and skipped — it never fails the
 * whole resolve.
 */

import { join } from 'node:path';

import { resolveFfmpeg } from '../ffmpeg/binary.js';
import { createLogger, type Logger } from '../util/logger.js';
import { convertToVtt, extractEmbeddedToVtt } from './convert.js';
import {
  discoverSidecars,
  classifyExternalSidecar,
  languageName,
  languageMatches,
  type SidecarSub,
} from './discover.js';
import type { MediaInfo, PlaybackPrefs, SubtitlePlanEntry, SubtitleStreamInfo } from '../types/index.js';

/** A subtitle track resolved to a local WebVTT file, ready to be served. */
export interface ResolvedSubtitle {
  /** The plan entry minus its (server) url, plus the local WebVTT path. */
  entry: Omit<SubtitlePlanEntry, 'url'> & { localPath: string };
  /** Was this the default-flagged embedded stream? (sidecars are always false.) */
  isDefault: boolean;
  /** Source ffprobe stream index for embedded tracks; undefined for sidecars. */
  streamIndex?: number;
}

export interface ResolveSubtitlesResult {
  resolved: ResolvedSubtitle[];
  /** Bitmap / undecodable subtitle streams, excluded from `resolved`. */
  unsupported: SubtitleStreamInfo[];
}

export interface ResolveSubtitlesOpts {
  media: MediaInfo;
  mediaPath: string;
  /** Directory the WebVTT outputs are written into (caller owns its lifecycle). */
  workDir: string;
  prefs: PlaybackPrefs;
  /** Pre-resolved ffmpeg binary path (avoids a second resolveFfmpeg() spawn). */
  ffmpeg?: string;
  /** Explicit extra sidecar files (e.g. the CLI's `--sub <path>`). */
  extraSidecarPaths?: string[];
  logger?: Logger;
}

// Interim shapes before trackIds are assigned.
type PendingEmbedded = { kind: 'embedded'; stream: SubtitleStreamInfo; localPath: string };
type PendingSidecar = { kind: 'sidecar'; sidecar: SidecarSub; localPath: string };
type Pending = PendingEmbedded | PendingSidecar;

export async function resolveSubtitles(opts: ResolveSubtitlesOpts): Promise<ResolveSubtitlesResult> {
  const log = (opts.logger ?? createLogger('castgorilla')).child('subtitles');
  const ffmpeg = opts.ffmpeg ?? (await resolveFfmpeg()).ffmpeg;

  const unsupported: SubtitleStreamInfo[] = [];
  const pending: Pending[] = [];

  // 1 — embedded streams: extract text ones, set bitmap ones aside.
  for (const stream of opts.media.subtitles) {
    if (!stream.isText) {
      unsupported.push(stream);
      continue;
    }
    const localPath = join(opts.workDir, `sub-e${stream.index}.vtt`);
    try {
      await extractEmbeddedToVtt(opts.mediaPath, stream.index, localPath, ffmpeg);
      pending.push({ kind: 'embedded', stream, localPath });
    } catch (e) {
      log.warn(
        `skipping embedded subtitle stream ${stream.index}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2 — sidecars: discovered next to the media, then any explicit extras.
  const sidecars = await discoverSidecars(opts.mediaPath);
  for (const p of opts.extraSidecarPaths ?? []) {
    const sc = classifyExternalSidecar(p);
    if (sc) sidecars.push(sc);
    else log.warn(`ignoring --sub path (unrecognized subtitle extension): ${p}`);
  }

  let sidecarN = 0;
  for (const sidecar of sidecars) {
    const localPath = join(opts.workDir, `sub-s${sidecarN++}.vtt`);
    try {
      await convertToVtt(sidecar.path, sidecar.format, localPath, ffmpeg);
      pending.push({ kind: 'sidecar', sidecar, localPath });
    } catch (e) {
      log.warn(`skipping sidecar ${sidecar.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3 — assign sequential trackIds (embedded already precede sidecars in `pending`).
  const resolved: ResolvedSubtitle[] = pending.map((p, i) => {
    const trackId = i + 1;
    if (p.kind === 'embedded') {
      const label =
        p.stream.title || languageName(p.stream.language) || `Track ${trackId}`;
      const entry: ResolvedSubtitle['entry'] = {
        trackId,
        label,
        source: 'embedded',
        localPath: p.localPath,
      };
      if (p.stream.language !== undefined) entry.language = p.stream.language;
      return { entry, isDefault: p.stream.isDefault, streamIndex: p.stream.index };
    }
    const entry: ResolvedSubtitle['entry'] = {
      trackId,
      label: p.sidecar.label,
      source: 'sidecar',
      localPath: p.localPath,
    };
    if (p.sidecar.language !== undefined) entry.language = p.sidecar.language;
    return { entry, isDefault: false };
  });

  return { resolved, unsupported };
}

/**
 * Choose the trackId to activate by default:
 *   preferred-language match  >  a default-flagged embedded track  >  null (off).
 */
export function pickDefaultTrack(
  resolved: ResolvedSubtitle[],
  preferredSubLang?: string,
): number | null {
  if (preferredSubLang) {
    const match = resolved.find((r) => languageMatches(r.entry.language, preferredSubLang));
    if (match) return match.entry.trackId;
  }
  const def = resolved.find((r) => r.isDefault);
  if (def) return def.entry.trackId;
  return null;
}
