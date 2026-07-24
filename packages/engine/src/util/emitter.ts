/**
 * emitter.ts — a tiny typed EventEmitter wrapper.
 *
 * Both MockEngine (WS0) and the real engine (WS1-WS3) extend this so that
 * DeviceDiscovery / PlaybackSession event channels are statically typed. Wraps
 * Node's EventEmitter rather than extending it, to keep the public surface to
 * exactly on/once/off/emit with a typed event map.
 */

import { EventEmitter } from 'node:events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

export class TypedEmitter<T extends EventMap> {
  private readonly _emitter = new EventEmitter();

  constructor() {
    // Cast sessions can have several listeners (UI + logging + tests).
    this._emitter.setMaxListeners(50);
  }

  on<E extends keyof T>(event: E, listener: T[E]): this {
    this._emitter.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  once<E extends keyof T>(event: E, listener: T[E]): this {
    this._emitter.once(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof T>(event: E, listener: T[E]): this {
    this._emitter.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  protected emit<E extends keyof T>(event: E, ...args: Parameters<T[E]>): boolean {
    return this._emitter.emit(event as string, ...args);
  }

  removeAllListeners(event?: keyof T): this {
    this._emitter.removeAllListeners(event as string | undefined);
    return this;
  }

  listenerCount(event: keyof T): number {
    return this._emitter.listenerCount(event as string);
  }
}
