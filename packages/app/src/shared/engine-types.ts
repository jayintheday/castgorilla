/**
 * engine-types.ts — the app's single TYPE bridge to @castgorilla/engine.
 *
 * This is a *type-only* re-export of the engine's FROZEN contract surface
 * (`packages/engine/src/types/*`). It is erased entirely at build time and pulls
 * in zero runtime code, so it is safe to import from the renderer, the preload,
 * the main process, and tests alike.
 *
 * We deliberately import from the engine's *built declarations*
 * (`../../../engine/dist/types/index.js`) rather than from `@castgorilla/engine`'s
 * root entry point, because that root entry (`src/index.ts`) is being rewritten
 * by a concurrent workstream. The `types/` contract, by contrast, is frozen.
 *
 * The RUNTIME coupling to the engine lives in exactly one other file —
 * `src/main/engine-host.ts` — which is the single line WS6b flips to swap the
 * MockEngine for the real engine. These types never change across that swap.
 */

export type {
  // media.ts
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
  // device.ts
  DeviceKey,
  DeviceProfile,
  DiscoveredDevice,
  // plan.ts
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
  // session.ts
  SessionState,
  SessionStatus,
  SessionEvents,
  DiscoveryEvents,
  DeviceDiscovery,
  PlaybackSession,
  PlayOptions,
  Engine,
} from '../../../engine/dist/types/index.js';
