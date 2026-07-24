/**
 * handlers.ts — the REQUEST-channel handler table as plain functions.
 *
 * Kept free of Electron so it can be exercised directly in unit tests: the
 * Electron glue (`ipc.ts`) just iterates this map and registers each entry with
 * `ipcMain.handle`, while tests call the handlers directly against a
 * MockEngine-backed `EngineService`.
 */

import type { EngineService } from './engine-service.js';
import type {
  CommandResult,
  PlanRequest,
  ProbeRequest,
  RequestChannel,
  SeekRequest,
  SelectAudioRequest,
  SelectSubtitleRequest,
  StartSessionRequest,
  ThumbnailRequest,
  VolumeRequest,
  MutedRequest,
} from '../shared/ipc.js';
import { REQ } from '../shared/ipc.js';
import { logWarn } from './log.js';

/** A single request handler: takes the invoke payload, resolves the result. */
export type RequestHandler = (payload: unknown) => Promise<unknown>;

export interface HandlerDeps {
  /** Opens the native video picker; injected so tests need no Electron dialog. */
  openVideoDialog: () => Promise<string | null>;
  /**
   * Produce a still-frame data URI for a file (poster thumbnail / backdrop), or
   * null on any failure. Injected at the Electron boundary (`ipc.ts`) so this
   * table stays Electron- and engine-free; when omitted (unit tests that never
   * touch thumbnails) the handler simply resolves null.
   */
  getThumbnail?: (req: ThumbnailRequest) => Promise<string | null>;
}

/**
 * The receiver's rejection reason for "I have thrown that media session away".
 * Seen for real after the Mac idle-slept mid-episode: the connection dropped,
 * the receiver dropped the session, and the next pause the user pressed came
 * back rejected.
 */
const SESSION_GONE_REASON = 'INVALID_MEDIA_SESSION_ID';

/**
 * Run a TRANSPORT command and contain any rejection.
 *
 * Anything that forwards a command to a live cast session can be rejected by
 * the receiver — and an `ipcMain.handle` callback that rejects surfaces as an
 * uncaught main-process error, which is how a dead session used to take the
 * main process's error handler down with it. Every such command therefore
 * resolves to a `CommandResult`: the renderer decides what to show, the main
 * process never throws.
 *
 * Note what this deliberately does NOT do: it does not reconnect, resume, or
 * retry. Recovering the session is the engine's job.
 */
async function command(channel: string, run: () => Promise<void>): Promise<CommandResult> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = rejectionReason(err);
    const sessionGone = reason === SESSION_GONE_REASON;
    logWarn(
      'ipc',
      `${channel} failed — ${message}${sessionGone ? ' (receiver discarded the media session)' : ''}`,
    );
    return {
      ok: false,
      error: reason === undefined ? { message } : { message, reason },
      ...(sessionGone ? { sessionGone: true } : {}),
    };
  }
}

/**
 * Pull the receiver's own `reason` off a rejected cast command
 * (`CastCommandError` carries `code` / `responseType` / `reason`). Read
 * structurally rather than by instanceof — the app tier does not import engine
 * error classes.
 */
function rejectionReason(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('reason' in err)) return undefined;
  const reason = (err as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Build the full request-handler table. Every key is a `RequestChannel`, so the
 * contract test can assert 1:1 coverage against `REQ`.
 */
export function createRequestHandlers(
  service: EngineService,
  deps: HandlerDeps,
): Record<RequestChannel, RequestHandler> {
  return {
    [REQ.getMode]: async () => service.getMode(),
    [REQ.listDevices]: async () => service.listDevices(),
    [REQ.rescanDevices]: async () => service.rescanDevices(),
    [REQ.openVideoDialog]: async () => deps.openVideoDialog(),
    [REQ.probe]: async (p) => service.probe((p as ProbeRequest).file),
    // Best-effort still frame; never throws (the provider already returns null
    // on failure, and this contains anything unexpected).
    [REQ.getThumbnail]: async (p) => {
      if (!deps.getThumbnail) return null;
      try {
        return await deps.getThumbnail(p as ThumbnailRequest);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn('ipc', `${REQ.getThumbnail} failed — ${message}`);
        return null;
      }
    },
    [REQ.plan]: async (p) => service.plan(p as PlanRequest),
    [REQ.startSession]: async (p) => service.startSession(p as StartSessionRequest),
    // --- transport commands: contained, never throwing (see `command`) -------
    [REQ.pause]: async () => command(REQ.pause, () => service.pause()),
    [REQ.resume]: async () => command(REQ.resume, () => service.resume()),
    [REQ.seek]: async (p) =>
      command(REQ.seek, () => service.seek((p as SeekRequest).positionSec)),
    [REQ.stop]: async () => command(REQ.stop, () => service.stop()),
    [REQ.setVolume]: async (p) =>
      command(REQ.setVolume, () => service.setVolume((p as VolumeRequest).volume)),
    [REQ.setMuted]: async (p) =>
      command(REQ.setMuted, () => service.setMuted((p as MutedRequest).muted)),
    [REQ.selectAudio]: async (p) =>
      command(REQ.selectAudio, () => service.selectAudio((p as SelectAudioRequest).index)),
    [REQ.selectSubtitle]: async (p) =>
      command(REQ.selectSubtitle, () =>
        service.selectSubtitle((p as SelectSubtitleRequest).trackId),
      ),
    [REQ.getStatus]: async () => service.getStatus(),
  };
}
