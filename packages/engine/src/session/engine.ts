/**
 * session/engine.ts — createEngine(): the real Engine implementation.
 *
 * Ties the workstreams together behind the frozen Engine interface:
 *  - discovery: a live CastDiscovery (mDNS).
 *  - probe():   ffprobe → MediaInfo.
 *  - plan():    pure buildPlaybackPlan passthrough (no I/O; the session re-plans
 *               with keyframe boundaries at play time).
 *  - play():    lazily starts the shared MediaServer + resolves ffmpeg, then hands
 *               off to PlaybackSession.start().
 *  - shutdown(): stops discovery, stops every live session, closes the server.
 *
 * The MediaServer and ffmpeg resolution are shared and lazy: probing many files
 * costs nothing until the first play().
 */

import { CastDiscovery } from '../devices/discovery.js';
import { MediaServer } from '../server/media-server.js';
import { resolveFfmpeg, type FfmpegTools } from '../ffmpeg/binary.js';
import { probe } from '../probe/ffprobe.js';
import { buildPlaybackPlan } from '../decide/decision.js';
import { createLogger, type Logger } from '../util/logger.js';
import { PlaybackSessionImpl } from './playback-session.js';
import type {
  DeviceProfile,
  Engine,
  MediaInfo,
  PlaybackPlan,
  PlaybackPrefs,
  PlaybackSession,
  PlayOptions,
} from '../types/index.js';

export interface CreateEngineOptions {
  logger?: Logger;
}

const DEFAULT_PREFS: PlaybackPrefs = { surround: false, hdrPolicy: 'warn' };

/**
 * Construct the real engine. Synchronous (matches createMockEngine): the server
 * binds and ffmpeg resolves lazily on the first play().
 */
export function createEngine(opts: CreateEngineOptions = {}): Engine {
  const logger = opts.logger ?? createLogger('castgorilla');
  const discovery = new CastDiscovery({ logger });
  const server = new MediaServer(logger.child('server'));
  const sessions = new Set<PlaybackSessionImpl>();

  let listening: Promise<number> | undefined;
  const ensureServer = (): Promise<number> => (listening ??= server.listen());

  let ffPromise: Promise<FfmpegTools> | undefined;
  const ensureFf = (): Promise<FfmpegTools> => (ffPromise ??= resolveFfmpeg());

  return {
    discovery,

    async probe(file: string): Promise<MediaInfo> {
      return probe(file);
    },

    plan(media: MediaInfo, profile: DeviceProfile, prefs: PlaybackPrefs): PlaybackPlan {
      return buildPlaybackPlan(media, profile, prefs);
    },

    async play(playOpts: PlayOptions): Promise<PlaybackSession> {
      const [, ff] = await Promise.all([ensureServer(), ensureFf()]);
      const session = await PlaybackSessionImpl.start({
        device: playOpts.device,
        media: playOpts.media,
        plan: playOpts.plan,
        prefs: playOpts.prefs ?? DEFAULT_PREFS,
        server,
        ff,
        logger,
      });
      sessions.add(session);
      const prune = (): void => void sessions.delete(session);
      session.on('ended', prune);
      session.on('error', prune);
      return session;
    },

    async shutdown(): Promise<void> {
      discovery.stop();
      const live = [...sessions];
      sessions.clear();
      await Promise.all(live.map((s) => s.stop().catch(() => undefined)));
      if (listening) await server.close();
    },
  };
}
