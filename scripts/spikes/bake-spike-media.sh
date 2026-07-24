#!/usr/bin/env bash
#
# bake-spike-media.sh — pre-bake static HLS from fixtures for the G1 hardware gate.
#
# The R1/R2 device spikes (spike-basic / spike-load, served by static-server.mjs)
# need real HLS a Chromecast can pull: a full VOD playlist + init/segments already
# on disk. This bakes three variants that exactly mirror the engine's copy-tier
# ffmpeg recipe (see packages/engine/src/ffmpeg/args.ts) so what the spike proves
# on hardware is what the engine will emit at runtime:
#
#   fixtures/spike-hls/hevc-fmp4/playlist.m3u8   (kilo_mkv-hevc8-aac  copy → fmp4, hvc1)
#   fixtures/spike-hls/h264-fmp4/playlist.m3u8   (delta_mkv-h264-aac  copy → fmp4)
#   fixtures/spike-hls/h264-ts/playlist.m3u8     (delta_mkv-h264-aac  copy → mpeg-ts)
#
# Recipe parity with args.ts:
#   - copyts trio: -copyts -start_at_zero -avoid_negative_ts disabled
#   - -hls_flags independent_segments+temp_file  (keyframe-aligned segments)
#   - fmp4: -hls_segment_type fmp4 + -hls_fmp4_init_filename init.mp4
#   - ts:   -hls_segment_type mpegts
#   - hevc: -tag:v hvc1  (so Cast/Safari recognize copied HEVC vs 'hev1')
#   - ffmpeg runs with cwd = the target dir; output names are relative.
#
# Idempotent: a variant whose playlist.m3u8 already exists is skipped. Delete a
# variant dir (or fixtures/spike-hls) to force a re-bake.
#
# ffmpeg/ffprobe resolution: CASTGORILLA_FFMPEG / CASTGORILLA_FFPROBE, else PATH,
# else /opt/homebrew/bin.

set -uo pipefail

FFMPEG="${CASTGORILLA_FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"
FFPROBE="${CASTGORILLA_FFPROBE:-$(command -v ffprobe || echo /opt/homebrew/bin/ffprobe)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIX="$ROOT/fixtures"
OUT="$FIX/spike-hls"
FAIL=0

if [[ ! -x "$FFMPEG" ]]; then
  echo "ERROR: ffmpeg not found/executable at: $FFMPEG" >&2
  echo "       set CASTGORILLA_FFMPEG or: brew install ffmpeg" >&2
  exit 2
fi

echo "ffmpeg : $FFMPEG"
echo "output : $OUT"
echo

# bake <variant> <source-fixture> <fmt: fmp4|ts> <hevc: 0|1>
bake() {
  local variant="$1" src_name="$2" fmt="$3" hevc="$4"
  local src="$FIX/$src_name"
  local dir="$OUT/$variant"
  local playlist="$dir/playlist.m3u8"

  if [[ ! -f "$src" ]]; then
    printf 'FAIL  %-12s source missing: %s (run: bash scripts/gen-fixtures.sh)\n' "$variant" "$src_name"
    FAIL=1
    return 1
  fi
  if [[ -f "$playlist" ]]; then
    printf 'SKIP  %-12s %s\n' "$variant" "$playlist already exists"
    return 0
  fi

  rm -rf "$dir"
  mkdir -p "$dir"

  # Assemble argv mirroring buildHlsArgs (startBoundaryIndex 0 → no -ss).
  local -a args=(-y -nostats -loglevel error)
  args+=(-copyts -start_at_zero -avoid_negative_ts disabled)
  args+=(-i "$src")
  args+=(-map 0:0 -map 0:1)
  args+=(-c:v copy)
  [[ "$hevc" == "1" ]] && args+=(-tag:v hvc1)
  args+=(-c:a copy)
  args+=(-sn -dn)
  args+=(-f hls -hls_time 6 -hls_list_size 0)
  if [[ "$fmt" == "fmp4" ]]; then
    args+=(-hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'seg%d.m4s')
  else
    args+=(-hls_segment_type mpegts -hls_segment_filename 'seg%d.ts')
  fi
  args+=(-hls_flags independent_segments+temp_file -start_number 0 playlist.m3u8)

  printf '....  %-12s baking %s (%s%s)\n' "$variant" "$src_name" "$fmt" "$([[ "$hevc" == 1 ]] && echo ', hvc1')"
  if ( cd "$dir" && "$FFMPEG" -hide_banner "${args[@]}" ); then
    local segs
    segs=$(find "$dir" -name 'seg*' | wc -l | tr -d ' ')
    printf 'OK    %-12s %s segments -> %s\n' "$variant" "$segs" "$playlist"
    return 0
  else
    printf 'FAIL  %-12s ffmpeg failed\n' "$variant"
    rm -rf "$dir"
    FAIL=1
    return 1
  fi
}

bake "hevc-fmp4" "kilo_mkv-hevc8-aac.mkv"  "fmp4" 1
bake "h264-fmp4" "delta_mkv-h264-aac.mkv" "fmp4" 0
bake "h264-ts"   "delta_mkv-h264-aac.mkv" "ts"   0

echo
echo "Verify (ffprobe):"
for variant in hevc-fmp4 h264-fmp4 h264-ts; do
  pl="$OUT/$variant/playlist.m3u8"
  [[ -f "$pl" ]] || continue
  n=$(grep -c '^#EXTINF' "$pl" 2>/dev/null || echo 0)
  printf '  %-12s %s segments listed\n' "$variant" "$n"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "one or more variants failed to bake." >&2
  exit 1
fi
echo
echo "done. serve a variant for a spike with:"
echo "  node scripts/spikes/static-server.mjs --dir $OUT/h264-fmp4"
