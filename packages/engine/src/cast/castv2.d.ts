/**
 * castv2.d.ts — ambient types for the `castv2` npm package (0.1.10), which ships
 * no type declarations of its own. We only declare the surface WS1 actually uses:
 * the `Client` (sender) and `Server` (used by the MockCastReceiver). The package
 * handles CASTV2 framing + protobuf; payloads are opaque UTF-8 JSON strings.
 */
declare module 'castv2' {
  import type { EventEmitter } from 'node:events';
  import type { TlsOptions } from 'node:tls';

  export interface ClientConnectOptions {
    host: string;
    port?: number;
    /** Forced to false by the library (self-signed device certs). */
    rejectUnauthorized?: boolean;
    [key: string]: unknown;
  }

  /** CASTV2 sender socket. Emits: 'connect' | 'error'(Error) | 'close' | 'message'. */
  export class Client extends EventEmitter {
    connect(options: string | ClientConnectOptions, callback?: () => void): void;
    close(): void;
    send(sourceId: string, destinationId: string, namespace: string, data: string | Buffer): void;
    createChannel(sourceId: string, destinationId: string, namespace: string, encoding?: string): unknown;
  }

  /** CASTV2 receiver socket (used by the in-process mock). Emits: 'message' | 'error' | 'close'. */
  export class Server extends EventEmitter {
    constructor(options?: TlsOptions);
    clients: Record<string, { socket: import('node:net').Socket; ps: unknown }>;
    listen(port?: number, host?: string, callback?: () => void): void;
    listen(port: number, callback: () => void): void;
    close(): void;
    send(clientId: string, sourceId: string, destinationId: string, namespace: string, data: string | Buffer): void;
  }

  export const DeviceAuthMessage: { serialize(data: unknown): Buffer; parse(data: Buffer): unknown };
}
