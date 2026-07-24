/**
 * log.ts — the main process's two-line logger.
 *
 * The app has no logging framework of its own; what it does have is a habit of
 * writing single prefixed lines to stdout/stderr (`[engine-gate] {...}` at
 * startup) that get captured with `open --stdout /tmp/ss.log ...`. These helpers
 * make that habit uniform and — crucially — make app-tier lines greppable
 * alongside the engine's, which already logs `WARN [cast] connection lost` in
 * exactly this shape. When a playback failure has to be reconstructed after the
 * fact from one log file, a consistent `LEVEL [area] message` is worth a lot.
 */

/** Info-level line, e.g. `INFO [power] acquired ...`. */
export function logInfo(area: string, message: string): void {
  console.log(`INFO [${area}] ${message}`);
}

/** Warn-level line, e.g. `WARN [ipc] session:pause failed ...`. */
export function logWarn(area: string, message: string): void {
  console.warn(`WARN [${area}] ${message}`);
}

/**
 * Error-level line, e.g. `ERROR [session] ss-98826911 error — receiver reported
 * a playback error`.
 *
 * The one level that must never be missing: a failure the user only ever saw as
 * a toast is unreconstructable afterwards unless it is also on this line.
 */
export function logError(area: string, message: string): void {
  console.error(`ERROR [${area}] ${message}`);
}
