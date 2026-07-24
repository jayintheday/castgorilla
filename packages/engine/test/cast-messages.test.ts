import { describe, it, expect } from 'vitest';
import {
  ERROR_TYPES,
  envelopeSchema,
  errorMessageSchema,
  mediaStatusMessageSchema,
  receiverStatusMessageSchema,
  safeParseJson,
} from '../src/cast/messages.js';

describe('envelopeSchema', () => {
  it('extracts type + requestId and tolerates extra fields', () => {
    const r = envelopeSchema.safeParse({ type: 'MEDIA_STATUS', requestId: 7, extra: { a: 1 }, nope: 'ok' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.type).toBe('MEDIA_STATUS');
    expect(r.success && r.data.requestId).toBe(7);
  });

  it('rejects a payload with no type', () => {
    expect(envelopeSchema.safeParse({ requestId: 1 }).success).toBe(false);
  });
});

describe('mediaStatusMessageSchema', () => {
  it('parses a full MEDIA_STATUS and preserves the media block', () => {
    const parsed = mediaStatusMessageSchema.safeParse({
      type: 'MEDIA_STATUS',
      requestId: 3,
      status: [
        {
          mediaSessionId: 1,
          playerState: 'PLAYING',
          currentTime: 12.5,
          supportedMediaCommands: 12303,
          volume: { level: 0.8, muted: false },
          media: {
            contentId: 'http://host/master.m3u8',
            contentType: 'application/vnd.apple.mpegurl',
            streamType: 'BUFFERED',
            duration: 5400,
            hlsSegmentFormat: 'FMP4',
          },
          activeTrackIds: [3],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const s = parsed.data.status[0]!;
    expect(s.playerState).toBe('PLAYING');
    expect(s.media?.contentId).toBe('http://host/master.m3u8');
    expect(s.media?.hlsSegmentFormat).toBe('FMP4');
    expect(s.activeTrackIds).toEqual([3]);
  });

  it('fills defaults for contract-required fields that a sparse push omits', () => {
    const parsed = mediaStatusMessageSchema.safeParse({
      type: 'MEDIA_STATUS',
      status: [{ mediaSessionId: 1, playerState: 'BUFFERING' }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requestId).toBe(0); // unsolicited default
    const s = parsed.data.status[0]!;
    expect(s.currentTime).toBe(0);
    expect(s.supportedMediaCommands).toBe(0);
    expect(s.volume).toEqual({});
  });

  it('degrades a malformed nested media block to undefined instead of failing the status', () => {
    const parsed = mediaStatusMessageSchema.safeParse({
      type: 'MEDIA_STATUS',
      requestId: 1,
      status: [
        {
          mediaSessionId: 1,
          playerState: 'PLAYING',
          currentTime: 1,
          supportedMediaCommands: 1,
          volume: {},
          media: { contentId: 'x' /* missing contentType/streamType */ },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status[0]!.media).toBeUndefined();
    expect(parsed.data.status[0]!.playerState).toBe('PLAYING');
  });

  it('rejects a bogus playerState enum', () => {
    const parsed = mediaStatusMessageSchema.safeParse({
      type: 'MEDIA_STATUS',
      status: [{ mediaSessionId: 1, playerState: 'DANCING' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('receiverStatusMessageSchema', () => {
  it('parses applications with transportId/sessionId + volume', () => {
    const parsed = receiverStatusMessageSchema.safeParse({
      type: 'RECEIVER_STATUS',
      requestId: 2,
      status: {
        applications: [
          {
            appId: 'CC1AD845',
            sessionId: 'sess-1',
            transportId: 'transport-1',
            displayName: 'Default Media Receiver',
            namespaces: [{ name: 'urn:x-cast:com.google.cast.media' }],
          },
        ],
        volume: { level: 0.5, muted: false, controlType: 'attenuation', stepInterval: 0.05 },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status.applications?.[0]?.transportId).toBe('transport-1');
    expect(parsed.data.status.volume?.level).toBe(0.5);
  });

  it('defaults status to {} when the receiver reports nothing running', () => {
    const parsed = receiverStatusMessageSchema.safeParse({ type: 'RECEIVER_STATUS', requestId: 9 });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toEqual({});
  });
});

describe('error payloads', () => {
  it('recognizes the receiver/media error message types', () => {
    for (const t of ['LOAD_FAILED', 'LOAD_CANCELLED', 'INVALID_PLAYER_STATE', 'INVALID_REQUEST', 'ERROR']) {
      expect(ERROR_TYPES.has(t)).toBe(true);
    }
    expect(ERROR_TYPES.has('MEDIA_STATUS')).toBe(false);
  });

  it('extracts requestId + reason + detailedErrorCode', () => {
    const parsed = errorMessageSchema.safeParse({
      type: 'LOAD_FAILED',
      requestId: 5,
      reason: 'CONTENT_UNSUPPORTED',
      detailedErrorCode: 104,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requestId).toBe(5);
    expect(parsed.data.reason).toBe('CONTENT_UNSUPPORTED');
    expect(parsed.data.detailedErrorCode).toBe(104);
  });
});

describe('safeParseJson', () => {
  it('returns undefined for non-JSON strings (never throws)', () => {
    expect(safeParseJson(envelopeSchema, '{ not json ]')).toBeUndefined();
    expect(safeParseJson(envelopeSchema, '')).toBeUndefined();
  });

  it('returns undefined for JSON that fails the schema', () => {
    expect(safeParseJson(envelopeSchema, JSON.stringify({ requestId: 1 }))).toBeUndefined();
  });

  it('returns the typed value for a valid payload', () => {
    const v = safeParseJson(envelopeSchema, JSON.stringify({ type: 'PONG' }));
    expect(v?.type).toBe('PONG');
  });
});
