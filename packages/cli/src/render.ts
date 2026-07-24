/**
 * render.ts — human + JSON renderers for the CLI (pure; TYPE-only engine deps).
 *
 * The `probe` command is the debugging workhorse, so the human output is built
 * to be scanned quickly: a compact media summary followed by the resolved plan
 * (tier, per-stream actions, segment format, and the reasons trail).
 */

import { basename } from 'node:path';
import { formatTimecode } from './parse.js';
import type {
  DiscoveredDevice,
  MediaInfo,
  PlaybackPlan,
  VideoAction,
  AudioAction,
  SidecarSub,
} from '@castgorilla/engine';

/** Align rows into a simple 2-space-gutter table with an underlined header. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  const out = [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(fmt(r));
  return out.join('\n');
}

export function renderDeviceTable(devices: DiscoveredDevice[]): string {
  if (devices.length === 0) return 'No Chromecast devices found.';
  const rows = devices.map((d) => [
    d.friendlyName,
    d.model || '—',
    d.profile.key,
    `${d.host}:${d.port}`,
  ]);
  return table(['NAME', 'MODEL', 'PROFILE', 'HOST'], rows);
}

function describeVideoStream(v: MediaInfo['video'][number]): string {
  const bits: string[] = [v.codec];
  if (v.profile) bits.push(v.profile);
  bits.push(`${v.width}x${v.height}`);
  bits.push(`${v.fps}fps`);
  bits.push(`${v.bitDepth}-bit`);
  if (v.hdr.type !== 'none') bits.push(v.hdr.type.toUpperCase() + (v.hdr.doviProfile ? ` p${v.hdr.doviProfile}` : ''));
  return bits.join(' ');
}

export function renderMediaSummary(media: MediaInfo, sidecars: SidecarSub[] = []): string {
  const lines: string[] = [];
  lines.push(`File:      ${basename(media.path)}`);
  lines.push(`Container: ${media.container}   Duration: ${formatTimecode(media.durationSec)}`);
  for (const v of media.video) {
    lines.push(`Video [${v.index}]: ${describeVideoStream(v)}`);
  }
  for (const a of media.audio) {
    const tags = [a.language, a.title].filter(Boolean).join(' / ');
    lines.push(
      `Audio [${a.index}]: ${a.codec} ${a.channelLayout} (${a.channels}ch)` +
        (tags ? ` — ${tags}` : '') +
        (a.isDefault ? '  *default' : ''),
    );
  }
  for (const s of media.subtitles) {
    const tags = [s.language, s.title].filter(Boolean).join(' / ');
    lines.push(
      `Sub   [${s.index}]: ${s.codec} ${s.isText ? 'text' : 'bitmap'}` +
        (tags ? ` — ${tags}` : '') +
        (s.isForced ? '  *forced' : '') +
        (s.isDefault ? '  *default' : '') +
        (s.isText ? '' : '  (unsupported: bitmap)'),
    );
  }
  for (const sc of sidecars) {
    lines.push(
      `Sub   [sidecar]: ${sc.format} — ${sc.label}` + (sc.language ? ` (${sc.language})` : '') + '  *external',
    );
  }
  if (media.audio.length === 0) lines.push('Audio:     (none)');
  if (media.subtitles.length === 0 && sidecars.length === 0) lines.push('Subtitles: (none)');
  return lines.join('\n');
}

function describeVideoAction(v: VideoAction): string {
  if (v.kind === 'copy') return `copy${v.tag ? ` (${v.tag})` : ''}`;
  const bits = [`transcode ${v.encoder}`, `q${v.quality}`];
  if (v.scale) bits.push(`${v.scale.w}x${v.scale.h}`);
  if (v.maxFps) bits.push(`${v.maxFps}fps`);
  if (v.profile) bits.push(v.profile);
  return bits.join(' ');
}

function describeAudioAction(a: AudioAction): string {
  if (a.kind === 'copy') return 'copy';
  return `transcode ${a.encoder} ${a.bitrate} ${a.channels}ch`;
}

export function renderPlan(plan: PlaybackPlan): string {
  const lines: string[] = [];
  const method = plan.method === 'hls' ? `HLS (${plan.segmentFormat ?? 'fmp4'})` : 'direct play';
  lines.push(`Plan:  ${method}   tier=${plan.tier}`);
  lines.push(`  video:   ${describeVideoAction(plan.video)}  [stream ${plan.videoStreamIndex}]`);
  lines.push(
    `  audio:   ${plan.audioStreamIndex < 0 ? '(none)' : describeAudioAction(plan.audio)}` +
      (plan.audioStreamIndex >= 0 ? `  [stream ${plan.audioStreamIndex}]` : ''),
  );
  if (plan.segmentation) lines.push(`  segments: ${plan.segmentation.mode} @ ${plan.segmentation.targetSec}s`);
  lines.push(`  content-type: ${plan.contentType}`);
  lines.push(`  HDR: ${plan.hdrOutcome}`);
  if (plan.subtitles.length > 0) {
    lines.push(`  subtitles: ${plan.subtitles.map((s) => `#${s.trackId} ${s.label}`).join(', ')}`);
  }
  lines.push('  reasons:');
  for (const r of plan.reasons) lines.push(`    - ${r}`);
  return lines.join('\n');
}

/** The `probe --json` payload shape (stable for scripting). */
export function buildProbeJson(
  media: MediaInfo,
  plan: PlaybackPlan,
  device?: DiscoveredDevice,
): Record<string, unknown> {
  return {
    file: media.path,
    device: device
      ? { friendlyName: device.friendlyName, model: device.model, profile: device.profile.key, host: device.host }
      : { profile: 'unknown' },
    media: {
      container: media.container,
      durationSec: media.durationSec,
      video: media.video,
      audio: media.audio,
      subtitles: media.subtitles,
    },
    plan: {
      method: plan.method,
      tier: plan.tier,
      video: plan.video,
      audio: plan.audio,
      videoStreamIndex: plan.videoStreamIndex,
      audioStreamIndex: plan.audioStreamIndex,
      segmentation: plan.segmentation ?? null,
      segmentFormat: plan.segmentFormat ?? null,
      contentType: plan.contentType,
      durationSec: plan.durationSec,
      hdrOutcome: plan.hdrOutcome,
      reasons: plan.reasons,
      subtitles: plan.subtitles,
    },
  };
}
