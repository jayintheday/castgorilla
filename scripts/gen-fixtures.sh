#!/usr/bin/env bash
#
# gen-fixtures.sh — generate synthetic test media for the castgorilla engine.
#
# All media is built from ffmpeg `testsrc2` + a `sine` tone. Resolutions are
# kept small except where a fixture must prove a specific dimension. Channel
# layouts and HDR color metadata are forced to match what each fixture proves.
#
# Every fixture carries a spoken-word NATO codename prefix (`alpha_`, `bravo_`,
# ...) so a human testing on real hardware can report unambiguously which file
# worked ("delta played, lima hung") instead of squinting at near-identical
# descriptors. See fixtures/README.md for the codename table.
#
# Properties:
#   - idempotent: existing fixtures are skipped
#   - prints a summary table
#   - exits non-zero if ANY generation fails
#
# ffmpeg/ffprobe resolution: CASTGORILLA_FFMPEG / CASTGORILLA_FFPROBE env override,
# else PATH, else /opt/homebrew/bin.

set -uo pipefail

FFMPEG="${CASTGORILLA_FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"
FFPROBE="${CASTGORILLA_FFPROBE:-$(command -v ffprobe || echo /opt/homebrew/bin/ffprobe)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIX="$ROOT/fixtures"
mkdir -p "$FIX"

DUR=60                 # default clip duration (seconds)
SR=48000               # audio sample rate
FAIL=0
declare -a SUMMARY

if [[ ! -x "$FFMPEG" ]]; then
  echo "ERROR: ffmpeg not found/executable at: $FFMPEG" >&2
  echo "       set CASTGORILLA_FFMPEG or: brew install ffmpeg" >&2
  exit 2
fi

echo "ffmpeg : $FFMPEG"
echo "ffprobe: $FFPROBE"
echo "output : $FIX"
echo

# ---------------------------------------------------------------------------
# LEGACY RENAME (migration shim — REMOVE after one migration cycle).
#
# Fixtures gained NATO codename prefixes. Renaming in place keeps the exact
# bytes already under test instead of re-encoding 15 files (~1.4 GB, ~10 min).
# Idempotent: fires only when the old name exists and the new one does not.
LEGACY_RENAMES=(
  "mp4-h264-aac.mp4|alpha_mp4-h264-aac.mp4"
  "mp4-h264-aac-nofaststart.mp4|bravo_mp4-h264-aac-nofaststart.mp4"
  "mp4-h264-l51-4k.mp4|charlie_mp4-h264-l51-4k.mp4"
  "mkv-h264-aac.mkv|delta_mkv-h264-aac.mkv"
  "mkv-h264-dts.mkv|echo_mkv-h264-dts.mkv"
  "mkv-h264-dts-45min.mkv|foxtrot_mkv-h264-dts-45min.mkv"
  "mkv-h264-ac3.mkv|golf_mkv-h264-ac3.mkv"
  "mkv-hevc10-truehd.mkv|hotel_mkv-hevc10-truehd.mkv"
  "webm-vp9-opus.webm|india_webm-vp9-opus.webm"
  "webm-vp8-vorbis.webm|juliett_webm-vp8-vorbis.webm"
  "mkv-hevc8-aac.mkv|kilo_mkv-hevc8-aac.mkv"
  "mp4-h264-aac51.mp4|lima_mp4-h264-aac51.mp4"
  "mkv-h264-subs.mkv|mike_mkv-h264-subs.mkv"
  "mkv-h264-subs.srt|mike_mkv-h264-subs.srt"
  "mkv-h264-subs.en.srt|mike_mkv-h264-subs.en.srt"
  "mkv-h264-longgop.mkv|november_mkv-h264-longgop.mkv"
  "avi-mpeg4-mp3.avi|oscar_avi-mpeg4-mp3.avi"
)
RENAMED=0
for pair in "${LEGACY_RENAMES[@]}"; do
  IFS='|' read -r old new <<< "$pair"
  if [[ -f "$FIX/$old" && ! -f "$FIX/$new" ]]; then
    mv "$FIX/$old" "$FIX/$new"
    printf 'RENAME  %-36s -> %s\n' "$old" "$new"
    RENAMED=1
  fi
done
if [[ "$RENAMED" -eq 1 ]]; then echo; fi
# ---------------------------------------------------------------------------

