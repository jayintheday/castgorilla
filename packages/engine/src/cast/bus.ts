/**
 * bus.ts — the transport seam between the channels and the socket.
 *
 * Channels (connection/heartbeat/receiver/media) never touch the castv2 socket
 * directly; they talk to a CastBus. CastClient implements CastBus. Because the
 * bus identity is stable across reconnects (only the underlying socket is
 * swapped), channel objects — and therefore the ReceiverController /
 * MediaController handed to callers — survive a reconnect unchanged.
 */

/** A raw inbound CASTV2 message (JSON string payloads only; binary is dropped upstream). */
export interface RawInbound {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** UTF-8 JSON payload. */
  data: string;
}

export interface CastBus {
  /** The id we send as (e.g. 'sender-0'). */
  readonly senderId: string;
  /** True while a live socket exists. */
  isConnected(): boolean;
  /** Serialize `payload` to JSON and send it. Throws if not connected. */
  send(sourceId: string, destinationId: string, namespace: string, payload: unknown): void;
  /** Register a raw-message listener. Returns an unsubscribe fn. */
  subscribe(handler: (msg: RawInbound) => void): () => void;
  /** Monotonic, connection-unique request id for correlation. */
  nextRequestId(): number;
}
