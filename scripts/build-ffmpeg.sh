#!/usr/bin/env bash
#
# build-ffmpeg.sh — build the static, LGPL-only ffmpeg + ffprobe that ship
# inside the castgorilla app bundle.
#
# WHY THIS EXISTS
#   castgorilla used to require the user to `brew install ffmpeg`. Homebrew's
#   ffmpeg links ~18 dylibs out of /opt/homebrew, so it can never simply be
#   copied into an .app — on any machine but the build machine it would fail to
#   launch. This produces a self-contained pair of binaries instead.
#
# WHY LGPL IS ENOUGH — do NOT "helpfully" add codec libraries.
#   The engine only ever emits `-c:v copy` or one of exactly four encoders:
#       h264_videotoolbox, hevc_videotoolbox   (Apple VideoToolbox)
#       aac_at                                 (Apple AudioToolbox)
#       eac3                                   (ffmpeg-native)
#   and every decoder it needs (h264, hevc, aac, ac3, eac3, dts, mp3, flac,
#   vorbis, opus, and the subtitle codecs) is ffmpeg-native as well. So there is
#   deliberately no --enable-gpl and no libx264/libx265/libvpx/libsvtav1/
#   libdav1d/libmp3lame/libopus. Dropping them makes the build smaller AND
#   removes every redistribution obligation. Adding a codec library here is a
#   licensing decision, not a build tweak — take it to the orchestrator.
#
# THE HARD GATE (section 7) IS THE POINT OF THIS SCRIPT.
#   Its assertions mirror the engine's own contract in
#   packages/engine/src/ffmpeg/binary.ts (MIN_MAJOR_VERSION, REQUIRED_ENCODERS).
#   A build that silently lacks an encoder, or silently links a Homebrew dylib,
#   does not fail here — it fails at playback on a TV, which per CLAUDE.md's
#   hardware protocol costs a human round-trip to even diagnose. Fail here.
#
# WE REDISTRIBUTE THESE BINARIES, SO THE LICENCE TEXT SHIPS WITH THEM.
#   LGPL v2.1 §1 requires a distributed binary to be accompanied by the licence
#   and by a route to the corresponding source. Alongside ffmpeg/ffprobe this
#   installs COPYING.LGPLv2.1 and LICENSE.md (both verbatim from the source tree
#   we built) plus a generated README.castgorilla.txt naming the exact upstream
#   version, tarball URL, checksum and configure line. The app's packaging step
#   copies this directory into the bundle unfiltered, so those files reach the
#   user automatically. The gate fails if any of them is missing.
#
# Properties:
#   - idempotent: a completed build is re-verified against the gate, not rebuilt
#   - all work happens OUTSIDE the repo (see WORK below); only the binaries and
#     their licence files land in the tree, under vendor/ (gitignored)
#   - exits non-zero if any gate assertion fails
#
# Usage:
#   bash scripts/build-ffmpeg.sh              # build (or verify an existing build)
#   bash scripts/build-ffmpeg.sh --force      # discard and rebuild from scratch
#   bash scripts/build-ffmpeg.sh --verify     # run the gate only, build nothing
#
# Env overrides:
#   CASTGORILLA_FFMPEG_BUILD_DIR   work dir (default ~/.cache/castgorilla/ffmpeg-build)
#   CASTGORILLA_FFMPEG_JOBS        make -j value (default: all cores)

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Configuration
# ---------------------------------------------------------------------------

# ffmpeg 8.1.2 is the newest 8.1.x and is what Homebrew currently ships as
# stable. The engine requires major >= 8 (binary.ts MIN_MAJOR_VERSION).
#
# The checksum is NOT one we computed from our own download — that would be
# circular. It is the sha256 Homebrew pins in its ffmpeg formula, i.e. an
# independent distribution channel with its own audit trail, cross-checking the
# bytes ffmpeg.org serves us. If you bump FFMPEG_VERSION you MUST re-source the
# hash the same way:
#   curl -sS https://formulae.brew.sh/api/formula/ffmpeg.json \
#     | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["versions"]["stable"], d["urls"]["stable"]["checksum"])'
FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

# These mirror packages/engine/src/ffmpeg/binary.ts. Keep them in lockstep.
MIN_MAJOR_VERSION=8
REQUIRED_ENCODERS=(h264_videotoolbox hevc_videotoolbox aac_at eac3)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_ARCH="arm64"
OUT_DIR="$ROOT/vendor/ffmpeg/$TARGET_ARCH"

