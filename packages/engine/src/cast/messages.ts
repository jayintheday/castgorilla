/**
 * messages.ts — zod schemas for every INBOUND CASTV2 payload we trust.
 *
 * The wire is untrusted: a real device (or a hostile one) can send anything.
 * We validate before acting. `safeParse` failures are handled by the caller
 * (logged at debug, message ignored) — a malformed payload never crashes us.
 *
 * Schemas are permissive about EXTRA fields (devices add many we don't model)
 * but strict about the fields we depend on. Optional sub-objects use `.catch()`
 * so one malformed nested field degrades that field to `undefined` rather than
 * dropping the whole status.
 *
 * Outbound payloads are built inline by the channels (we control those); only
 * inbound needs validation.
 */

import { z } from 'zod';
import type {
  CastIdleReason,
  CastPlayerState,
  CastStreamType,
  CastVolume,
  LoadMediaInformation,
  MediaMetadata,
  MediaStatus,
  MediaStatusMessage,
  Track,
} from '../types/cast.js';

// --- Generic envelope: enough to route by type + correlate by requestId. -----

export const envelopeSchema = z.looseObject({
  type: z.string(),
  requestId: z.number().optional(),
});
export type CastEnvelope = z.infer<typeof envelopeSchema>;

// --- Heartbeat / connection control messages. --------------------------------

export const HEARTBEAT_TYPES = { ping: 'PING', pong: 'PONG' } as const;
export const CONNECTION_TYPES = { connect: 'CONNECT', close: 'CLOSE' } as const;

// --- Device error payloads (reject the matching in-flight request). ----------

/** Receiver/media error message types that reject a pending request. */
export const ERROR_TYPES: ReadonlySet<string> = new Set([
  'LOAD_FAILED',
  'LOAD_CANCELLED',
  'INVALID_PLAYER_STATE',
  'INVALID_REQUEST',
  'ERROR',
]);

export const errorMessageSchema = z.looseObject({
  type: z.string(),
  requestId: z.number().optional(),
  reason: z.string().optional(),
  detailedErrorCode: z.number().optional(),
  itemId: z.number().optional(),
});
export type CastErrorPayload = z.infer<typeof errorMessageSchema>;

// --- Media namespace: LoadMediaInformation + MediaStatus. --------------------

const streamTypeSchema: z.ZodType<CastStreamType> = z.enum(['BUFFERED', 'LIVE', 'NONE']);
const playerStateSchema: z.ZodType<CastPlayerState> = z.enum(['IDLE', 'BUFFERING', 'PLAYING', 'PAUSED']);
const idleReasonSchema: z.ZodType<CastIdleReason> = z.enum(['CANCELLED', 'INTERRUPTED', 'FINISHED', 'ERROR']);

const castVolumeSchema: z.ZodType<CastVolume> = z.object({
  level: z.number().optional(),
  muted: z.boolean().optional(),
});

const mediaMetadataSchema: z.ZodType<MediaMetadata> = z.looseObject({
  metadataType: z.number().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  images: z
    .array(z.object({ url: z.string(), width: z.number().optional(), height: z.number().optional() }))
    .optional(),
});

const trackSchema: z.ZodType<Track> = z.object({
  trackId: z.number(),
  type: z.enum(['TEXT', 'AUDIO', 'VIDEO']),
  trackContentId: z.string().optional(),
  trackContentType: z.string().optional(),
  subtype: z.enum(['SUBTITLES', 'CAPTIONS', 'DESCRIPTIONS', 'CHAPTERS', 'METADATA']).optional(),
  language: z.string().optional(),
  name: z.string().optional(),
});

const loadMediaInformationSchema: z.ZodType<LoadMediaInformation> = z.looseObject({
  contentId: z.string(),
  contentType: z.string(),
  streamType: streamTypeSchema,
  duration: z.number().optional(),
  metadata: mediaMetadataSchema.optional(),
  tracks: z.array(trackSchema).optional(),
  hlsSegmentFormat: z.enum(['FMP4', 'TS', 'TS_AAC', 'MPEG2_TS', 'AAC', 'AC3', 'MP3', 'E_AC3']).optional(),
  hlsVideoSegmentFormat: z.enum(['FMP4', 'MPEG2_TS']).optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

/** A single MediaStatus row. Missing required-by-contract fields get safe defaults. */
export const mediaStatusSchema: z.ZodType<MediaStatus> = z.looseObject({
  mediaSessionId: z.number(),
  playerState: playerStateSchema,
  currentTime: z.number().default(0),
  media: loadMediaInformationSchema.optional().catch(undefined),
  supportedMediaCommands: z.number().default(0),
  volume: castVolumeSchema.default({}),
  idleReason: idleReasonSchema.optional().catch(undefined),
  activeTrackIds: z.array(z.number()).optional(),
  playbackRate: z.number().optional(),
});

export const mediaStatusMessageSchema: z.ZodType<MediaStatusMessage> = z.looseObject({
  type: z.literal('MEDIA_STATUS'),
  requestId: z.number().default(0),
  status: z.array(mediaStatusSchema).default([]),
});

// --- Receiver namespace: RECEIVER_STATUS (applications + volume). ------------
// These types are WS1-owned (not in the frozen contract), so we define them here.

export interface CastNamespace {
  name: string;
}

export interface CastApplication {
  appId: string;
  sessionId: string;
  transportId: string;
  displayName?: string;
  statusText?: string;
  isIdleScreen?: boolean;
  namespaces?: CastNamespace[];
}

export interface ReceiverVolume {
  level?: number;
  muted?: boolean;
  controlType?: string;
  stepInterval?: number;
}

export interface ReceiverStatus {
  applications?: CastApplication[];
  volume?: ReceiverVolume;
  isActiveInput?: boolean;
  isStandBy?: boolean;
}

export interface ReceiverStatusMessage {
  type: 'RECEIVER_STATUS';
  requestId: number;
  status: ReceiverStatus;
}

const castNamespaceSchema: z.ZodType<CastNamespace> = z.object({ name: z.string() });

const castApplicationSchema: z.ZodType<CastApplication> = z.looseObject({
  appId: z.string(),
  sessionId: z.string(),
  transportId: z.string(),
  displayName: z.string().optional(),
  statusText: z.string().optional(),
  isIdleScreen: z.boolean().optional(),
  namespaces: z.array(castNamespaceSchema).optional().catch(undefined),
});

const receiverVolumeSchema: z.ZodType<ReceiverVolume> = z.object({
  level: z.number().optional(),
  muted: z.boolean().optional(),
  controlType: z.string().optional(),
  stepInterval: z.number().optional(),
});

export const receiverStatusSchema: z.ZodType<ReceiverStatus> = z.looseObject({
  applications: z.array(castApplicationSchema).optional().catch(undefined),
  volume: receiverVolumeSchema.optional(),
  isActiveInput: z.boolean().optional(),
  isStandBy: z.boolean().optional(),
});

export const receiverStatusMessageSchema: z.ZodType<ReceiverStatusMessage> = z.looseObject({
  type: z.literal('RECEIVER_STATUS'),
  requestId: z.number().default(0),
  status: receiverStatusSchema.default({}),
});

/**
 * Safely parse a UTF-8 payload string into a typed object of type T using the
 * given schema. Returns `undefined` on JSON-parse failure or schema mismatch;
 * the caller logs + ignores. Never throws.
 */
export function safeParseJson<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(obj);
  return result.success ? result.data : undefined;
}
