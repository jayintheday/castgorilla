/**
 * device.ts — FROZEN CONTRACT
 *
 * DeviceProfile is the decode-capability table for a class of Chromecast /
 * Google TV hardware. The planner (WS2) reads a profile to decide direct-play
 * vs. remux vs. transcode. DiscoveredDevice is what mDNS discovery (WS1) emits.
 */

export type DeviceKey =
  | 'gen1'
  | 'gen2'
  | 'gen3'
  | 'ultra'
  | 'ccgtv'
  | 'gtv-streamer'
  | 'shield'
  | 'unknown';

export type HevcProfileName = 'main' | 'main10';
/** VP9 profile numbers: 0 = 8-bit 4:2:0, 2 = 10/12-bit 4:2:0. */
export type Vp9Profile = 0 | 2;

export interface H264Caps {
  /** Max H.264 level, no dot (e.g. 41 = Level 4.1, 52 = Level 5.2). */
  maxLevel: number;
  maxW: number;
  maxH: number;
  maxFps: number;
}

export interface HevcCaps {
  profiles: HevcProfileName[];
  maxLevel: number;
  maxW: number;
  maxH: number;
  maxFps: number;
}

export interface Vp8Caps {
  maxW: number;
  maxH: number;
  maxFps: number;
}

export interface Vp9Caps {
  profiles: Vp9Profile[];
  maxLevel: number;
  maxW: number;
  maxH: number;
  maxFps: number;
}

export interface Av1Caps {
  maxLevel: number;
  maxW: number;
  maxH: number;
  maxFps: number;
}

export interface DeviceVideoCaps {
  h264: H264Caps;
  hevc?: HevcCaps;
  vp8?: Vp8Caps;
  vp9?: Vp9Caps;
  av1?: Av1Caps;
}

export interface DeviceHdrCaps {
  hdr10: boolean;
  dv: boolean;
}

/** Audio codecs the device can decode natively (opus is deliberately absent for video Chromecasts). */
export type DeviceAudioCodec = 'aac' | 'mp3' | 'flac' | 'vorbis' | 'pcm';

export interface DeviceHlsCaps {
  /** fMP4 (CMAF) HLS segment support. 'untested' until a hardware spike confirms it. */
  fmp4: boolean | 'untested';
  /** HEVC carried inside HLS. 'untested' until a hardware spike confirms it. */
  hevcInHls: boolean | 'untested';
  /** Fallback segment container when fMP4 is unavailable; null if no fallback defined yet. */
  segmentFormatFallback: 'ts' | null;
}

export interface DeviceProfile {
  key: DeviceKey;
  /** mDNS TXT `md` values that map to this profile (matched exact-then-prefix, case-insensitive). */
  matchModels: string[];
  video: DeviceVideoCaps;
  hdr: DeviceHdrCaps;
  audioCodecs: DeviceAudioCodec[];
  /** Whether AC-3 / E-AC-3 bitstream passthrough is possible (sink-dependent; gated by a user toggle elsewhere). */
  surroundPassthrough: boolean;
  hls: DeviceHlsCaps;
}

export interface DiscoveredDevice {
  /** Stable identifier (Cast device id / mDNS instance). */
  id: string;
  friendlyName: string;
  /** Raw model string reported by the device (mDNS TXT `md`). */
  model: string;
  host: string;
  port: number;
  profile: DeviceProfile;
}
