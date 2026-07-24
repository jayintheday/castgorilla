/**
 * subs-convert (integration — real ffmpeg): WebVTT conversion + extraction.
 *
 *  - golden-file: a small .srt and .ass (written inline) → WebVTT, asserting the
 *    WEBVTT header, cue-timing format, and that ASS override styling is stripped.
 *  - .vtt input: validated (header required) and copied through.
 *  - extract: both embedded streams of mike_mkv-h264-subs.mkv → valid VTT with cues.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertToVtt, extractEmbeddedToVtt } from '../src/subtitles/convert.js';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

// mm:ss.mmm --> mm:ss.mmm (ffmpeg omits the hours group for short cues), with an
// optional leading hours group for longer content.
const CUE_TIMING = /(?:\d{2}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{2}:)?\d{2}:\d{2}\.\d{3}/;

const SRT = `1
00:00:01,000 --> 00:00:04,000
first srt cue

2
00:00:05,500 --> 00:00:08,000
second srt cue
`;

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\b1}Bold{\\b0} then {\\i1}slanted{\\i0} words
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,plain second cue
`;

let ff: FfmpegTools;
let dir: string;
beforeAll(async () => {
  ff = await resolveFfmpeg();
  dir = await mkdtemp(path.join(tmpdir(), 'subs-convert-'));
});

describe('convertToVtt (golden files)', () => {
  it('srt → WebVTT: header + cue timing + cue text', async () => {
    const src = path.join(dir, 'in.srt');
    const out = path.join(dir, 'from-srt.vtt');
    await writeFile(src, SRT, 'utf8');
    await convertToVtt(src, 'srt', out, ff.ffmpeg);

    const vtt = await readFile(out, 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toMatch(CUE_TIMING);
    expect(vtt).toContain('first srt cue');
    expect(vtt).toContain('second srt cue');
  });

  it('ass → WebVTT: ASS override styling ({\\...}) is stripped', async () => {
    const src = path.join(dir, 'in.ass');
    const out = path.join(dir, 'from-ass.vtt');
    await writeFile(src, ASS, 'utf8');
    await convertToVtt(src, 'ass', out, ff.ffmpeg);

    const vtt = await readFile(out, 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toMatch(CUE_TIMING);
    // ASS inline override codes must not survive.
    expect(vtt).not.toContain('{\\');
    expect(vtt).toContain('Bold');
    expect(vtt).toContain('slanted');
    expect(vtt).toContain('plain second cue');
  });

  it('vtt input: valid header is copied, an invalid file is rejected', async () => {
    const good = path.join(dir, 'good.vtt');
    const goodOut = path.join(dir, 'good-out.vtt');
    await writeFile(good, 'WEBVTT\n\n00:00.000 --> 00:02.000\nhi\n', 'utf8');
    await convertToVtt(good, 'vtt', goodOut, ff.ffmpeg);
    expect((await readFile(goodOut, 'utf8')).startsWith('WEBVTT')).toBe(true);

    const bad = path.join(dir, 'bad.vtt');
    await writeFile(bad, 'this is not a vtt file\n', 'utf8');
    await expect(convertToVtt(bad, 'vtt', path.join(dir, 'bad-out.vtt'), ff.ffmpeg)).rejects.toThrow(/WEBVTT/);
  });
});

describe('extractEmbeddedToVtt (mike_mkv-h264-subs.mkv)', () => {
  it('extracts both embedded streams (subrip @2, ass @3) to valid VTT with cues', async () => {
    const media = path.join(FIX, 'mike_mkv-h264-subs.mkv');

    const outSrt = path.join(dir, 'embed-2.vtt');
    await extractEmbeddedToVtt(media, 2, outSrt, ff.ffmpeg);
    const srt = await readFile(outSrt, 'utf8');
    expect(srt.startsWith('WEBVTT')).toBe(true);
    expect(srt).toMatch(CUE_TIMING);
    expect(srt).toContain('fixture subtitle line one');

    const outAss = path.join(dir, 'embed-3.vtt');
    await extractEmbeddedToVtt(media, 3, outAss, ff.ffmpeg);
    const ass = await readFile(outAss, 'utf8');
    expect(ass.startsWith('WEBVTT')).toBe(true);
    expect(ass).toMatch(CUE_TIMING);
    expect(ass).toContain('ASS fixture cue');
    expect(ass).not.toContain('{\\');
  });
});
