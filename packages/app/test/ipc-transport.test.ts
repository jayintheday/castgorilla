/**
 * ipc-transport.test.ts — transport commands aimed at a dead session.
 *
 * The bug this pins down: after the Mac idle-slept and the cast connection was
 * lost, pressing Pause threw out of the `ipcMain.handle` callback —
 *
 *   Error occurred in handler for 'session:pause': CastCommandError: Cast device
 *   rejected request with INVALID_REQUEST: INVALID_MEDIA_SESSION_ID
 *
 * — i.e. an uncaught error in the MAIN process. Every transport handler must now
 * resolve a structured `CommandResult` instead, whatever the engine does.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockEngine } from '../../engine/dist/mock/mock-engine.js';
import { EngineService } from '../src/main/engine-service.js';
import { createRequestHandlers, type RequestHandler } from '../src/main/handlers.js';
import { REQ } from '../src/shared/ipc.js';
import type { CommandResult, RequestChannel } from '../src/shared/ipc.js';

/** Every channel that forwards a command to the live session, with a payload. */
const TRANSPORT: ReadonlyArray<readonly [RequestChannel, unknown]> = [
  [REQ.pause, undefined],
  [REQ.resume, undefined],
  [REQ.seek, { positionSec: 42 }],
  [REQ.stop, undefined],
  [REQ.setVolume, { volume: 0.5 }],
  [REQ.setMuted, { muted: true }],
  [REQ.selectAudio, { index: 1 }],
  [REQ.selectSubtitle, { trackId: null }],
];

/** The real shape thrown by the engine's MediaChannel on a rejected request. */
function castCommandError(reason: string): Error {
  return Object.assign(
    new Error(`Cast device rejected request with INVALID_REQUEST: ${reason}`),
    { name: 'CastCommandError', code: 'COMMAND_REJECTED', responseType: 'INVALID_REQUEST', reason },
  );
}

/** Handlers over a service whose every transport method rejects with `err`. */
function handlersRejectingWith(err: unknown): Record<RequestChannel, RequestHandler> {
  const service = new EngineService(createMockEngine(), { mock: true }, () => {});
  for (const method of [
    'pause',
    'resume',
    'seek',
    'stop',
    'setVolume',
    'setMuted',
    'selectAudio',
    'selectSubtitle',
  ] as const) {
    vi.spyOn(service, method).mockRejectedValue(err as Error);
  }
  return createRequestHandlers(service, { openVideoDialog: async () => null });
}

describe('transport handlers contain engine rejections', () => {
  it('resolves a structured failure instead of throwing (INVALID_MEDIA_SESSION_ID)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handlers = handlersRejectingWith(castCommandError('INVALID_MEDIA_SESSION_ID'));

    const result = (await handlers[REQ.pause]!(undefined)) as CommandResult;

    expect(result.ok).toBe(false);
    expect(result.sessionGone).toBe(true);
    expect(result.error?.reason).toBe('INVALID_MEDIA_SESSION_ID');
    expect(result.error?.message).toContain('INVALID_MEDIA_SESSION_ID');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('contains the rejection on EVERY transport channel, not just pause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handlers = handlersRejectingWith(castCommandError('INVALID_MEDIA_SESSION_ID'));

    for (const [channel, payload] of TRANSPORT) {
      const result = (await handlers[channel]!(payload)) as CommandResult;
      expect(result, channel).toEqual({
        ok: false,
        error: {
          message: 'Cast device rejected request with INVALID_REQUEST: INVALID_MEDIA_SESSION_ID',
          reason: 'INVALID_MEDIA_SESSION_ID',
        },
        sessionGone: true,
      });
    }
    warn.mockRestore();
  });

  it('flags sessionGone ONLY for INVALID_MEDIA_SESSION_ID', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handlers = handlersRejectingWith(castCommandError('INVALID_PLAYER_STATE'));

    const result = (await handlers[REQ.resume]!(undefined)) as CommandResult;
    expect(result.ok).toBe(false);
    expect(result.sessionGone).toBeUndefined();
    expect(result.error?.reason).toBe('INVALID_PLAYER_STATE');
    warn.mockRestore();
  });

  it('handles a plain Error (no receiver reason) and a non-Error throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plain = handlersRejectingWith(new Error('socket closed'));
    expect(await plain[REQ.seek]!({ positionSec: 10 })).toEqual({
      ok: false,
      error: { message: 'socket closed' },
    });

    const weird = handlersRejectingWith('just a string');
    expect(await weird[REQ.stop]!(undefined)).toEqual({
      ok: false,
      error: { message: 'just a string' },
    });
    warn.mockRestore();
  });

  it('resolves { ok: true } on the happy path', async () => {
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});
    const handlers = createRequestHandlers(service, { openVideoDialog: async () => null });

    // No session is live — these are no-ops on the service, and must still
    // report success rather than an error.
    for (const [channel, payload] of TRANSPORT) {
      expect(await handlers[channel]!(payload), channel).toEqual({ ok: true });
    }
  });

  it('leaves NON-transport handlers throwing, so the renderer still banners them', async () => {
    // probe / plan / startSession failures are handled by the renderer's
    // try/catch banners ("Couldn't read this file — …"); wrapping them in a
    // CommandResult would silently break that.
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});
    const handlers = createRequestHandlers(service, { openVideoDialog: async () => null });

    await expect(
      handlers[REQ.plan]!({ deviceId: 'nope', media: {}, prefs: {} }),
    ).rejects.toThrow(/Unknown device/);
  });
});
