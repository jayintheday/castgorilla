/**
 * session.ts — FROZEN CONTRACT
 *
 * The live playback session surface: state machine, status snapshot, typed
 * event maps, and the top-level engine API interfaces that both MockEngine
 * (WS0) and the real engine (WS1-WS3) implement.
 */

import type { MediaInfo } from './media.js';
import type { DeviceProfile, DiscoveredDevice } from './device.js';
import type { PlaybackPlan, PlaybackPrefs, PlaybackTier } from './plan.js';

export type SessionState =
  | 'probing'
  | 'planning'
  | 'preparing'
  | 'connecting'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'reconnecting'
  | 'stopped'
  | 'error';

export interface SessionStatus {
  state: SessionState;
  positionSec: number;
  durationSec: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
  tier: PlaybackTier;
  deviceName: string;
  /** trackId of the active subtitle track, or null when subtitles are off. */
  activeSubtitleTrackId: number | null;
  /** ffprobe absolute index of the active audio stream. */
  activeAudioStreamIndex: number;
  warnings: string[];
}

/**
 * Typed event map for a PlaybackSession.
 * Channels: 'state' | 'position' | 'warning' | 'ended' | 'error'.
 *
 * Declared as a `type` (not `interface`) so it structurally satisfies the
 * `Record<string, listener>` constraint that TypedEmitter requires.
 */
export type SessionEvents = {
  state: (state: SessionState) => void;
  position: (positionSec: number) => void;
  warning: (warning: string) => void;
  ended: () => void;
  error: (err: Error) => void;
};

/** Typed event map for DeviceDiscovery. */
export type DiscoveryEvents = {
  device: (device: DiscoveredDevice) => void;
  removed: (id: string) => void;
  error: (err: Error) => void;
};

/**
 * A typed event emitter surface. Implemented by TypedEmitter; declared here so
 * the contract interfaces can require on/once/off without importing the class.
 */
export interface EventSource<T> {
  on<E extends keyof T>(event: E, listener: T[E]): this;
  once<E extends keyof T>(event: E, listener: T[E]): this;
  off<E extends keyof T>(event: E, listener: T[E]): this;
}

/** mDNS-based Chromecast discovery. Emits 'device' as devices appear. */
export interface DeviceDiscovery extends EventSource<DiscoveryEvents> {
  start(): void;
  stop(): void;
  /** Snapshot of currently-known devices. */
  list(): DiscoveredDevice[];
  /**
   * Re-issue the mDNS query without dropping the current list. mDNS is a
   * subscription, not a poll — `list()` alone only ever returns what already
   * arrived — so a device that was asleep/ambient at start() (or missed its
   * announcement) will never appear no matter how often the UI re-lists. This
   * re-sends the query so responsive devices re-announce and flow in through the
   * usual 'device' path. A no-op when discovery has not been started.
   */
  rescan(): void;
}

/** A live cast playback session. Controls and status for one playing item. */
export interface PlaybackSession extends EventSource<SessionEvents> {
  readonly id: string;
  status(): SessionStatus;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Seek to an absolute position in seconds. */
  seek(positionSec: number): Promise<void>;
  /** Set volume 0..1. */
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** Switch the active subtitle track, or null to turn subtitles off. */
  selectSubtitleTrack(trackId: number | null): Promise<void>;
  /** Switch the active audio stream by ffprobe absolute index. */
  selectAudioStream(index: number): Promise<void>;
  stop(): Promise<void>;
}

/** Options for Engine.play(). */
export interface PlayOptions {
  device: DiscoveredDevice;
  media: MediaInfo;
  plan: PlaybackPlan;
  prefs?: PlaybackPrefs;
}

/**
 * The public engine API. The TYPE is final; MockEngine (WS0) implements it with
 * canned data and the real engine (WS1-WS3) implements it for real.
 */
export interface Engine {
  discovery: DeviceDiscovery;
  probe(file: string): Promise<MediaInfo>;
  plan(media: MediaInfo, profile: DeviceProfile, prefs: PlaybackPrefs): PlaybackPlan;
  play(opts: PlayOptions): Promise<PlaybackSession>;
  shutdown(): Promise<void>;
}
