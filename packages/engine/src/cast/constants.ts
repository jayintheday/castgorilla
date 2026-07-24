/**
 * constants.ts — CASTV2 protocol constants (namespaces, well-known ids, timings).
 * Research-verified against the Google Cast v2 protocol (2026-07).
 */

/** CASTV2 namespaces. Payloads are JSON strings on these namespaced channels. */
export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const;

/** Well-known destination for the platform receiver (heartbeat/connection/launch). */
export const PLATFORM_RECEIVER_ID = 'receiver-0';

/** Default sender id we identify as. */
export const DEFAULT_SENDER_ID = 'sender-0';

/** appId of the Default Media Receiver (DMR). */
export const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';

/** Default TLS port for a Chromecast CASTV2 endpoint. */
export const CAST_PORT = 8009;

/** Timing defaults (ms). */
export const DEFAULTS = {
  /** Interval between outbound heartbeat PINGs. */
  heartbeatIntervalMs: 5000,
  /** Silence (no PONG) after which the link is declared dead. */
  heartbeatTimeoutMs: 10_000,
  /** Per-request response timeout for most commands. */
  requestTimeoutMs: 5000,
  /** LOAD is slow (device fetches + probes the manifest). */
  loadTimeoutMs: 30_000,
  /** TLS connect timeout. */
  connectTimeoutMs: 10_000,
} as const;
