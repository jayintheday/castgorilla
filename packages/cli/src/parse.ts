/**
 * parse.ts — pure argument/value parsing helpers (no engine or I/O deps).
 *
 * Kept separate so the fiddly bits (mm:ss timecodes, volume clamping) are unit
 * tested in isolation from the command plumbing.
 */

/**
 * Parse a position argument: plain seconds ("90", "90.5"), "mm:ss", or
 * "hh:mm:ss". Returns seconds, or null when the input is not a valid timecode.
 */
export function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (s.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s); // plain seconds

  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    nums.push(Number(p));
  }
  // The seconds/minutes fields must be < 60 (hours field is unbounded).
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! >= 60) return null;
  }
  let sec = 0;
  for (const n of nums) sec = sec * 60 + n;
  return sec;
}

/** Format seconds as "m:ss" (under an hour) or "h:mm:ss". */
export function formatTimecode(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Parse a 0..1 volume argument, clamped. Returns null on a non-numeric input. */
export function parseVolume(input: string): number | null {
  const n = Number(input.trim());
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** Render a 0..1 volume as an integer percentage string, e.g. "40%". */
export function formatPercent(volume: number): string {
  return `${Math.round(Math.max(0, Math.min(1, volume)) * 100)}%`;
}

/** Validate an --hdr policy argument. */
export function parseHdrPolicy(input: string | undefined): 'warn' | 'block' | null {
  if (input === undefined) return 'warn';
  if (input === 'warn' || input === 'block') return input;
  return null;
}
