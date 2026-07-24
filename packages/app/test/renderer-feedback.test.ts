/**
 * renderer-feedback.test.ts — the two pure decisions behind what the app says.
 *
 * `cleanErr` is the more important of the pair and the less obvious. Electron
 * wraps every `ipcRenderer.invoke` rejection in `Error invoking remote method
 * 'chan': `, and the messages it wraps are the engine's most carefully written
 * strings — the ffmpeg install instructions and the planner's refusal reasons.
 * If the unwrapping regresses, the user does not lose a nicety; they get told to
 * run `brew install ffmpeg` with forty characters of IPC plumbing in front of it.
 */

import { describe, expect, it } from 'vitest';
import { cleanErr, isEngineFallback } from '../src/renderer/views/feedback.js';
import type { EngineMode } from '../src/shared/ipc.js';

describe('cleanErr — unwrapping Electron IPC rejections', () => {
  it('strips the wrapper and the error-name prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'engine:probe': Error: ffprobe not found. Install it with: brew install ffmpeg",
    );
    expect(cleanErr(wrapped)).toBe(
      'ffprobe not found. Install it with: brew install ffmpeg',
    );
  });

  it('strips a custom engine error name, not just "Error"', () => {
    const wrapped = new Error(
      "Error invoking remote method 'engine:plan': PlanRefusedError: HDR would be lost and hdrPolicy is 'block'",
    );
    expect(cleanErr(wrapped)).toBe("HDR would be lost and hdrPolicy is 'block'");
  });

  it('keeps colons inside the engine message intact', () => {
    // The naive fix — split on ':' and take the last part — loses everything
    // before the final colon, and the engine's messages are full of them.
    const wrapped = new Error(
      "Error invoking remote method 'session:start': CastCommandError: Cast device rejected request with INVALID_REQUEST: INVALID_MEDIA_SESSION_ID",
    );
    expect(cleanErr(wrapped)).toBe(
      'Cast device rejected request with INVALID_REQUEST: INVALID_MEDIA_SESSION_ID',
    );
  });

  it('leaves an unwrapped error alone', () => {
    expect(cleanErr(new Error('device "shield" not found'))).toBe(
      'device "shield" not found',
    );
  });

  it('accepts a plain string (the EVT.error payload is a message, not an Error)', () => {
    expect(cleanErr('connection lost (heartbeat-timeout)')).toBe(
      'connection lost (heartbeat-timeout)',
    );
  });

  it('never returns undefined for a non-Error, non-string value', () => {
    expect(cleanErr(null)).toBe('null');
    expect(cleanErr(undefined)).toBe('undefined');
    expect(cleanErr({ code: 254 })).toBe('[object Object]');
  });

  it('tolerates a wrapper prefix with no closing marker', () => {
    const odd = "Error invoking remote method 'session:seek";
    expect(cleanErr(odd)).toBe(odd);
  });
});

describe('isEngineFallback — which mock deserves a banner', () => {
  const mode = (over: Partial<EngineMode> = {}): EngineMode => ({ mock: true, ...over });

  it('is true only when we wanted the real engine and did not get it', () => {
    expect(isEngineFallback(mode({ reason: 'real engine unavailable: ENOENT' }))).toBe(
      true,
    );
  });

  it('is false for a deliberate CASTGORILLA_MOCK=1 override (the badge says enough)', () => {
    expect(isEngineFallback(mode({ reason: 'CASTGORILLA_MOCK=1' }))).toBe(false);
    expect(isEngineFallback(mode())).toBe(false);
  });

  it('is false on the real engine', () => {
    expect(isEngineFallback({ mock: false })).toBe(false);
    expect(isEngineFallback({ mock: false, reason: 'real engine unavailable' })).toBe(
      false,
    );
  });

  it('is false before the mode is known', () => {
    expect(isEngineFallback(null)).toBe(false);
  });
});
