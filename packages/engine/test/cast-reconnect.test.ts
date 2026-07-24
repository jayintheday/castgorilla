import { describe, it, expect, vi } from 'vitest';
import { Backoff, Watchdog, type WatchdogTimers, type TimerHandle } from '../src/cast/reconnect.js';

describe('Backoff', () => {
  it('doubles deterministically and caps at maxMs when jitter is 0', () => {
    const b = new Backoff({ initialMs: 250, maxMs: 4000, factor: 2, jitter: 0 });
    expect([b.nextDelay(), b.nextDelay(), b.nextDelay(), b.nextDelay(), b.nextDelay(), b.nextDelay()]).toEqual([
      250, 500, 1000, 2000, 4000, 4000,
    ]);
    expect(b.attempts).toBe(6);
  });

  it('applies full jitter as a fraction of the base delay (random=0 -> base*(1-jitter))', () => {
    const lo = new Backoff({ initialMs: 200, maxMs: 4000, factor: 2, jitter: 0.5, random: () => 0 });
    // base 200 -> 200*0.5 = 100; base 400 -> 200; base 800 -> 400
    expect([lo.nextDelay(), lo.nextDelay(), lo.nextDelay()]).toEqual([100, 200, 400]);

    const hi = new Backoff({ initialMs: 200, maxMs: 4000, factor: 2, jitter: 0.5, random: () => 1 });
    // random=1 -> full base
    expect([hi.nextDelay(), hi.nextDelay(), hi.nextDelay()]).toEqual([200, 400, 800]);
  });

  it('keeps every jittered delay within [base*(1-jitter), base]', () => {
    const b = new Backoff({ initialMs: 250, maxMs: 4000, factor: 2, jitter: 0.5 });
    for (let i = 0; i < 20; i++) {
      const base = b.peek();
      const delay = b.nextDelay();
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.5));
      expect(delay).toBeLessThanOrEqual(base);
    }
  });

  it('reset() returns to the first delay', () => {
    const b = new Backoff({ initialMs: 250, maxMs: 4000, factor: 2, jitter: 0 });
    b.nextDelay();
    b.nextDelay();
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.nextDelay()).toBe(250);
  });
});

/** A manually-advanced clock implementing WatchdogTimers. */
function makeClock(): { timers: WatchdogTimers; advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const timers: WatchdogTimers = {
    setTimeout(fn: () => void, ms: number): TimerHandle {
      const id = ++seq;
      tasks.set(id, { at: now + ms, fn });
      return { unref: () => {}, id } as unknown as TimerHandle & { id: number };
    },
    clearTimeout(handle: TimerHandle): void {
      const id = (handle as unknown as { id?: number }).id;
      if (id !== undefined) tasks.delete(id);
    },
  };
  return {
    timers,
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...tasks]) {
        if (t.at <= now) {
          tasks.delete(id);
          t.fn();
        }
      }
    },
    pending: () => tasks.size,
  };
}

describe('Watchdog', () => {
  it('fires onExpire exactly once after timeoutMs of silence', () => {
    const clock = makeClock();
    const onExpire = vi.fn();
    const wd = new Watchdog(100, onExpire, clock.timers);
    wd.start();
    clock.advance(99);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    // No re-arm after firing.
    clock.advance(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(wd.running).toBe(false);
  });

  it('feed() resets the countdown so it does not expire', () => {
    const clock = makeClock();
    const onExpire = vi.fn();
    const wd = new Watchdog(100, onExpire, clock.timers);
    wd.start();
    clock.advance(80);
    wd.feed();
    clock.advance(80);
    wd.feed();
    clock.advance(80);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advance(20);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stop() disarms it and does not fire', () => {
    const clock = makeClock();
    const onExpire = vi.fn();
    const wd = new Watchdog(100, onExpire, clock.timers);
    wd.start();
    wd.stop();
    expect(wd.running).toBe(false);
    clock.advance(1000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('feed() before start() is a no-op (only resets an armed timer)', () => {
    const clock = makeClock();
    const onExpire = vi.fn();
    const wd = new Watchdog(100, onExpire, clock.timers);
    wd.feed();
    expect(wd.running).toBe(false);
    clock.advance(1000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
