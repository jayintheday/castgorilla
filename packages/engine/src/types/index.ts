/**
 * types/index.ts — the frozen contract surface.
 * Every engine type is re-exported here (and again from src/index.ts).
 */

export type {
  MediaContainer,
  VideoCodec,
  AudioCodec,
  SubtitleCodec,
  HdrType,
  DoviProfile,
  HdrInfo,
  VideoStreamInfo,
  AudioStreamInfo,
  SubtitleStreamInfo,
  MediaInfo,
} from './media.js';

export type {
  DeviceKey,
  HevcProfileName,
  Vp9Profile,
  H264Caps,
  HevcCaps,
  Vp8Caps,
  Vp9Caps,
  Av1Caps,
  DeviceVideoCaps,
  DeviceHdrCaps,
  DeviceAudioCodec,
  DeviceHlsCaps,
  DeviceProfile,
  DiscoveredDevice,
} from './device.js';

export type {
  VideoAction,
  AudioAction,
  PlaybackMethod,
  PlaybackTier,
  SegmentFormat,
  SegmentationPlan,
  HdrOutcome,
  SubtitlePlanEntry,
  PlaybackPlan,
  PlaybackPrefs,
} from './plan.js';

export type {
  SessionState,
  SessionStatus,
  SessionEvents,
  DiscoveryEvents,
  EventSource,
  DeviceDiscovery,
  PlaybackSession,
  PlayOptions,
  Engine,
} from './session.js';

export type {
  CastPlayerState,
  CastIdleReason,
  CastStreamType,
  HlsSegmentFormat,
  HlsVideoSegmentFormat,
  CastTrackType,
  CastTextTrackSubtype,
  Track,
  CastEdgeType,
  TextTrackStyle,
  MediaMetadata,
  LoadMediaInformation,
  CastVolume,
  LoadRequest,
  MediaStatus,
  MediaStatusMessage,
} from './cast.js';
