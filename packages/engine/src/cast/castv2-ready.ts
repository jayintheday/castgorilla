/**
 * castv2-ready.ts — protobuf warmup guard.
 *
 * castv2@0.1.10 loads its protobuf schema ASYNCHRONOUSLY at import time
 * (protobufjs `load(..., cb)`), so `CastMessage.serialize/parse` throw
 * 'extension not loaded yet' for the first ~tens of ms after import. On a cold
 * process the very first `client.send()` (our CONNECT) can hit that race.
 *
 * Both the sender (CastClient) and the MockCastReceiver await this once before
 * they touch the socket, so framing is guaranteed to be ready.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let readyPromise: Promise<void> | undefined;

/** Resolve once castv2's protobuf schema is usable. Memoized. */
export function ensureCastv2Ready(timeoutMs = 5000): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    // Reach into the package's internal proto module: it exposes CastMessage,
    // which the public index.js does not re-export.
    const proto = require('castv2/lib/proto') as {
      CastMessage: { serialize(data: unknown): Buffer };
    };
    const probe = {
      protocolVersion: 0,
      sourceId: 'sender-0',
      destinationId: 'receiver-0',
      namespace: 'urn:x-cast:com.google.cast.tp.connection',
      payloadType: 0,
      payloadUtf8: '{}',
    };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        proto.CastMessage.serialize(probe);
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`castv2 protobuf schema failed to load within ${timeoutMs}ms: ${String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  })();
  return readyPromise;
}
