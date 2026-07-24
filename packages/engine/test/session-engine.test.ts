/**
 * session-engine — the public createEngine() surface (index.ts wiring):
 *  - probe() / plan() are the real probe + pure planner passthrough,
 *  - play() drives a full session through the shared server against the mock,
 *  - shutdown() stops sessions + closes the server and is idempotent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockCastReceiver } from './helpers/mock-cast-receiver.js';
import { createEngine } from '../src/index.js';
import { PROFILES } from '../src/devices/profiles.js';
import type { DiscoveredDevice, PlaybackPrefs, PlaybackSession } from '../src/types/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../..', 'fixtures');
const PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

function device(host: string, port: number): DiscoveredDevice {
  return { id: `test-${port}`, friendlyName: 'Test TV', model: 'Chromecast Ultra', host, port, profile: PROFILES.ultra };
}

function waitForState(session: PlaybackSession, target: string, timeoutMs = 20_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (session.status().state === target) return resolve();
    const timer = setTimeout(() => {
      session.off('state', handler);
      reject(new Error(`timeout waiting for '${target}' (last=${session.status().state})`));
    }, timeoutMs);
    const handler = (st: string): void => {
      if (st === target) {
        clearTimeout(timer);
        session.off('state', handler);
        resolve();
      }
    };
    session.on('state', handler);
  });
}

describe('createEngine (public API)', () => {
  it('probe() + plan() produce a real MediaInfo and a matching plan', async () => {
    const engine = createEngine();
    const media = await engine.probe(path.join(FIX, 'echo_mkv-h264-dts.mkv'));
    expect(media.video[0]?.codec).toBe('h264');
    expect(media.audio[0]?.codec).toBe('dts');

    const plan = engine.plan(media, PROFILES.ultra, PREFS);
    expect(plan.tier).toBe('audio-transcode');
    expect(plan.method).toBe('hls');

    await engine.shutdown();
    await engine.shutdown(); // idempotent
  });

  it('play() runs a full direct-tier session to playing, shutdown cleans up', async () => {
    const mock = new MockCastReceiver({ loadTransitionMs: 15 });
    const { host, port } = await mock.start();
    const engine = createEngine();
    try {
      const media = await engine.probe(path.join(FIX, 'alpha_mp4-h264-aac.mp4'));
      const plan = engine.plan(media, PROFILES.ultra, PREFS);
      const session = await engine.play({ device: device(host, port), media, plan, prefs: PREFS });
      await waitForState(session, 'playing');
      expect(session.status().tier).toBe('direct');
      expect(session.status().deviceName).toBe('Test TV');

      await engine.shutdown(); // stops the session + closes the server
      expect(session.status().state).toBe('stopped');
    } finally {
      await engine.shutdown().catch(() => undefined);
      await mock.stop();
    }
  }, 40_000);
});
