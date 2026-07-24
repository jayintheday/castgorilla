/**
 * Fixture verification (integration — SLOW).
 *
 * Runs scripts/gen-fixtures.sh (idempotent: a no-op after the first run) and
 * then ffprobes each fixture to assert the container/codec/channel/pix_fmt/
 * color properties it is supposed to prove. Generation with VideoToolbox can
 * take a few minutes on a cold run, hence the long timeouts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..'); // packages/engine/test -> repo root
const FIX = path.join(ROOT, 'fixtures');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-fixtures.sh');
const FFPROBE = process.env['CASTGORILLA_FFPROBE'] || '/opt/homebrew/bin/ffprobe';

const TEN_MIN = 600_000;

/** ffprobe a single/multi entry, one value per line, no keys/wrappers. */
function probe(file: string, streamSel: string | null, entries: string): string {
  const args = ['-v', 'error'];
  if (streamSel) args.push('-select_streams', streamSel);
  args.push('-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1');
  args.push(path.join(FIX, file));
  return execFileSync(FFPROBE, args, { encoding: 'utf8' }).trim();
}

function lines(file: string, streamSel: string | null, entries: string): string[] {
  return probe(file, streamSel, entries).split('\n').filter((l) => l.length > 0);
}

describe('fixtures (integration)', () => {
  beforeAll(() => {
    // Idempotent: skips anything already generated.
    execFileSync('bash', [SCRIPT], { stdio: 'inherit', timeout: TEN_MIN });
  }, TEN_MIN);

  it('all expected fixtures exist', () => {
    const expected = [
      'alpha_mp4-h264-aac.mp4',
      'bravo_mp4-h264-aac-nofaststart.mp4',
      'charlie_mp4-h264-l51-4k.mp4',
      'delta_mkv-h264-aac.mkv',
      'echo_mkv-h264-dts.mkv',
      'foxtrot_mkv-h264-dts-45min.mkv',
      'golf_mkv-h264-ac3.mkv',
      'hotel_mkv-hevc10-truehd.mkv',
      'india_webm-vp9-opus.webm',
      'juliett_webm-vp8-vorbis.webm',
      'kilo_mkv-hevc8-aac.mkv',
      'lima_mp4-h264-aac51.mp4',
      'mike_mkv-h264-subs.mkv',
      'mike_mkv-h264-subs.srt',
      'mike_mkv-h264-subs.en.srt',
      'november_mkv-h264-longgop.mkv',
      'oscar_avi-mpeg4-mp3.avi',
      'quebec_mkv-h264-23976fps.mkv',
    ];
    for (const f of expected) {
      expect(existsSync(path.join(FIX, f)), `missing fixture: ${f}`).toBe(true);
    }
  });

  it('#1 alpha_mp4-h264-aac: H.264 + AAC stereo in mp4', () => {
    expect(probe('alpha_mp4-h264-aac.mp4', 'v:0', 'stream=codec_name')).toBe('h264');
    expect(probe('alpha_mp4-h264-aac.mp4', 'v:0', 'stream=width,height')).toBe('1920\n1080');
    expect(probe('alpha_mp4-h264-aac.mp4', 'a:0', 'stream=codec_name,channels')).toBe('aac\n2');
  });

  it('#2 charlie_mp4-h264-l51-4k: H.264 at 3840x2160', () => {
    expect(probe('charlie_mp4-h264-l51-4k.mp4', 'v:0', 'stream=codec_name')).toBe('h264');
    expect(probe('charlie_mp4-h264-l51-4k.mp4', 'v:0', 'stream=width,height')).toBe('3840\n2160');
  });

  it('#4 echo_mkv-h264-dts: DTS 5.1 (6 channels)', () => {
    expect(probe('echo_mkv-h264-dts.mkv', 'a:0', 'stream=codec_name')).toBe('dts');
    expect(probe('echo_mkv-h264-dts.mkv', 'a:0', 'stream=channels')).toBe('6');
    expect(probe('echo_mkv-h264-dts.mkv', 'a:0', 'stream=channel_layout')).toMatch(/^5\.1/);
  });

  it('#4L foxtrot_mkv-h264-dts-45min: duration >= 2600s', () => {
    const dur = Number(probe('foxtrot_mkv-h264-dts-45min.mkv', null, 'format=duration'));
    expect(dur).toBeGreaterThanOrEqual(2600);
  });

  it('#5 golf_mkv-h264-ac3: AC-3 5.1', () => {
    expect(probe('golf_mkv-h264-ac3.mkv', 'a:0', 'stream=codec_name')).toBe('ac3');
    expect(probe('golf_mkv-h264-ac3.mkv', 'a:0', 'stream=channels')).toBe('6');
  });

  it('#6 hotel_mkv-hevc10-truehd: HEVC Main10, PQ (smpte2084), + TrueHD 5.1', () => {
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'v:0', 'stream=codec_name')).toBe('hevc');
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'v:0', 'stream=profile')).toBe('Main 10');
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'v:0', 'stream=color_transfer')).toBe('smpte2084');
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'v:0', 'stream=pix_fmt')).toMatch(/10le$/);
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'a:0', 'stream=codec_name')).toBe('truehd');
    expect(probe('hotel_mkv-hevc10-truehd.mkv', 'a:0', 'stream=channels')).toBe('6');
  });

  it('#7 india_webm-vp9-opus: VP9 + Opus', () => {
    expect(probe('india_webm-vp9-opus.webm', 'v:0', 'stream=codec_name')).toBe('vp9');
    expect(probe('india_webm-vp9-opus.webm', 'a:0', 'stream=codec_name')).toBe('opus');
  });

  it('#8 juliett_webm-vp8-vorbis: VP8 + Vorbis', () => {
    expect(probe('juliett_webm-vp8-vorbis.webm', 'v:0', 'stream=codec_name')).toBe('vp8');
    expect(probe('juliett_webm-vp8-vorbis.webm', 'a:0', 'stream=codec_name')).toBe('vorbis');
  });

  it('#9 kilo_mkv-hevc8-aac: HEVC 8-bit + AAC', () => {
    expect(probe('kilo_mkv-hevc8-aac.mkv', 'v:0', 'stream=codec_name')).toBe('hevc');
    expect(probe('kilo_mkv-hevc8-aac.mkv', 'v:0', 'stream=pix_fmt')).toBe('yuv420p');
    expect(probe('kilo_mkv-hevc8-aac.mkv', 'a:0', 'stream=codec_name')).toBe('aac');
  });

  it('#10 lima_mp4-h264-aac51: AAC 6-channel 5.1', () => {
    expect(probe('lima_mp4-h264-aac51.mp4', 'a:0', 'stream=codec_name')).toBe('aac');
    expect(probe('lima_mp4-h264-aac51.mp4', 'a:0', 'stream=channels')).toBe('6');
    expect(probe('lima_mp4-h264-aac51.mp4', 'a:0', 'stream=channel_layout')).toMatch(/^5\.1/);
  });

  it('#11 mike_mkv-h264-subs: two embedded subtitle streams (subrip + ass)', () => {
    const subCodecs = lines('mike_mkv-h264-subs.mkv', 's', 'stream=codec_name');
    expect(subCodecs).toHaveLength(2);
    expect(subCodecs).toContain('subrip');
    expect(subCodecs).toContain('ass');
    // sidecars present
    expect(existsSync(path.join(FIX, 'mike_mkv-h264-subs.srt'))).toBe(true);
    expect(existsSync(path.join(FIX, 'mike_mkv-h264-subs.en.srt'))).toBe(true);
  });

  it('#13 november_mkv-h264-longgop: H.264 present (10s GOP source)', () => {
    expect(probe('november_mkv-h264-longgop.mkv', 'v:0', 'stream=codec_name')).toBe('h264');
  });

  it('#14 oscar_avi-mpeg4-mp3: MPEG-4 Part 2 + MP3 in AVI', () => {
    expect(probe('oscar_avi-mpeg4-mp3.avi', 'v:0', 'stream=codec_name')).toBe('mpeg4');
    expect(probe('oscar_avi-mpeg4-mp3.avi', 'a:0', 'stream=codec_name')).toBe('mp3');
    expect(probe('oscar_avi-mpeg4-mp3.avi', null, 'format=format_name')).toMatch(/avi/);
  });

  it('#15 quebec_mkv-h264-23976fps: fractional rate + a deterministic 4.004s keyframe grid', () => {
    // The rate is the entire reason this fixture exists — assert it exactly, not
    // as ~23.976. At 24000/1001 no multiple of 6 falls on a frame, which is the
    // condition every other (30fps) fixture silently fails to express.
    expect(probe('quebec_mkv-h264-23976fps.mkv', 'v:0', 'stream=r_frame_rate')).toBe('24000/1001');
    expect(probe('quebec_mkv-h264-23976fps.mkv', 'v:0', 'stream=codec_name')).toBe('h264');
    // -g 96 -keyint_min 96 -sc_threshold 0 → keyframes at exactly 4.004·k, so
    // hls-session (s) can assert boundary times to the millisecond.
    const kf = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time',
        '-of', 'default=noprint_wrappers=1:nokey=1', path.join(FIX, 'quebec_mkv-h264-23976fps.mkv')],
      { encoding: 'utf8' },
    ).trim().split('\n').filter((l) => l.length > 0);
    expect(kf.length).toBeGreaterThan(10);
    kf.slice(0, 10).forEach((t, i) => expect(Number(t)).toBeCloseTo(i * 4.004, 3));
  });
});
