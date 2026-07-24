/**
 * mock-engine.ts — a fully-canned Engine implementation.
 *
 * Lets the Electron/UI agent build the whole app against the final engine API
 * shape before the real engine exists. Everything is deterministic:
 *  - discovery emits 2 fake devices ~500ms after start()
 *  - probe() returns a canned MediaInfo
 *  - plan() returns a canned PlaybackPlan
 *  - play() returns a fake PlaybackSession that walks the state machine
 *    (probing -> ... -> playing), ticks position at 1Hz, and honours
 *    pause/resume/seek/stop.
 *
 * Timers use setTimeout/setInterval so tests can drive them with fake timers.
 */

import { TypedEmitter } from '../util/emitter.js';
import { PROFILES } from '../devices/profiles.js';
import type {
  DeviceDiscovery,
  DiscoveryEvents,
  Engine,
  MediaInfo,
  PlaybackPlan,
  PlaybackSession,
  PlayOptions,
  SessionEvents,
  SessionState,
  SessionStatus,
  DiscoveredDevice,
  PlaybackPrefs,
  DeviceProfile,
} from '../types/index.js';

/** Milliseconds spent in each pre-playing state. Small so tests advance quickly. */
const STATE_STEP_MS = 60;
const POSITION_TICK_MS = 1000;

/** The two fake devices discovery surfaces. */
const FAKE_DEVICES: DiscoveredDevice[] = [
  {
    id: 'mock-ultra-0001',
    friendlyName: 'Living Room (Mock Ultra)',
    model: 'Chromecast Ultra',
    host: '192.168.1.50',
    port: 8009,
    profile: PROFILES.ultra,
  },
  {
    id: 'mock-gtv-0002',
    friendlyName: 'Bedroom (Mock Google TV)',
    model: 'Google TV Streamer',
    host: '192.168.1.51',
    port: 8009,
    profile: PROFILES['gtv-streamer'],
  },
];

/**
 * A tiny, valid JPEG (a 320x180 dark gradient) as a data URI, returned for every
 * `getThumbnail` request in mock mode. Keeps `CASTGORILLA_MOCK=1` screenshots
 * deterministic — the recents cards and the casting-view backdrop render
 * something real without a Chromecast or ffmpeg on the machine.
 */
export const CANNED_THUMBNAIL_DATA_URI =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABRAAEBAQEAAAAAAAAAAAAAAAAAAQUHAQEBAQEBAAAAAAAAAAAAAAAAAQMCBBABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIALQBQAMBEgACEgADEgD/2gAMAwEAAhEDEQA/AOSK9I84AAKAAAKAAKAoigAAoACgAAAoAAAoAAoCgAKAAAKACgAKAAKCgAAAoAAAKAAoAAAKAAoCgAAAoAAAKAAAAAAAAADLGYAACgAKAAKAoAAAoAAAKAAACgAKqACgCgAACgAoAKAAACgAKoAACgAAAoAAAKAAKgKCgKAAAKAAACgAAAAAAAAAAAyxmAoAAAKAAKAoACgAACgAAAoAAAKCgAAoAKAAoAKAAAKAAKAoACgAAAoAAAoAAKCiAAoCgAKAAACgAAAAAAAAAAAADLVmAAAoAAKCiKAACgAKAAACgAACgACgKAAoAAAoAKAAoAAoKAAACgAAAoACgAAAoACgKAAACgAAAoAAAAAAAAAAAAAMwZgCgAAAqoAKAoAAAKAAACgAKAAKAoAAAoAKACgAAAoACqAAAoAAAKAAACgACgKIoCgAACgAAAoAAAAAAAAAAAAAAAMwZgKAAKAoACgAACgAAAoAAAKAAKAoAKAAoAKAAAKAAKAoAAAKAAoAAAoAAKCiAAoCgAKAAACgAAAAAAAAAAAAAAAADNGYACgoAAAKAAACgAKAAAKAAKAoACgAACgAoACgACgoAAAKAAACgAKAAACqgAoCgAAAoAAAKAAAAAAAAAAAAAAAAADNGYAqoAKAoAAAKAAACgAKAAKAoAAAoAKACgAAAoACqAAAKAAAKAAACgACgKIoCgAACgAAAoAAAAAAAAAAAAAAAAAAAM0cAKAAoAAAKAAAKAAACgACgKACgAKAAAKACgACgKAAACgAKAAAKAACgogAKAoAAAKAAoAAAAAAAAAAAAAAAAAAAAAzhmoAAKAAACgAKAAAKAAKAoACgAACgAoACgACgoAAAKAAACgAKAAACqgAoCgAAAoAAAKAAAAAAAAAAAAAAAAAAAAADOHACgAAAoAAAKAAoAAoCgAACgAoACgAACgAKoAAAoAAAoAAAKAAKAoigKAAACgAACgAAAAAAAAAAAAAAAAAAAAAAAzhwAoAAAKACgAAAoAAoCgAoAAAKACgAoAAoCgAAAoAAAKAAoAAAoAAoCgAAAoAAAKAAAAAAAAAAAAAAAAAAAAAAAD/2Q==';

