/**
 * power.ts — hold a macOS power assertion for as long as a playback session is
 * live.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  WHY (2026-07-23, from a real 49-minute episode that died twice)          │
 * │                                                                           │
 * │  This Mac is not just the remote control — it IS the media server (the    │
 * │  HTTP server and, on the HLS tiers, a live ffmpeg). If macOS idle-sleeps  │
 * │  the machine, the socket goes away and playback stops dead. The app log   │
 * │  and `pmset -g log` lined up exactly, twice:                              │
 * │                                                                           │
 * │    12:31:53 BST  Sleep 'Idle Sleep'  →  11:32:20Z WARN [cast] lost        │
 * │    12:34:49 BST  Sleep 'Idle Sleep'  →  11:35:42Z WARN [cast] lost        │
 * │                                                                           │
 * │  `pmset -g assertions | grep -i castgorilla` returned nothing: we held no │
 * │  assertion at all, so from macOS's point of view the machine was idle.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `'prevent-app-suspension'` is the right blocker type: it takes the
 * `PreventUserIdleSystemSleep` assertion that was missing. We deliberately do
 * NOT use `'prevent-display-sleep'` — casting to a TV is precisely the case
 * where the user's own screen SHOULD be allowed to sleep.
 *
 * HONEST LIMIT — this prevents *idle* sleep only. It does not make playback
 * sleep-proof: closing the lid still sleeps the machine (on battery, and on
 * power unless the user has changed the default), and that still kills
 * playback. Forced sleep (Apple menu → Sleep, or the power button) likewise.
 * The blocker buys us "the machine dozed off while I was watching", nothing
 * more.
 *
 * This module holds no Electron import so it stays unit-testable: the caller
 * injects the real `powerSaveBlocker` (see `ipc.ts`, the app's Electron
 * boundary).
 */

import { logInfo, logWarn } from './log.js';

/** The exact slice of Electron's `powerSaveBlocker` we depend on. */
export interface PowerSaveBlockerApi {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** Sink for the acquire/release lines; injectable so tests stay quiet. */
export type PowerLogFn = (message: string) => void;

const BLOCKER_TYPE = 'prevent-app-suspension';

/**
 * A single, idempotent `prevent-app-suspension` assertion.
 *
 * `acquire()` and `release()` are both safe to call any number of times in any
 * order. At most ONE blocker is ever started — a second `acquire()` while one
 * is held is a no-op (sessions overlap briefly when one replaces another), and
 * `release()` never stops an id that is not running. That matters in both
 * directions: a stray double-start would leak an assertion that keeps the
 * user's Mac awake forever, which is a worse bug than the one we are fixing.
 */
export class SleepBlocker {
  private id: number | undefined;

  constructor(
    private readonly api: PowerSaveBlockerApi,
    private readonly log: PowerLogFn = (message) => logInfo('power', message),
  ) {}

  /** True while an assertion is held. */
  get held(): boolean {
    return this.id !== undefined;
  }

  /** The live blocker id, or undefined. Logged so it can be cross-checked
   *  against `pmset -g assertions` when this comes up again. */
  get blockerId(): number | undefined {
    return this.id;
  }

  /** Take the assertion if we do not already hold one. Never throws. */
  acquire(): void {
    if (this.id !== undefined) {
      this.log(`already holding ${BLOCKER_TYPE} id=${this.id} — not starting a second`);
      return;
    }
    try {
      const id = this.api.start(BLOCKER_TYPE);
      this.id = id;
      this.log(`acquired ${BLOCKER_TYPE} id=${id} (idle sleep held off while a session is live)`);
    } catch (err) {
      // Losing the assertion is bad; failing to start playback because of it
      // would be worse. Degrade to a log line.
      logWarn('power', `could not start ${BLOCKER_TYPE}: ${describe(err)}`);
    }
  }

  /** Drop the assertion if we hold one. Idempotent, and never throws. */
  release(): void {
    const id = this.id;
    if (id === undefined) return;
    this.id = undefined;
    try {
      if (this.api.isStarted(id)) {
        this.api.stop(id);
        this.log(`released ${BLOCKER_TYPE} id=${id}`);
      } else {
        this.log(`${BLOCKER_TYPE} id=${id} was already stopped — nothing to release`);
      }
    } catch (err) {
      logWarn('power', `could not stop ${BLOCKER_TYPE} id=${id}: ${describe(err)}`);
    }
  }
}

/** A blocker wired to nothing — the default for contexts with no Electron
 *  (unit tests, and any EngineService constructed without one). */
export function createNoopSleepBlocker(): SleepBlocker {
  return new SleepBlocker(
    { start: () => -1, stop: () => undefined, isStarted: () => false },
    () => undefined,
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
