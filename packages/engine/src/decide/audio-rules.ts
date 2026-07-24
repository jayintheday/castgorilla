/**
 * audio-rules.ts — the audio verdict.
 *
 * Decides copy vs transcode per audio codec, honoring the surround preference
 * and the delivery method (some codecs — flac/pcm/vorbis — are copyable only in
 * a direct-play container, and must be transcoded once we drop to HLS).
 *
 * Transcode targets are always device-safe: E-AC-3 (5.1) when keeping surround,
 * or AAC (stereo downmix) otherwise. AudioToolbox AAC mishandles the '(side)'
 * channel layout PCE, so a channelmap filter normalizes it first.
 */

import type { AudioAction, PlaybackMethod, PlaybackPrefs } from '../types/index.js';
import type { AudioStreamInfo } from '../types/media.js';

type TranscodeAudio = Extract<AudioAction, { kind: 'transcode' }>;

export interface AudioVerdict {
  action: AudioAction;
  reasons: string[];
}

function eac3_640(): TranscodeAudio {
  return { kind: 'transcode', encoder: 'eac3', bitrate: '640k', channels: 6 };
}

function aac_stereo(bitrate: string): TranscodeAudio {
  return { kind: 'transcode', encoder: 'aac_at', bitrate, channels: 2 };
}

/** eac3 5.1 when we can/should keep surround, else an AAC stereo downmix. */
function surroundOrDownmix(
  a: AudioStreamInfo,
  prefs: PlaybackPrefs,
  aacBitrate: string,
): TranscodeAudio {
  return prefs.surround && a.channels > 2 ? eac3_640() : aac_stereo(aacBitrate);
}

/** Add the '(side)' PCE-trap channelmap when the target is AudioToolbox AAC. */
function withChannelmap(action: TranscodeAudio, a: AudioStreamInfo): TranscodeAudio {
  if (action.encoder === 'aac_at' && /\(side\)/.test(a.channelLayout)) {
    return { ...action, filters: ['channelmap=channel_layout=5.1'] };
  }
  return action;
}

/**
 * Decide what to do with the audio stream. `method` matters only for
 * flac/pcm/vorbis, which are copied in a direct container but transcoded in HLS.
 */
export function decideAudio(
  a: AudioStreamInfo,
  prefs: PlaybackPrefs,
  method: PlaybackMethod,
): AudioVerdict {
  const reasons: string[] = [];
  const label = `audio: ${a.codec}${a.channels ? ` ${a.channels}ch` : ''}`;

  const transcode = (action: TranscodeAudio, why: string): AudioVerdict => {
    reasons.push(`${label} → ${why}`);
    return { action: withChannelmap(action, a), reasons };
  };
  const copy = (why: string): AudioVerdict => {
    reasons.push(`${label} → copy (${why})`);
    return { action: { kind: 'copy' }, reasons };
  };

  switch (a.codec) {
    case 'dts':
    case 'truehd':
    case 'opus':
    case 'other':
      return transcode(surroundOrDownmix(a, prefs, '192k'), 'not device-decodable, re-encoding');

    case 'aac':
      if (a.channels <= 2) return copy('stereo AAC is universally supported');
      // Multichannel AAC is downmixed by Chromecast — never copy it.
      return transcode(
        surroundOrDownmix(a, prefs, '192k'),
        'multichannel AAC is downmixed by Chromecast; re-encoding',
      );

    case 'ac3':
    case 'eac3':
      if (prefs.surround) return copy('surround passthrough');
      return transcode(aac_stereo('192k'), 'stereo downmix (surround off)');

    case 'mp3':
      return copy('MP3 is universally supported');

    case 'flac':
    case 'pcm':
    case 'vorbis':
      if (method === 'direct') return copy('lossless/native codec legal in direct container');
      return transcode(
        prefs.surround && a.channels > 2 ? eac3_640() : aac_stereo('256k'),
        'not carriable in HLS; re-encoding',
      );
  }
}
