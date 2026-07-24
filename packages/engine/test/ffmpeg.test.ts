import { describe, it, expect } from 'vitest';
import { resolveFfmpeg } from '../src/ffmpeg/binary.js';

describe('resolveFfmpeg', () => {
  it('resolves ffmpeg + ffprobe on this machine with all required encoders', async () => {
    const tools = await resolveFfmpeg();
    expect(tools.ffmpeg).toMatch(/ffmpeg/);
    expect(tools.ffprobe).toMatch(/ffprobe/);
    expect(tools.version).toMatch(/ffmpeg version/i);
    for (const enc of ['h264_videotoolbox', 'hevc_videotoolbox', 'aac_at', 'eac3']) {
      expect(tools.encoders.has(enc)).toBe(true);
    }
    // Sanity: the set has many entries, not just the four we checked.
    expect(tools.encoders.size).toBeGreaterThan(10);
  });

  it('throws a clear, named error when the env override points at a missing binary', async () => {
    const prev = process.env['CASTGORILLA_FFMPEG'];
    process.env['CASTGORILLA_FFMPEG'] = '/nonexistent/path/to/ffmpeg';
    try {
      await expect(resolveFfmpeg()).rejects.toThrow(/CASTGORILLA_FFMPEG/);
    } finally {
      if (prev === undefined) delete process.env['CASTGORILLA_FFMPEG'];
      else process.env['CASTGORILLA_FFMPEG'] = prev;
    }
  });
});