# Work dir lives OUTSIDE the repo so a failed build can never dirty the tree,
# and so re-runs are cheap (the tarball and object files survive).
WORK="${CASTGORILLA_FFMPEG_BUILD_DIR:-$HOME/.cache/castgorilla/ffmpeg-build}"
SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
TARBALL="$WORK/ffmpeg-${FFMPEG_VERSION}.tar.xz"
BUILD_LOG="$WORK/build.log"
JOBS="${CASTGORILLA_FFMPEG_JOBS:-$(sysctl -n hw.ncpu)}"

# The configure flags live up here, in the config section, for one specific
# reason: README.castgorilla.txt records the exact configure line this build
# used, and write_source_notice() generates that line from THIS array. A
# hand-retyped copy in a string literal would drift from reality the first time
# someone edited the flags, and a corresponding-source notice that misstates how
# the binary was built is worse than no notice at all.
#
# --disable-lzma is NOT tidiness. macOS ships no system liblzma, but Homebrew
# does (/opt/homebrew/lib/liblzma.dylib), so ffmpeg's autodetection links it and
# the binary stops being portable. lzma only serves TIFF decoding here.
# sdl2/xlib/libxcb are likewise Homebrew-only and serve ffplay, which is off.
#
# VideoToolbox and AudioToolbox are on by default on macOS. They are named
# explicitly anyway so that a future ffmpeg which drops or renames them fails
# loudly at configure time instead of quietly at playback time.
CONFIGURE_FLAGS=(
  --prefix="$WORK/install"
  --disable-shared
  --enable-static
  --disable-doc
  --disable-ffplay
  --disable-debug
  --enable-videotoolbox
  --enable-audiotoolbox
  --arch="$TARGET_ARCH"
  # LGPL posture: no --enable-gpl, no --enable-nonfree, no external codec libs.
  --disable-lzma
  --disable-sdl2
  --disable-xlib
  --disable-libxcb
)

FORCE=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --verify)  VERIFY_ONLY=1 ;;
    -h|--help) sed -n '1,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n==== %s ====\n' "$*"; }
