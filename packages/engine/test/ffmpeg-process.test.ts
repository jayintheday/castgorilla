/**
 * ffmpeg-process: FfmpegProcess against the real ffmpeg binary — progress
 * parsing, graceful kill, and the stderr ring buffer on induced failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg, type FfmpegTools } from '../src/ffmpeg/binary.js';
import { FfmpegProcess, type FfmpegProgress } from '../src/ffmpeg/process.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');

let ff: FfmpegTools;
let dir: string;

beforeAll(async () => {
  ff = await resolveFfmpeg();
  dir = await mkdtemp(path.join(tmpdir(), 'ss-proc-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FfmpegProcess', () => {
  it('parses -progress output and reports a clean exit', async () => {
    const proc = new FfmpegProcess({
      ffmpeg: ff.ffmpeg,
      cwd: dir,
      args: [
        '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
        '-i', path.join(FIX, 'delta_mkv-h264-aac.mkv'),
        '-t', '3', '-map', '0:0', '-c:v', 'h264_videotoolbox', '-q:v', '60',
        '-f', 'null', '-',
      ],
    });

    const progress: FfmpegProgress[] = [];
    proc.on('progress', (p) => progress.push(p));
    proc.start();
    const exit = await proc.exited;

    expect(exit.code).toBe(0);
    expect(progress.length).toBeGreaterThan(0);
    // out_time advances into the media
    expect(Math.max(...progress.map((p) => p.outTimeSec))).toBeGreaterThan(1);
    // a terminal done=true snapshot is emitted
    expect(progress.some((p) => p.done)).toBe(true);
    expect(proc.running).toBe(false);
  }, 20_000);

  it('kill(): SIGTERM stops a long run promptly', async () => {
    const proc = new FfmpegProcess({
      ffmpeg: ff.ffmpeg,
      cwd: dir,
      args: [
        '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
        '-i', path.join(FIX, 'foxtrot_mkv-h264-dts-45min.mkv'),
        '-map', '0:0', '-c:v', 'h264_videotoolbox', '-q:v', '60',
        '-f', 'null', '-',
      ],
    });
    proc.start();
    // let it get going
    await new Promise((r) => setTimeout(r, 300));
    expect(proc.running).toBe(true);
    const pid = proc.pid;

    const t0 = Date.now();
    await proc.kill(2000);
    const elapsed = Date.now() - t0;

    await proc.exited;
    expect(proc.running).toBe(false);
    // responded well within the grace window (ffmpeg traps SIGTERM and exits fast)
    expect(elapsed).toBeLessThan(2000);
    // process is actually gone
    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 20_000);

  it('surfaces the stderr ring buffer + error event on bad args', async () => {
    const proc = new FfmpegProcess({
      ffmpeg: ff.ffmpeg,
      cwd: dir,
      args: ['-loglevel', 'error', '-i', '/no/such/input-xyz.mkv', '-f', 'null', '-'],
    });
    let errored: Error | undefined;
    proc.on('error', (e) => {
      errored = e;
    });
    proc.start();
    const exit = await proc.exited;

    expect(exit.code).not.toBe(0);
    const tail = proc.stderrTail();
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.join('\n')).toMatch(/No such file|not found|Invalid|Error|could not|Cannot/i);
    expect(errored).toBeInstanceOf(Error);
    expect(errored?.message).toMatch(/ffmpeg exited with code/);
  }, 20_000);
});
