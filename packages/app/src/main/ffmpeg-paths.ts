/**
 * ffmpeg-paths.ts — point the engine at the ffmpeg/ffprobe we ship in the bundle.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS FILE EXISTS                                                       │
 * │                                                                             │
 * │  The engine resolves each binary in this order (engine/ffmpeg/binary.ts):   │
 * │      1. $CASTGORILLA_FFMPEG / $CASTGORILLA_FFPROBE                          │
 * │      2. $PATH                                                               │
 * │      3. /opt/homebrew/bin                                                   │
 * │                                                                             │
 * │  Steps 2 and 3 are fine for the CLI, which inherits a login shell's PATH,   │
 * │  and they are fine for `electron .` in a terminal. They are NOT fine for a  │
 * │  packaged app: a process launched from Finder/Dock/LaunchServices gets a    │
 * │  minimal environment whose PATH is roughly `/usr/bin:/bin:/usr/sbin:/sbin`  │
 * │  — it does NOT include `/opt/homebrew/bin`. Step 3 hardcodes the Homebrew   │
 * │  dir precisely to paper over that, which works on THIS machine and on no    │
 * │  user's machine who has not run `brew install ffmpeg`.                      │
 * │                                                                             │
 * │  So a shipped app must carry its own binaries and say where they are.       │
 * │  Step 1 of the engine's order is exactly that hook, and this module is the  │
 * │  only thing that uses it. No engine change is needed or wanted.             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ORDERING. `engine-host.ts` and `thumbnails.ts` both reach the engine through a
 * *dynamic* `import('@castgorilla/engine')`, and the engine resolves ffmpeg
 * lazily on the first probe/play — so the env only has to be set before any of
 * that runs. Even so this module does its work as an import-time SIDE EFFECT and
 * `index.ts` imports it FIRST, so the guarantee does not depend on any of those
 * facts staying true. Getting the order wrong is a silent failure: it falls back
 * to Homebrew on a developer machine and only breaks on a clean one.
 *
 * WE DELIBERATELY DO NOT CHECK THAT THE FILES EXIST. If `extraResources` ever
 * stops copying them, the engine throws `CASTGORILLA_FFMPEG points at "…" but it
 * is not an executable file` — which names the broken path. Silently declining to
 * set the var would instead fall through to PATH, and on a developer machine that
 * finds Homebrew's ffmpeg and the packaging regression ships undetected. Loud and
 * specific beats quiet and wrong.
 */

import { app } from 'electron';
import path from 'node:path';

/** Subdirectory of `Contents/Resources` that `extraResources` copies into. */
const BUNDLED_DIR = 'ffmpeg';

/**
 * In a packaged app, point the engine at the bundled binaries — unless the user
 * has already pointed it somewhere themselves.
 *
 * The "only if not already set" rule preserves the documented power-user
 * override: someone with a newer/differently-built ffmpeg can export
 * CASTGORILLA_FFMPEG before launching and still have it honoured. In development
 * this is a no-op, so `npm run dev` keeps using Homebrew's ffmpeg off PATH.
 */
export function configureBundledFfmpeg(): void {
  if (!app.isPackaged) return;

  const dir = path.join(process.resourcesPath, BUNDLED_DIR);
  setIfUnset('CASTGORILLA_FFMPEG', path.join(dir, 'ffmpeg'));
  setIfUnset('CASTGORILLA_FFPROBE', path.join(dir, 'ffprobe'));
}

/** Set `name` to `value` only if it is currently unset or empty. */
function setIfUnset(name: string, value: string): void {
  const current = process.env[name];
  if (current !== undefined && current.length > 0) return;
  process.env[name] = value;
}

// Run on import. `index.ts` imports this module for its side effect, first,
// before any other module body is evaluated.
configureBundledFfmpeg();
