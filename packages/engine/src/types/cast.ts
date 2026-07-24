/**
 * cast.ts — FROZEN CONTRACT
 *
 * Google Cast v2 media-namespace wire types. These mirror the JSON the default
 * media receiver speaks over the castv2 channel. The cast agent (WS1) implements
 * send/receive against exactly these shapes. Field names match the protocol
 * (camelCase, protocol-literal enum strings) and MUST NOT be renamed.
 *
 * Namespace: urn:x-cast:com.google.cast.media
 */

export type CastPlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

export type CastIdleReason =
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'FINISHED'
  | 'ERROR';

export type CastStreamType = 'BUFFERED' | 'LIVE' | 'NONE';

/** HLS audio+video multiplexed segment format (LoadRequest.media.hlsSegmentFormat). */
export type HlsSegmentFormat =
  | 'FMP4'
  | 'TS'
  | 'TS_AAC'
  | 'MPEG2_TS'
  | 'AAC'
  | 'AC3'
  | 'MP3'
  | 'E_AC3';

/** HLS video-only segment format (LoadRequest.media.hlsVideoSegmentFormat). */
export type HlsVideoSegmentFormat = 'FMP4' | 'MPEG2_TS';

export type CastTrackType = 'TEXT' | 'AUDIO' | 'VIDEO';
export type CastTextTrackSubtype = 'SUBTITLES' | 'CAPTIONS' | 'DESCRIPTIONS' | 'CHAPTERS' | 'METADATA';

/** Cast media Track (subtitles are TEXT tracks with a VTT trackContentId URL). */
export interface Track {
  trackId: number;
  type: CastTrackType;
  /** URL to the track content (for TEXT tracks, the .vtt file). */
  trackContentId?: string;
  /** MIME type, e.g. 'text/vtt'. */
  trackContentType?: string;
  subtype?: CastTextTrackSubtype;
  /** RFC 5646 language tag. */
  language?: string;
  name?: string;
}

export type CastEdgeType = 'NONE' | 'OUTLINE' | 'DROP_SHADOW' | 'RAISED' | 'DEPRESSED';

/** TextTrackStyle — colors are #RRGGBBAA strings. */
export interface TextTrackStyle {
  fontScale?: number;
  /** #RRGGBBAA, e.g. '#FFFFFFFF'. */
  foregroundColor?: string;
  /** #RRGGBBAA, e.g. '#00000080'. */
  backgroundColor?: string;
  edgeType?: CastEdgeType;
  edgeColor?: string;
  fontFamily?: string;
  fontGenericFamily?: string;
  windowColor?: string;
}

export interface MediaMetadata {
  /** 0 = GENERIC, 1 = MOVIE, 2 = TV_SHOW, 3 = MUSIC_TRACK, 4 = PHOTO. */
  metadataType?: number;
  title?: string;
  subtitle?: string;
  images?: { url: string; width?: number; height?: number }[];
  [key: string]: unknown;
}

/** MediaInformation — the `media` field of a load request / MediaStatus. */
export interface LoadMediaInformation {
  /** Playback URL (HLS manifest or direct file URL). */
  contentId: string;
  /** MIME type, e.g. 'application/vnd.apple.mpegurl', 'video/mp4'. */
  contentType: string;
  streamType: CastStreamType;
  duration?: number;
  metadata?: MediaMetadata;
  tracks?: Track[];
  textTrackStyle?: TextTrackStyle;
  hlsSegmentFormat?: HlsSegmentFormat;
  hlsVideoSegmentFormat?: HlsVideoSegmentFormat;
  customData?: Record<string, unknown>;
}

export interface CastVolume {
  level?: number;
  muted?: boolean;
}

/** LOAD request payload (sender -> receiver). */
export interface LoadRequest {
  type: 'LOAD';
  requestId: number;
  media: LoadMediaInformation;
  autoplay?: boolean;
  currentTime?: number;
  /** Ordered trackIds to activate on load. */
  activeTrackIds?: number[];
  customData?: Record<string, unknown>;
}

/** MediaStatus payload (receiver -> sender). */
export interface MediaStatus {
  mediaSessionId: number;
  playerState: CastPlayerState;
  currentTime: number;
  /** Present in the initial status after LOAD. */
  media?: LoadMediaInformation;
  /** Bitmask of supported media commands (pause, seek, stream volume, etc.). */
  supportedMediaCommands: number;
  volume: CastVolume;
  /** Present when playerState === 'IDLE'. */
  idleReason?: CastIdleReason;
  /** Currently active track ids (e.g. selected subtitle track). */
  activeTrackIds?: number[];
  playbackRate?: number;
}

/** Envelope for a MEDIA_STATUS message, which carries an array of statuses. */
export interface MediaStatusMessage {
  type: 'MEDIA_STATUS';
  requestId: number;
  status: MediaStatus[];
}