# ff_gen <name> <description> -- <ffmpeg-args...>   (output path is appended)
ff_gen() {
  local name="$1"; shift
  local desc="$1"; shift
  shift   # drop the literal "--"
  local out="$FIX/$name"
  if [[ -f "$out" ]]; then
    printf 'SKIP  %-36s %s\n' "$name" "$desc"
    SUMMARY+=("SKIP|$name|$desc")
    return 0
  fi
  printf '....  %-36s %s\n' "$name" "generating..."
  if "$FFMPEG" -hide_banner -loglevel error -y "$@" "$out"; then
    printf 'OK    %-36s %s\n' "$name" "$desc"
    SUMMARY+=("OK|$name|$desc")
    return 0
  else
    printf 'FAIL  %-36s %s\n' "$name" "$desc"
    rm -f "$out"
    SUMMARY+=("FAIL|$name|$desc")
    FAIL=1
    return 1
  fi
}

# lavfi input helpers
vsrc() { echo "testsrc2=size=$1:rate=$2:duration=$DUR"; }
asrc() { echo "sine=frequency=440:sample_rate=$SR:duration=$DUR"; }

# ---------------------------------------------------------------------------
# 1. H.264 High yuv420p 1080p30 + AAC-LC stereo, faststart
ff_gen "alpha_mp4-h264-aac.mp4" "H.264 High 1080p30 + AAC-LC stereo (+faststart)" -- \
  -f lavfi -i "$(vsrc 1920x1080 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast \
  -c:a aac -ar "$SR" -ac 2 -movflags +faststart

# 1b. same, no faststart (moov at end)
ff_gen "bravo_mp4-h264-aac-nofaststart.mp4" "H.264 1080p30 + AAC, moov at END" -- \
  -f lavfi -i "$(vsrc 1920x1080 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast \
  -c:a aac -ar "$SR" -ac 2

# 2. H.264 3840x2160 (Level 5.1) + AAC
ff_gen "charlie_mp4-h264-l51-4k.mp4" "H.264 4K (L5.1) + AAC" -- \
  -f lavfi -i "$(vsrc 3840x2160 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -preset ultrafast \
  -c:a aac -ar "$SR" -ac 2 -movflags +faststart

# 3. H.264 + AAC in mkv
ff_gen "delta_mkv-h264-aac.mkv" "H.264 + AAC (Matroska)" -- \
  -f lavfi -i "$(vsrc 1280x720 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast \
  -c:a aac -ar "$SR" -ac 2

# 4. DTS (DCA) 5.1 (experimental encoder -> -strict -2)
ff_gen "echo_mkv-h264-dts.mkv" "H.264 + DTS 5.1" -- \
  -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast \
  -ac 6 -c:a dca -strict -2

# 4L. 45-minute variant of #4 via stream_loop + copy (cheap)
if [[ -f "$FIX/echo_mkv-h264-dts.mkv" ]]; then
  ff_gen "foxtrot_mkv-h264-dts-45min.mkv" "DTS 5.1, ~46 min (long-content path)" -- \
    -stream_loop 45 -i "$FIX/echo_mkv-h264-dts.mkv" -c copy
else
  printf 'FAIL  %-36s %s\n' "foxtrot_mkv-h264-dts-45min.mkv" "source echo_mkv-h264-dts.mkv missing"
  SUMMARY+=("FAIL|foxtrot_mkv-h264-dts-45min.mkv|source missing")
  FAIL=1
fi

# 5. AC-3 5.1
ff_gen "golf_mkv-h264-ac3.mkv" "H.264 + AC-3 5.1" -- \
  -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast \
  -ac 6 -c:a ac3

# 6. HEVC Main10 (BT.2020/PQ HDR10) + TrueHD 5.1
#    setparams forces the frame-level color tags so VideoToolbox writes them;
#    format=p010le gives the encoder 10-bit input. TrueHD is experimental.
ff_gen "hotel_mkv-hevc10-truehd.mkv" "HEVC Main10 HDR10(PQ/BT.2020) + TrueHD 5.1" -- \
  -f lavfi -i "$(vsrc 1280x720 30)" -f lavfi -i "$(asrc)" \
  -vf "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le" \
  -c:v hevc_videotoolbox -profile:v main10 -b:v 3M \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -ac 6 -c:a truehd -strict -2

# 7. VP9 + Opus (realtime settings for speed)
ff_gen "india_webm-vp9-opus.webm" "VP9 + Opus" -- \
  -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 1M -pix_fmt yuv420p \
  -c:a libopus -b:a 128k

# 8. VP8 + Vorbis (native vorbis encoder is stereo-only + experimental)
ff_gen "juliett_webm-vp8-vorbis.webm" "VP8 + Vorbis (stereo)" -- \
  -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
  -c:v libvpx -deadline realtime -cpu-used 8 -b:v 1M -pix_fmt yuv420p \
  -ac 2 -c:a vorbis -strict -2

