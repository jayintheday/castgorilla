/**
 * reconnect.ts — connection-resilience primitives, deliberately pure and
 * unit-testable in isolation (no sockets, injectable clock/RNG).
 *
 *  - Backoff: exponential delay with jitter (250ms → 4s by default).
 *  - Watchdog: a feedable dead-man's timer (heartbeat liveness). Fires onExpire
 *    if not fed within `timeoutMs`.
 *
 * The old castv2-client had no reconnect at all; this is the piece we own.
 */

// --- Backoff ---------------------------------------------------------------

export interface BackoffOptions {
  /** Delay of the first retry. */
  initialMs: number;
  /** Ceiling for the exponential term. */
  maxMs: number;
  /** Growth factor per attempt. */
  factor: number;
  /**
   * Jitter fraction in [0,1]. The returned delay is uniformly random in
   * [base*(1-jitter), base]. 0 = deterministic doubling; 1 = full jitter.
   */
  jitter: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 250,
  maxMs: 4000,
  factor: 2,
  jitter: 0.5,
};

export class Backoff {
  private readonly opts: BackoffOptions;
  private attempt = 0;

  constructor(opts: Partial<BackoffOptions> = {}) {
    this.opts = { ...DEFAULT_BACKOFF, ...opts };
  }

  /** Number of delays produced so far. */
  get attempts(): number {
    return this.attempt;
  }

  reset(): void {
    this.attempt = 0;
  }

  /** The undithered, capped base delay for the current attempt. */
  peek(): number {
    const raw = this.opts.initialMs * Math.pow(this.opts.factor, this.attempt);
    return Math.min(raw, this.opts.maxMs);
  }

  /** The next delay (ms), applying jitter, and advance the attempt counter. */
  nextDelay(): number {
    const base = this.peek();
    this.attempt++;
    const rnd = (this.opts.random ?? Math.random)();
    const jitter = Math.min(Math.max(this.opts.jitter, 0), 1);
    const delay = base * (1 - jitter) + base * jitter * rnd;
    return Math.round(delay);
  }
}

// --- Watchdog --------------------------------------------------------------

export interface TimerHandle {
  unref?: () => void;
}

export interface WatchdogTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultTimers: WatchdogTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * A feedable dead-man's timer. start() arms it; feed() resets it; if
 * `timeoutMs` elapses without a feed, onExpire fires exactly once (until
 * re-armed). Timers are unref'd so a live watchdog never keeps the process up.
 */
export class Watchdog {
  private handle: TimerHandle | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly onExpire: () => void,
    private readonly timers: WatchdogTimers = defaultTimers,
  ) {}

  get running(): boolean {
    return this.handle !== undefined;
  }

  start(): void {
    this.stop();
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      this.onExpire();
    }, this.timeoutMs);
    this.handle.unref?.();
  }

  /** Reset the timer (only if currently armed). */
  feed(): void {
    if (this.handle === undefined) return;
    this.start();
  }

  stop(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}