step() { printf '....  %s\n' "$*"; }
ok()   { printf 'OK    %s\n' "$*"; }
skip() { printf 'SKIP  %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Licence payload — shipped NEXT TO the binaries, not optional.
#
# LGPL v2.1 §1 requires that a distributed binary be accompanied by a copy of
# the licence, and that the recipient be told what the work is and where the
# corresponding source can be had. packages/app's electron-builder config copies
# this directory into the .app unfiltered, so whatever lands here ships in the
# DMG — and, symmetrically, anything missing here is missing from every copy we
# hand out.
#
# COPYING.LGPLv2.1 and LICENSE.md are taken verbatim from the source tree we
# actually built, never fetched separately, so they cannot end up describing a
# different release than the binaries came from.
# ---------------------------------------------------------------------------
write_source_notice() {
  # The configure line is reconstructed from the same array the build ran, so
  # it cannot drift from what was actually built. --prefix is rewritten because
  # it embeds the build machine's home directory, which has no business in a
  # file we hand to users — and it does not affect the binaries anyway, since
  # they are copied out of the build tree rather than `make install`ed.
  local cfg="./configure"
  local f
  for f in "${CONFIGURE_FLAGS[@]}"; do cfg="$cfg $f"; done
  cfg="${cfg//$WORK/<build-dir>}"

  # No timestamp anywhere in here: re-runs must produce byte-identical output
  # or "idempotent" stops meaning anything.
  cat > "$OUT_DIR/README.castgorilla.txt" <<EOF
FFmpeg, as bundled with castgorilla
===================================

WHAT THIS IS

  The ffmpeg and ffprobe binaries in this directory are UNMODIFIED upstream
  FFmpeg, compiled from the official source release identified below. No
  patches of any kind were applied. They are redistributed as part of
  castgorilla under the GNU Lesser General Public License, version 2.1, a
  complete copy of which sits beside this file as COPYING.LGPLv2.1.

CORRESPONDING SOURCE

  Version:   FFmpeg $FFMPEG_VERSION
  Source:    $FFMPEG_URL
  SHA-256:   $FFMPEG_SHA256

  That tarball is the complete corresponding source for these binaries. It is
  published by the FFmpeg project and remains available for download from
  ffmpeg.org. The same release is additionally tagged n$FFMPEG_VERSION in the
  upstream git repository at https://git.ffmpeg.org/ffmpeg.git, should the
  tarball itself ever be withdrawn.

HOW THESE BINARIES WERE CONFIGURED

  $cfg
  make

  (--prefix above is a build-local path. It does not affect the binaries, which
  are taken directly from the build tree rather than installed.)

LICENSING POSITION

  This is an LGPL build. It is configured WITHOUT --enable-gpl and WITHOUT
  --enable-nonfree, and it links no external codec libraries: there is no
  libx264, libx265, libvpx, libsvtav1, libdav1d, libmp3lame or libopus in it.
  Encoding uses only Apple's VideoToolbox and AudioToolbox frameworks together
  with FFmpeg's own native encoders.

  You do not have to take this file's word for any of that — ask the binary:

      ./ffmpeg -L            the licence FFmpeg reports it was built under
      ./ffmpeg -buildconf    the exact configure flags compiled into it
      otool -L ./ffmpeg      the libraries it actually links against

  See LICENSE.md for the FFmpeg project's own statement of how its individual
  components are licensed.

REBUILDING

  scripts/build-ffmpeg.sh in the castgorilla source tree reproduces this build
  from the tarball above, and verifies the result before accepting it.
EOF
  ok "licence: README.castgorilla.txt (corresponding-source notice)"
}

install_licences() {
  [[ -f "$SRC/COPYING.LGPLv2.1" ]] || die "no COPYING.LGPLv2.1 in $SRC
     Refusing to ship an LGPL binary with no licence text. If upstream really
     renamed or moved it, fix this script deliberately — do not skip the file."
  install -m 0644 "$SRC/COPYING.LGPLv2.1" "$OUT_DIR/COPYING.LGPLv2.1"
  ok "licence: COPYING.LGPLv2.1 (verbatim from the built source tree)"

  # LICENSE.md carries FFmpeg's per-component licence position. Expected, but
  # not worth blocking a release over if a future tarball drops it.
  if [[ -f "$SRC/LICENSE.md" ]]; then
    install -m 0644 "$SRC/LICENSE.md" "$OUT_DIR/LICENSE.md"
    ok "licence: LICENSE.md (verbatim from the built source tree)"
  else
    printf 'WARN  no LICENSE.md in %s — shipping without it\n' "$SRC"
  fi

  write_source_notice
}

# ---------------------------------------------------------------------------
# 7. The gate (defined early so --verify can reach it without building)
#
# Every assertion here exists because its absence would present as a playback
# bug rather than a build bug. Accumulate all failures before exiting so one
# run reports everything wrong, not just the first thing.
# ---------------------------------------------------------------------------
run_gate() {
  local ffmpeg_bin="$OUT_DIR/ffmpeg"
  local ffprobe_bin="$OUT_DIR/ffprobe"
  local fails=0
  local bin

  say "HARD GATE"

  # (a) both binaries exist and are executable, and ffprobe actually runs.
  #     ffprobe is easy to forget: the engine probes with it before it ever
  #     encodes, so a broken ffprobe breaks everything at step one.
  for bin in "$ffmpeg_bin" "$ffprobe_bin"; do
    if [[ ! -x "$bin" ]]; then
      printf 'FAIL  not an executable file: %s\n' "$bin"; fails=1; continue
    fi
    if ! "$bin" -hide_banner -version >/dev/null 2>&1; then
      printf 'FAIL  will not run: %s -version\n' "$bin"; fails=1; continue
    fi
    ok "executable and runs: $(basename "$bin")"
  done
  # Nothing below can work if the binaries do not run.
  [[ "$fails" -eq 0 ]] || { printf '\ngate FAILED\n' >&2; return 1; }

  # (b) version major >= MIN_MAJOR_VERSION.
  #     Parsed the same way binary.ts does (/version\s+n?(\d+)\./i on line 1),
  #     so the two cannot disagree about what this build reports.
  local ver_line major
  ver_line="$("$ffmpeg_bin" -hide_banner -version | head -1)"
  major="$(printf '%s\n' "$ver_line" | sed -nE 's/.*[Vv]ersion[[:space:]]+n?([0-9]+)\..*/\1/p')"
  printf 'INFO  %s\n' "$ver_line"
  if [[ -z "$major" ]]; then
    printf 'FAIL  could not parse a major version from: "%s"\n' "$ver_line"; fails=1
  elif (( major < MIN_MAJOR_VERSION )); then
    printf 'FAIL  ffmpeg major %s is below the required %s\n' "$major" "$MIN_MAJOR_VERSION"; fails=1
  else
    ok "version major $major >= $MIN_MAJOR_VERSION"
  fi

  # (c) all four required encoders present.
  #     Matched against the same shape binary.ts parses: a 6-char capability
  #     flag block, whitespace, then the encoder name.
  local encoders enc
  encoders="$("$ffmpeg_bin" -hide_banner -encoders 2>/dev/null || true)"
  for enc in "${REQUIRED_ENCODERS[@]}"; do
    if printf '%s\n' "$encoders" | grep -qE "^[[:space:]]*[A-Z.]{6}[[:space:]]+${enc}([[:space:]]|\$)"; then
      ok "encoder present: $enc"
    else
      printf 'FAIL  encoder MISSING: %s\n' "$enc"; fails=1
    fi
  done

  # (d) no Homebrew / /usr/local dylib references.
  #     "Static" here does NOT mean zero dynamic links — linking the macOS
  #     system libs and frameworks is correct and unavoidable. It means nothing
  #     outside the OS. A single /opt/homebrew reference makes the bundle work
  #     on this machine and fail on every user's.
  for bin in "$ffmpeg_bin" "$ffprobe_bin"; do
    local links offenders
    links="$(otool -L "$bin" | tail -n +2)"   # line 1 is the binary's own path
    offenders="$(printf '%s\n' "$links" | grep -E '/opt/homebrew|/usr/local' || true)"
    if [[ -n "$offenders" ]]; then
      printf 'FAIL  %s links non-system dylibs:\n%s\n' "$(basename "$bin")" "$offenders"; fails=1
    else
      ok "$(basename "$bin"): no /opt/homebrew or /usr/local linkage"
    fi
  done

  # (e) the licence payload ships alongside the binaries.
  #     LGPL v2.1 §1: a distributed binary must be accompanied by the licence
  #     text and by a route to the corresponding source. Since extraResources
  #     copies this directory into the .app unfiltered, a file absent here is
  #     absent from every DMG we hand out — and a silently missing licence is
  #     exactly the kind of thing nobody notices until it matters.
  local lf
  for lf in COPYING.LGPLv2.1 README.castgorilla.txt; do
    if [[ -s "$OUT_DIR/$lf" ]]; then
      ok "licence file present: $lf"
    else
      printf 'FAIL  licence file MISSING: %s\n' "$lf"; fails=1
    fi
  done
  if [[ -s "$OUT_DIR/LICENSE.md" ]]; then
    ok "licence file present: LICENSE.md"
  else
    printf 'WARN  LICENSE.md absent (expected, but not fatal)\n'
  fi

  say "otool -L $(basename "$ffmpeg_bin")"
  otool -L "$ffmpeg_bin"

  if [[ "$fails" -ne 0 ]]; then
    printf '\ngate FAILED — see FAIL lines above\n' >&2
    return 1
  fi
  printf '\ngate PASSED\n'
  return 0
}

# --verify short-circuits everything else.
if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  run_gate
  exit $?
fi

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
say "preflight"

host_arch="$(uname -m)"
[[ "$host_arch" == "arm64" ]] || die "this script builds an arm64 binary natively; host reports '$host_arch'"
ok "host arch: $host_arch"

xcode-select -p >/dev/null 2>&1 || die "no Xcode command line tools (xcode-select --install)"
ok "toolchain: $(clang --version | head -1)"

# ffmpeg's build tree with static libs runs ~1.5-2 GB. Fail early rather than
# 30 minutes in with a confusing linker error.
avail_kb="$(df -k "$HOME" | tail -1 | awk '{print $4}')"
avail_gb=$(( avail_kb / 1024 / 1024 ))
if (( avail_gb < 3 )); then
  die "only ${avail_gb} GiB free on the home volume; an ffmpeg build tree needs ~2 GB"
fi
(( avail_gb >= 6 )) || printf 'WARN  only %s GiB free — this build wants ~2 GB of it\n' "$avail_gb"
ok "free space: ${avail_gb} GiB"

mkdir -p "$WORK" "$OUT_DIR"
ok "work dir: $WORK"
ok "output  : $OUT_DIR"

# Fast path: an existing build that still passes the gate is left alone.
if [[ "$FORCE" -eq 0 && -x "$OUT_DIR/ffmpeg" && -x "$OUT_DIR/ffprobe" ]]; then
  skip "binaries already present — verifying instead of rebuilding (--force to rebuild)"
  # Refresh the licence payload when the source tree is still around, so a
  # vendor dir populated before these files existed heals on the next run
  # instead of failing the gate forever with no way forward but --force.
  if [[ -f "$SRC/COPYING.LGPLv2.1" ]]; then install_licences; fi
  run_gate
  exit $?
fi

if [[ "$FORCE" -eq 1 ]]; then
  step "--force: discarding previous source tree and outputs"
  rm -rf "$SRC" "$OUT_DIR/ffmpeg" "$OUT_DIR/ffprobe"
fi

# ---------------------------------------------------------------------------
# 2. Build dependencies
#
# nasm is only strictly needed for x86 asm — an arm64 build assembles NEON with
# clang — but ffmpeg's configure looks for it and installing it keeps this
# script honest if we ever add an x86_64 slice. pkg-config is installed because
# configure expects it to exist; note section 5 then deliberately blinds it.
# ---------------------------------------------------------------------------
say "build dependencies"
command -v brew >/dev/null 2>&1 || die "Homebrew not found; needed for nasm + pkg-config"
for dep in nasm pkg-config; do
  if command -v "$dep" >/dev/null 2>&1; then
    skip "$dep already installed ($(command -v "$dep"))"
  else
    step "brew install $dep"
    brew install "$dep"
    ok "$dep installed"
  fi
done

# ---------------------------------------------------------------------------
# 3. Fetch + verify the release tarball
# ---------------------------------------------------------------------------
say "source tarball"

verify_tarball() {
  [[ -f "$TARBALL" ]] || return 1
  local actual
  actual="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
  [[ "$actual" == "$FFMPEG_SHA256" ]]
}

if verify_tarball; then
  skip "ffmpeg-${FFMPEG_VERSION}.tar.xz already downloaded and checksum matches"
else
  [[ -f "$TARBALL" ]] && step "existing tarball failed checksum — re-downloading"
  step "downloading $FFMPEG_URL"
  curl -fSL --retry 3 --connect-timeout 20 -o "$TARBALL.part" "$FFMPEG_URL"
  mv "$TARBALL.part" "$TARBALL"
  verify_tarball || {
    actual="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
    rm -f "$TARBALL"
    die "sha256 mismatch for ffmpeg-${FFMPEG_VERSION}.tar.xz
       expected $FFMPEG_SHA256
       got      $actual
     The download was discarded. Do NOT paper over this by updating the pin."
  }
  ok "downloaded and checksum verified ($(du -h "$TARBALL" | awk '{print $1}'))"
fi

# ---------------------------------------------------------------------------
# 4. Extract
# ---------------------------------------------------------------------------
say "extract"
if [[ -f "$SRC/configure" ]]; then
  skip "source tree already extracted at $SRC"
else
  step "extracting into $WORK"
  rm -rf "$SRC"
  tar -xJf "$TARBALL" -C "$WORK"
  [[ -f "$SRC/configure" ]] || die "extract produced no configure script at $SRC"
  ok "extracted"
fi

# ---------------------------------------------------------------------------
# 5. Configure
#
# Two hostile things are neutralised here, both of which would otherwise show
# up as gate (d) failures after a 30-minute build:
#
#   * pkg-config is pointed at an empty directory. Left alone it happily finds
#     Homebrew .pc files and ffmpeg links whatever it discovers.
#   * CFLAGS/LDFLAGS/etc are cleared, since a Homebrew-ish shell profile
#     exporting -I/opt/homebrew/include is enough to poison the build.
#
# The flag list itself is CONFIGURE_FLAGS, defined in section 0 alongside the
# rest of the configuration (and explained there).
# ---------------------------------------------------------------------------
say "configure"

# A stamp lets a re-run skip a configure that already ran with these exact
# flags, while still reconfiguring if anyone edits the list above.
STAMP="$SRC/.castgorilla-configure-stamp"
STAMP_WANT="$FFMPEG_VERSION ${CONFIGURE_FLAGS[*]}"

mkdir -p "$WORK/pkgconfig-empty"

if [[ -f "$SRC/ffbuild/config.mak" && -f "$STAMP" ]] && [[ "$(cat "$STAMP")" == "$STAMP_WANT" ]]; then
  skip "already configured with these exact flags"
else
  step "running configure (${#CONFIGURE_FLAGS[@]} flags)"
  (
    cd "$SRC"
    env -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS -u PKG_CONFIG_PATH \
        PKG_CONFIG_LIBDIR="$WORK/pkgconfig-empty" \
        ./configure "${CONFIGURE_FLAGS[@]}"
  ) || die "configure failed — see $SRC/ffbuild/config.log"
  printf '%s' "$STAMP_WANT" > "$STAMP"
  ok "configured"
fi

# Cheap, load-bearing pre-build check: if configure did not turn VideoToolbox
# and AudioToolbox on, the four required encoders cannot possibly exist and
# there is no reason to spend 30 minutes finding that out.
# NOTE: bash 3.2 is what /usr/bin/env bash resolves to on stock macOS, so no
# ${var^^} here — uppercase via tr.
for feat in videotoolbox audiotoolbox; do
  feat_uc="$(printf '%s' "$feat" | tr '[:lower:]' '[:upper:]')"
  # config.mak marks a disabled feature by prefixing the key with '!', so an
  # anchored match on the bare key is the positive signal.
  grep -qE "^CONFIG_${feat_uc}=yes\$" "$SRC/ffbuild/config.mak" \
    || die "configure did NOT enable $feat — the required encoders cannot be built.
     Inspect $SRC/ffbuild/config.log"
  ok "configure enabled $feat"
done

# ---------------------------------------------------------------------------
# 6. Build, then take only the two binaries.
#
# Deliberately no `make install`: that would also deposit ~200 MB of static
# libs, headers and .pc files we never ship. We want exactly two files.
# ---------------------------------------------------------------------------
say "build"
step "make -j$JOBS  (this takes a while; full output -> $BUILD_LOG)"
(
  cd "$SRC"
  make -j"$JOBS"
) > "$BUILD_LOG" 2>&1 || {
  printf '\n--- last 40 lines of %s ---\n' "$BUILD_LOG" >&2
  tail -40 "$BUILD_LOG" >&2
  die "make failed"
}
ok "make completed"

for bin in ffmpeg ffprobe; do
  [[ -f "$SRC/$bin" ]] || die "build produced no $bin in $SRC"
  install -m 0755 "$SRC/$bin" "$OUT_DIR/$bin"
  ok "installed $OUT_DIR/$bin ($(du -h "$OUT_DIR/$bin" | awk '{print $1}'))"
done

# The binaries never ship alone: LGPL v2.1 requires the licence text and a
# corresponding-source notice travel with them.
install_licences

# ---------------------------------------------------------------------------
# 7. Gate + summary
# ---------------------------------------------------------------------------
run_gate || exit 1

say "summary"
printf '%-10s %s\n' "version" "$FFMPEG_VERSION"
printf '%-10s %s\n' "arch" "$TARGET_ARCH"
printf '%-10s %s\n' "licence" "LGPL (no --enable-gpl, no external codec libs)"
printf '%-10s %s\n' "output" "$OUT_DIR"
echo
printf '  %-26s %8s  %s\n' "FILE" "SIZE" "ROLE"
printf '  %-26s %8s  %s\n' "ffmpeg"                "$(du -h "$OUT_DIR/ffmpeg"   | awk '{print $1}')" "binary"
printf '  %-26s %8s  %s\n' "ffprobe"               "$(du -h "$OUT_DIR/ffprobe"  | awk '{print $1}')" "binary"
for lf in COPYING.LGPLv2.1 LICENSE.md README.castgorilla.txt; do
  [[ -f "$OUT_DIR/$lf" ]] || continue
  printf '  %-26s %8s  %s\n' "$lf" "$(du -h "$OUT_DIR/$lf" | awk '{print $1}')" "licence"
done
echo
echo "vendor/ is gitignored — these are build artifacts, not source."
echo "All files above ship in the app bundle; the licence files are required."
exit 0