/** A representative canned probe result: HEVC Main10 HDR10 + E-AC-3 5.1 + subs. */
export function cannedMediaInfo(path = '/mock/media/sample.mkv'): MediaInfo {
  return {
    path,
    container: 'mkv',
    durationSec: 5400, // 90 minutes
    video: [
      {
        index: 0,
        codec: 'hevc',
        profile: 'Main 10',
        level: 51,
        width: 3840,
        height: 2160,
        fps: 23.976,
        bitDepth: 10,
        hdr: { type: 'hdr10' },
      },
    ],
    audio: [
      {
        index: 1,
        codec: 'eac3',
        channels: 6,
        channelLayout: '5.1',
        sampleRate: 48000,
        language: 'eng',
        title: 'Surround',
        isDefault: true,
      },
      {
        index: 2,
        codec: 'aac',
        channels: 2,
        channelLayout: 'stereo',
        sampleRate: 48000,
        language: 'eng',
        title: 'Stereo',
        isDefault: false,
      },
    ],
    subtitles: [
      {
        index: 3,
        codec: 'subrip',
        isText: true,
        language: 'eng',
        title: 'English',
        isDefault: true,
        isForced: false,
      },
      {
        index: 4,
        codec: 'hdmv_pgs',
        isText: false,
        language: 'fra',
        title: 'Français (PGS)',
        isDefault: false,
        isForced: false,
      },
    ],
  };
}

/** A representative canned plan: HLS, video-transcode down to H.264, E-AC-3 audio copy. */
export function cannedPlan(media: MediaInfo = cannedMediaInfo()): PlaybackPlan {
  return {
    method: 'hls',
    tier: 'video-transcode',
    reasons: [
      'HDR10 HEVC not directly playable on target; transcoding to H.264 SDR',
      'E-AC-3 within device passthrough capability; audio copied',
    ],
    video: {
      kind: 'transcode',
      encoder: 'h264_videotoolbox',
      quality: 60,
      scale: { w: 1920, h: 1080 },
      maxFps: 30,
    },
    audio: { kind: 'copy' },
    videoStreamIndex: media.video[0]?.index ?? 0,
    audioStreamIndex: media.audio[0]?.index ?? 1,
    segmentation: { mode: 'keyframe', targetSec: 6 },
    segmentFormat: 'fmp4',
    contentType: 'application/vnd.apple.mpegurl',
    durationSec: media.durationSec,
    hdrOutcome: 'washed-out-warning',
    subtitles: [
      {
        trackId: 3,
        url: 'http://127.0.0.1:0/sub/3.vtt',
        language: 'eng',
        label: 'English',
        source: 'embedded',
      },
    ],
  };
}

class MockDiscovery extends TypedEmitter<DiscoveryEvents> implements DeviceDiscovery {
  private devices: DiscoveredDevice[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setTimeout(() => {
      for (const device of FAKE_DEVICES) {
        this.devices.push(device);
        this.emit('device', device);
      }
    }, 500);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  list(): DiscoveredDevice[] {
    return [...this.devices];
  }

  /**
   * Re-emit whatever devices are already known (canned), so a manual Refresh in
   * mock mode produces the same 'device' → snapshot flow the real engine does —
   * giving the UI its feedback and a stable list. If start()'s initial reveal
   * has not yet fired, there is nothing to re-emit and this is a no-op.
   */
  rescan(): void {
    if (!this.started) return;
    for (const device of this.devices) this.emit('device', device);
  }
}

/** Ordered pre-playing states the mock session walks through. */
const STARTUP_SEQUENCE: SessionState[] = [
  'probing',
  'planning',
  'preparing',
  'connecting',
  'loading',
  'buffering',
  'playing',
];

class MockSession extends TypedEmitter<SessionEvents> implements PlaybackSession {
  readonly id: string;
  private _state: SessionState = 'probing';
  private _pos = 0;
  private readonly _dur: number;
  private _volume = 1;
  private _muted = false;
  private readonly _tier: PlaybackPlan['tier'];
  private readonly _deviceName: string;
  private _activeSub: number | null;
  private _activeAudio: number;
  private readonly _warnings: string[];

