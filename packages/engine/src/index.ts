/**
 * @castgorilla/engine — public entry point.
 *
 * The full engine: frozen type contracts, device capability table, ffmpeg
 * resolution, probe + planner, cast transport, HLS + media server, and the live
 * PlaybackSession / createEngine() surface. The CLI and the Electron app import
 * everything they need from here — nothing reaches into subpaths.
 */

// --- Frozen type contracts -------------------------------------------------
export type * from './types/index.js';

// --- Device capability table + discovery -----------------------------------
export { PROFILES, resolveProfile } from './devices/profiles.js';
export { CastDiscovery } from './devices/discovery.js';
export type {
  CastDiscoveryOptions,
  CastMdnsProvider,
  CastMdnsBrowser,
  CastMdnsService,
} from './devices/discovery.js';

// --- ffmpeg resolution -----------------------------------------------------
export { resolveFfmpeg } from './ffmpeg/binary.js';
export type { FfmpegTools } from './ffmpeg/binary.js';

// --- Probe + planner -------------------------------------------------------
export { probe } from './probe/ffprobe.js';
export { extractKeyframeIndex } from './probe/keyframes.js';
export { buildPlaybackPlan, computeBoundaries, PlanRefusedError } from './decide/decision.js';
export type { PlanOptions } from './decide/decision.js';

// --- Cast transport --------------------------------------------------------
export { CastClient, MediaController, ReceiverController, NS } from './cast/client.js';
export type { CastClientEvents, CastClientOptions, ReconnectOptions } from './cast/client.js';

// --- Thumbnails (still-frame poster / backdrop) ----------------------------
export { generateStill, buildStillArgs, pickStillTimestamp } from './thumbnail/generate.js';
export type {
  GenerateStillOptions,
  BuildStillArgsOpts,
  ThumbnailVariant,
} from './thumbnail/generate.js';

// --- HLS + media server ----------------------------------------------------
export { HlsSession } from './hls/session.js';
export type { HlsSessionOpts } from './hls/session.js';
export { fixedBoundaries, segmentDuration } from './hls/boundaries.js';
export { synthesizeVodPlaylist } from './hls/playlist.js';
export { MediaServer, type RouteStats } from './server/media-server.js';

// --- Live playback session + engine ----------------------------------------
export { PlaybackSessionImpl } from './session/playback-session.js';
export type { SessionStartOptions, SessionDiagnostics } from './session/playback-session.js';
export { createEngine } from './session/engine.js';
export type { CreateEngineOptions } from './session/engine.js';

// --- Subtitles (WS5) -------------------------------------------------------
export { discoverSidecars, classifyExternalSidecar, languageName, languageMatches } from './subtitles/discover.js';
export type { SidecarSub, SubtitleFormat } from './subtitles/discover.js';
export { convertToVtt, extractEmbeddedToVtt } from './subtitles/convert.js';
export { resolveSubtitles, pickDefaultTrack } from './subtitles/resolve.js';
export type {
  ResolvedSubtitle,
  ResolveSubtitlesResult,
  ResolveSubtitlesOpts,
} from './subtitles/resolve.js';
export { SUBTITLE_STYLE } from './subtitles/style.js';

// --- Utilities -------------------------------------------------------------
export { createLogger, logger } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export { pickLanIp, ipv4ToInt } from './util/net.js';
export type { InterfaceAddr, InterfaceMap } from './util/net.js';
export { TypedEmitter } from './util/emitter.js';
export type { EventMap } from './util/emitter.js';

// --- Mock engine (for UI development) --------------------------------------
export { createMockEngine, cannedMediaInfo, cannedPlan } from './mock/mock-engine.js';
export type { MockEngine } from './mock/mock-engine.js';