# 9. HEVC 8-bit (Main) + AAC
ff_gen "kilo_mkv-hevc8-aac.mkv" "HEVC 8-bit Main + AAC" -- \
  -f lavfi -i "$(vsrc 1280x720 30)" -f lavfi -i "$(asrc)" \
  -c:v hevc_videotoolbox -pix_fmt yuv420p -b:v 3M \
  -c:a aac -ar "$SR" -ac 2

# 10. AAC 5.1 multichannel (5.1(side) does not survive AAC/MP4 -> standard 5.1)
ff_gen "lima_mp4-h264-aac51.mp4" "H.264 + AAC 5.1" -- \
  -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast \
  -af "aformat=channel_layouts=5.1" -c:a aac -movflags +faststart

# 11. Embedded SRT + ASS subtitle streams, plus two sidecar SRTs.
if [[ -f "$FIX/mike_mkv-h264-subs.mkv" ]]; then
  printf 'SKIP  %-36s %s\n' "mike_mkv-h264-subs.mkv" "embedded SRT + ASS subs (+ sidecars)"
  SUMMARY+=("SKIP|mike_mkv-h264-subs.mkv|embedded SRT + ASS subs")
else
  # sidecar / cue files (also used as embed sources)
  cat > "$FIX/mike_mkv-h264-subs.srt" <<'SRT'
1
00:00:01,000 --> 00:00:04,000
castgorilla fixture subtitle line one

2
00:00:05,000 --> 00:00:08,000
second subtitle cue
SRT
  cp "$FIX/mike_mkv-h264-subs.srt" "$FIX/mike_mkv-h264-subs.en.srt"
  cat > "$FIX/.subs.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,ASS fixture cue one
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,ASS fixture cue two
ASS
  ff_gen "mike_mkv-h264-subs.mkv" "embedded SRT + ASS subs (+ sidecars)" -- \
    -f lavfi -i "$(vsrc 640x360 30)" -f lavfi -i "$(asrc)" \
    -i "$FIX/mike_mkv-h264-subs.srt" -i "$FIX/.subs.ass" \
    -map 0:v -map 1:a -map 2:0 -map 3:0 \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -ar "$SR" -ac 2 \
    -c:s copy
  rm -f "$FIX/.subs.ass"
fi

# 13. H.264 with 10s GOPs at 30fps (keyframe-segmentation stress)
ff_gen "november_mkv-h264-longgop.mkv" "H.264 10s GOP (g=300 @30fps)" -- \
  -f lavfi -i "$(vsrc 1280x720 30)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast \
  -g 300 -keyint_min 300 -sc_threshold 0 \
  -c:a aac -ar "$SR" -ac 2

# 14. MPEG-4 Part 2 + MP3 in AVI
ff_gen "oscar_avi-mpeg4-mp3.avi" "MPEG-4 Part2 + MP3 (AVI)" -- \
  -f lavfi -i "$(vsrc 640x480 30)" -f lavfi -i "$(asrc)" \
  -c:v mpeg4 -vtag XVID -q:v 5 \
  -c:a libmp3lame -q:a 5

# 15. FRACTIONAL frame rate (24000/1001 "23.976"), the film rate.
#
#     Every other fixture runs at an integer 30fps, where a 6s segment boundary
#     always coincides with a frame. That hid a real effect: at 24000/1001 no
#     multiple of 6 lands on a frame, so a boundary derived from a fixed grid is
#     unreachable and ffmpeg emits the first frame AFTER it instead. `-g 96`
#     (= 4.004s) with scene detection off keeps the keyframe grid deterministic,
#     which is what lets a test assert exact boundary times.
#
#     Codename note: `papa` is reserved for the Dolby Vision sample (see
#     fixtures/README.md), so this takes `quebec`.
ff_gen "quebec_mkv-h264-23976fps.mkv" "H.264 @ 24000/1001 (fractional-rate boundary quantisation)" -- \
  -f lavfi -i "$(vsrc 640x360 24000/1001)" -f lavfi -i "$(asrc)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast \
  -g 96 -keyint_min 96 -sc_threshold 0 \
  -c:a aac -ar "$SR" -ac 2

# (12. dv-p8 — Dolby Vision profile 8 — is an acquired real sample; see README.)

# ---------------------------------------------------------------------------
echo
echo "==== fixture summary ===="
printf '%-6s %-36s %s\n' "STATUS" "FILE" "PROVES"
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r st nm ds <<< "$row"
  printf '%-6s %-36s %s\n' "$st" "$nm" "$ds"
done
echo

if [[ "$FAIL" -ne 0 ]]; then
  echo "one or more fixtures failed to generate." >&2
  exit 1
fi
echo "all fixtures present."
exit 0