  private posTimer: ReturnType<typeof setInterval> | undefined;
  private readonly stepTimers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;

  constructor(opts: PlayOptions) {
    super();
    this.id = `mock-session-${Math.random().toString(36).slice(2, 10)}`;
    this._dur = opts.plan.durationSec || opts.media.durationSec || 0;
    this._tier = opts.plan.tier;
    this._deviceName = opts.device.friendlyName;
    this._activeAudio = opts.plan.audioStreamIndex;
    this._activeSub = opts.plan.subtitles[0]?.trackId ?? null;
    this._warnings =
      opts.plan.hdrOutcome === 'washed-out-warning'
        ? ['HDR content will be tone-mapped to SDR (may look washed out)']
        : [];
  }

  /** Kick off the state walk. Called by the engine right after construction. */
  begin(): void {
    STARTUP_SEQUENCE.forEach((state, i) => {
      const t = setTimeout(() => {
        if (this.stopped) return;
        this.setState(state);
        if (state === 'playing') this.startTicking();
      }, i * STATE_STEP_MS);
      this.stepTimers.push(t);
    });
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.emit('state', state);
  }

  private startTicking(): void {
    if (this.posTimer) return;
    this.posTimer = setInterval(() => {
      if (this._state !== 'playing') return;
      this._pos += 1;
      if (this._dur > 0 && this._pos >= this._dur) {
        this._pos = this._dur;
        this.emit('position', this._pos);
        this.finish();
        return;
      }
      this.emit('position', this._pos);
    }, POSITION_TICK_MS);
  }

  private stopTicking(): void {
    if (this.posTimer) clearInterval(this.posTimer);
    this.posTimer = undefined;
  }

  private finish(): void {
    this.stopTicking();
    this.setState('stopped');
    this.emit('ended');
  }

  status(): SessionStatus {
    return {
      state: this._state,
      positionSec: this._pos,
      durationSec: this._dur,
      volume: this._volume,
      muted: this._muted,
      tier: this._tier,
      deviceName: this._deviceName,
      activeSubtitleTrackId: this._activeSub,
      activeAudioStreamIndex: this._activeAudio,
      warnings: [...this._warnings],
    };
  }

  async pause(): Promise<void> {
    if (this.stopped) return;
    this.stopTicking();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.stopped) return;
    this.setState('playing');
    this.startTicking();
  }

  async seek(positionSec: number): Promise<void> {
    if (this.stopped) return;
    const wasPlaying = this._state === 'playing';
    this.setState('seeking');
    this._pos = Math.max(0, Math.min(positionSec, this._dur || positionSec));
    this.emit('position', this._pos);
    this.setState(wasPlaying ? 'playing' : 'paused');
    if (wasPlaying) this.startTicking();
  }

  async setVolume(volume: number): Promise<void> {
    this._volume = Math.max(0, Math.min(1, volume));
  }

  async setMuted(muted: boolean): Promise<void> {
    this._muted = muted;
  }

  async selectSubtitleTrack(trackId: number | null): Promise<void> {
    this._activeSub = trackId;
  }

  async selectAudioStream(index: number): Promise<void> {
    this._activeAudio = index;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.stepTimers) clearTimeout(t);
    this.stepTimers.length = 0;
    this.stopTicking();
    this.setState('stopped');
  }
}

/** The mock engine object. Shares the public Engine type with the real engine. */
export interface MockEngine extends Engine {
  discovery: MockDiscovery;
}

/**
 * Create a fully-canned engine for UI development and tests.
 * Every method returns deterministic data; play() produces a live fake session.
 */
export function createMockEngine(): MockEngine {
  const discovery = new MockDiscovery();
  return {
    discovery,

    async probe(file: string): Promise<MediaInfo> {
      return cannedMediaInfo(file);
    },

    plan(media: MediaInfo, _profile: DeviceProfile, _prefs: PlaybackPrefs): PlaybackPlan {
      return cannedPlan(media);
    },

    async play(opts: PlayOptions): Promise<PlaybackSession> {
      const session = new MockSession(opts);
      session.begin();
      return session;
    },

    async shutdown(): Promise<void> {
      discovery.stop();
    },
  };
}
