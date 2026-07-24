/**
 * subs-discover: sidecar discovery next to a media file.
 *
 *  - the mike_mkv-h264-subs.mkv fixture's two sidecars (bare + .en) are found with the
 *    right language + labels.
 *  - extension matching is case-insensitive (a `.SRT` written into a temp dir is
 *    discovered), and a language code is parsed from `<base>.<lang>.<ext>`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverSidecars, classifyExternalSidecar } from '../src/subtitles/discover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

describe('discoverSidecars', () => {
  it('finds the fixture bare + English sidecars with correct labels', async () => {
    const subs = await discoverSidecars(path.join(FIX, 'mike_mkv-h264-subs.mkv'));
    // At least the two committed sidecars: mike_mkv-h264-subs.srt and mike_mkv-h264-subs.en.srt.
    const bare = subs.find((s) => s.path.endsWith('mike_mkv-h264-subs.srt'));
    const en = subs.find((s) => s.path.endsWith('mike_mkv-h264-subs.en.srt'));

    expect(bare).toBeDefined();
    expect(bare!.format).toBe('srt');
    expect(bare!.language).toBeUndefined();
    expect(bare!.label).toBe('External');

    expect(en).toBeDefined();
    expect(en!.format).toBe('srt');
    expect(en!.language).toBe('en');
    expect(en!.label).toBe('English');
  });

  it('matches extensions case-insensitively and parses lang codes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'subs-discover-'));
    const media = path.join(dir, 'movie.mkv');
    await writeFile(media, 'not real video', 'utf8');
    await writeFile(path.join(dir, 'movie.SRT'), '1\n00:00:01,000 --> 00:00:02,000\nhi\n', 'utf8');
    await writeFile(path.join(dir, 'movie.fr.ass'), '[Events]\n', 'utf8');
    await writeFile(path.join(dir, 'movie.eng.vtt'), 'WEBVTT\n', 'utf8');
    // A non-subtitle file and an unrelated stem must be ignored.
    await writeFile(path.join(dir, 'movie.nfo'), 'x', 'utf8');
    await writeFile(path.join(dir, 'other.srt'), '1\n', 'utf8');

    const subs = await discoverSidecars(media);
    const byName = (suffix: string) => subs.find((s) => s.path.endsWith(suffix));

    expect(byName('movie.SRT')).toBeDefined();
    expect(byName('movie.SRT')!.format).toBe('srt');
    expect(byName('movie.SRT')!.label).toBe('External');

    expect(byName('movie.fr.ass')).toBeDefined();
    expect(byName('movie.fr.ass')!.language).toBe('fr');
    expect(byName('movie.fr.ass')!.label).toBe('French');

    expect(byName('movie.eng.vtt')).toBeDefined();
    expect(byName('movie.eng.vtt')!.language).toBe('eng');
    expect(byName('movie.eng.vtt')!.label).toBe('English');

    expect(byName('movie.nfo')).toBeUndefined();
    expect(byName('other.srt')).toBeUndefined();
  });
});

describe('classifyExternalSidecar', () => {
  it('classifies an arbitrary path by extension + trailing lang code', () => {
    expect(classifyExternalSidecar('/x/subs.es.srt')).toEqual({
      path: '/x/subs.es.srt',
      format: 'srt',
      language: 'es',
      label: 'Spanish',
    });
    expect(classifyExternalSidecar('/x/subs.srt')).toEqual({
      path: '/x/subs.srt',
      format: 'srt',
      label: 'External',
    });
    expect(classifyExternalSidecar('/x/notes.txt')).toBeNull();
  });
});
