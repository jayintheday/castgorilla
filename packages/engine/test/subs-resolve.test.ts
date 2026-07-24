/**
 * subs-resolve (integration — real ffmpeg): the orchestrating resolveSubtitles().
 *
 *  - full flow on mike_mkv-h264-subs.mkv → 4 tracks (2 embedded + 2 sidecar), with
 *    sequential trackIds (embedded first) and correct sources.
 *  - a doctored MediaInfo carrying a PGS (bitmap) stream: the bitmap track appears
 *    in `unsupported`, never in the resolved tracks.
 *  - pickDefaultTrack: preferred-lang > default-flagged embedded > null.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSubtitles, pickDefaultTrack } from '../src/subtitles/resolve.js';
import { probe } from '../src/probe/ffprobe.js';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import type { MediaInfo, PlaybackPrefs, SubtitleStreamInfo } from '../src/types/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');
const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

let ff: FfmpegTools;
let media: MediaInfo;
beforeAll(async () => {
  ff = await resolveFfmpeg();
  media = await probe(path.join(FIX, 'mike_mkv-h264-subs.mkv'));
});

describe('resolveSubtitles (mike_mkv-h264-subs.mkv)', () => {
  it('produces 4 tracks: 2 embedded then 2 sidecar, sequential trackIds', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'subs-resolve-'));
    const { resolved, unsupported } = await resolveSubtitles({
      media,
      mediaPath: media.path,
      workDir,
      prefs: PREFS,
      ffmpeg: ff.ffmpeg,
    });

    expect(unsupported).toHaveLength(0);
    expect(resolved).toHaveLength(4);
    expect(resolved.map((r) => r.entry.trackId)).toEqual([1, 2, 3, 4]);
    expect(resolved.map((r) => r.entry.source)).toEqual(['embedded', 'embedded', 'sidecar', 'sidecar']);

    // Every resolved track points at a real WebVTT file with cue content.
    for (const r of resolved) {
      const body = await readFile(r.entry.localPath, 'utf8');
      expect(body.startsWith('WEBVTT')).toBe(true);
      expect(body).toContain('-->');
    }

    // The default-flagged embedded stream (subrip @2) is track 1.
    expect(resolved[0]!.isDefault).toBe(true);
    expect(resolved[0]!.streamIndex).toBe(2);

    // The English sidecar is present with a language + label.
    const en = resolved.find((r) => r.entry.language === 'en');
    expect(en).toBeDefined();
    expect(en!.entry.label).toBe('English');
    expect(en!.entry.source).toBe('sidecar');
  });

  it('excludes bitmap (PGS) streams into `unsupported`', async () => {
    const pgs: SubtitleStreamInfo = {
      index: 9,
      codec: 'hdmv_pgs',
      isText: false,
      isDefault: false,
      isForced: false,
    };
    const doctored: MediaInfo = { ...media, subtitles: [...media.subtitles, pgs] };

    const workDir = await mkdtemp(path.join(tmpdir(), 'subs-resolve-pgs-'));
    const { resolved, unsupported } = await resolveSubtitles({
      media: doctored,
      mediaPath: media.path,
      workDir,
      prefs: PREFS,
      ffmpeg: ff.ffmpeg,
    });

    expect(unsupported.map((s) => s.index)).toContain(9);
    expect(unsupported.every((s) => !s.isText)).toBe(true);
    // The bitmap stream never becomes a resolved track; the text ones still do.
    expect(resolved.some((r) => r.streamIndex === 9)).toBe(false);
    expect(resolved).toHaveLength(4);
  });
});

describe('pickDefaultTrack', () => {
  it('prefers a language match, else a default-flagged embedded, else null', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'subs-resolve-def-'));
    const { resolved } = await resolveSubtitles({
      media,
      mediaPath: media.path,
      workDir,
      prefs: PREFS,
      ffmpeg: ff.ffmpeg,
    });

    // No preference → the default-flagged embedded track (trackId 1).
    expect(pickDefaultTrack(resolved)).toBe(1);
    // Preferred 'en' → the English sidecar (trackId 3). 2-letter vs 3-letter aware.
    expect(pickDefaultTrack(resolved, 'en')).toBe(3);
    expect(pickDefaultTrack(resolved, 'eng')).toBe(3);
    // Preference with no match falls back to the default embedded.
    expect(pickDefaultTrack(resolved, 'zz')).toBe(1);
    // No tracks at all → null.
    expect(pickDefaultTrack([])).toBeNull();
    expect(pickDefaultTrack([], 'en')).toBeNull();
  });
});
