import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEngine, cannedMediaInfo, cannedPlan } from '../src/mock/mock-engine.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { DiscoveredDevice, PlaybackSession, SessionState } from '../src/types/index.js';

const STARTUP: SessionState[] = [
  'probing',
  'planning',
  'preparing',
  'connecting',
  'loading',
  'buffering',
  'playing',
];

describe('MockEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('discovery emits exactly 2 devices ~500ms after start()', () => {
    const engine = createMockEngine();
    const seen: DiscoveredDevice[] = [];
    engine.discovery.on('device', (d) => seen.push(d));

    engine.discovery.start();
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(499);
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(2);
    expect(engine.discovery.list()).toHaveLength(2);
    expect(seen[0]?.profile.key).toBe('ultra');
    expect(seen[1]?.profile.key).toBe('gtv-streamer');
  });

  it('discovery.rescan() re-emits the known devices (mock-mode Refresh feedback)', () => {
    const engine = createMockEngine();
    const seen: DiscoveredDevice[] = [];
    engine.discovery.on('device', (d) => seen.push(d));

    engine.discovery.start();
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(2);

    // A rescan re-fires the canned devices without changing the stable list —
    // giving the UI its 'device' → snapshot flow, same as the real engine.
    engine.discovery.rescan();
    expect(seen).toHaveLength(4);
    expect(engine.discovery.list()).toHaveLength(2);
  });

  it('discovery.rescan() before the initial reveal is a no-op', () => {
    const engine = createMockEngine();
    const seen: DiscoveredDevice[] = [];
    engine.discovery.on('device', (d) => seen.push(d));
    // Not started yet — nothing known, nothing to re-emit.
    engine.discovery.rescan();
    expect(seen).toHaveLength(0);
  });

  it('probe() and plan() return coherent canned data', async () => {
    const engine = createMockEngine();
    const media = await engine.probe('/movies/x.mkv');
    expect(media.path).toBe('/movies/x.mkv');
    expect(media.video[0]?.codec).toBe('hevc');
    expect(media.video[0]?.hdr.type).toBe('hdr10');

    const plan = engine.plan(media, PROFILES.ultra, { surround: true, hdrPolicy: 'warn' });
    expect(plan.method).toBe('hls');
    expect(plan.durationSec).toBe(media.durationSec);
    expect(plan.videoStreamIndex).toBe(media.video[0]?.index);
  });

  async function startPlaying(durationSec: number): Promise<{
    session: PlaybackSession;
    states: SessionState[];
    positions: number[];
    ended: () => boolean;
  }> {
    const engine = createMockEngine();
    engine.discovery.start();
    vi.advanceTimersByTime(500);
    const device = engine.discovery.list()[0]!;
    const media = cannedMediaInfo();
    const plan = { ...cannedPlan(media), durationSec };

    const session = await engine.play({ device, media, plan });
    const states: SessionState[] = [];
    const positions: number[] = [];
    let didEnd = false;
    session.on('state', (s) => states.push(s));
    session.on('position', (p) => positions.push(p));
    session.on('ended', () => {
      didEnd = true;
    });
    return { session, states, positions, ended: () => didEnd };
  }

  it('play() walks probing -> ... -> playing then ticks position at 1Hz', async () => {
    const { session, states, positions } = await startPlaying(3600);

    // Walk the startup state machine (7 states * 60ms step).
    vi.advanceTimersByTime(7 * 60);
    expect(states).toEqual(STARTUP);
    expect(session.status().state).toBe('playing');
    expect(positions).toEqual([]);

    // Then position ticks once per second.
    vi.advanceTimersByTime(3000);
    expect(positions).toEqual([1, 2, 3]);
    expect(session.status().positionSec).toBe(3);
  });

  it('pause() stops ticking; resume() continues; seek() repositions', async () => {
    const { session, positions } = await startPlaying(3600);
    vi.advanceTimersByTime(7 * 60 + 2000); // reach playing + 2s
    expect(session.status().positionSec).toBe(2);

    await session.pause();
    expect(session.status().state).toBe('paused');
    vi.advanceTimersByTime(3000);
    expect(session.status().positionSec).toBe(2); // frozen while paused

    await session.resume();
    expect(session.status().state).toBe('playing');
    vi.advanceTimersByTime(1000);
    expect(session.status().positionSec).toBe(3);

    await session.seek(100);
    expect(session.status().positionSec).toBe(100);
    expect(session.status().state).toBe('playing');
    void positions;
  });

  it('stop() halts the session in the stopped state', async () => {
    const { session } = await startPlaying(3600);
    vi.advanceTimersByTime(7 * 60 + 1000);
    await session.stop();
    expect(session.status().state).toBe('stopped');
    vi.advanceTimersByTime(5000);
    expect(session.status().state).toBe('stopped');
  });

  it('emits ended and stops when playback reaches the end of media', async () => {
    const { session, states, ended } = await startPlaying(3);
    vi.advanceTimersByTime(7 * 60); // reach playing
    vi.advanceTimersByTime(4000); // run past the 3s duration
    expect(ended()).toBe(true);
    expect(session.status().state).toBe('stopped');
    expect(states.at(-1)).toBe('stopped');
    expect(session.status().positionSec).toBe(3);
  });

  it('carries the HDR washout warning through to status()', async () => {
    const { session } = await startPlaying(60);
    vi.advanceTimersByTime(7 * 60);
    expect(session.status().warnings.length).toBeGreaterThan(0);
    expect(session.status().warnings[0]).toMatch(/washed out|tone-mapped/i);
  });
});
