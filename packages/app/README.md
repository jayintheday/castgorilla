# @castgorilla/app

The **Cast Gorilla** desktop app: Electron (vanilla TS + DOM) over the
`@castgorilla/engine` API. It runs the **real engine by default** (probe → plan →
cast → HLS/transcode); set `CASTGORILLA_MOCK=1` to fall back to the canned
**MockEngine** for UI work without a Chromecast or ffmpeg.

**Official builds** (Developer ID signed, notarized, bundled LGPL ffmpeg) are
sold on Gumroad — see [`docs/DISTRIBUTION.md`](../../docs/DISTRIBUTION.md). This
README is for contributors packaging locally.

## Stack

| Tool | Version | Role |
| --- | --- | --- |
| electron | 43.2.0 | desktop runtime (main + preload + renderer) |
| vite | 7.3.6 | builds all three targets; renderer dev server |
| electron-builder | 26.15.3 | macOS `.app` / `.dmg` packaging |
| vitest | (root 3.2.7) | unit tests |
| `@castgorilla/engine` | workspace | the real engine (runtime `dependency`; bundled into the packaged asar) |

`@castgorilla/engine` is the app's only runtime `dependency`. It is dynamically
imported by the main process and, together with its transitive runtime deps
(`castv2`, `bonjour-service`, `zod`, `protobufjs`), is collected into the packaged
asar by electron-builder. No UI framework, no design system.

## Layout

```
src/
  shared/
    ipc.ts           # THE IPC contract: channel names + payload types (both sides import this)
    engine-types.ts  # type-only re-export of the engine's FROZEN contracts
  main/
    index.ts         # Electron main entry (→ dist/main/index.cjs)
    engine-host.ts   # ← THE engine coupling / WS6b swap point (see below)
    engine-service.ts# pure orchestration (no Electron): 1 session, discovery, 1Hz status
    handlers.ts      # pure request-handler table (no Electron)
    ipc.ts           # thin Electron glue: ipcMain.handle + webContents.send + dialog
  preload/
    index.ts         # contextBridge → window.castgorilla (→ dist/preload/index.cjs)
  renderer/
    index.html, styles.css
    main.ts          # DOM wiring over the store
    store.ts         # pure state store + position interpolation
    plan-format.ts   # pure plan-summary / time formatting
```

The renderer never touches Node or the engine — everything crosses the typed
`contextBridge` in `preload/index.ts`, and both sides share `src/shared/ipc.ts`
so the contract can never drift.

## Dev loop

```bash
npm run dev -w packages/app
```

`scripts/dev.mjs` bundles the main + preload (Vite lib builds), starts the Vite
dev server for the renderer (HMR), and launches Electron pointed at it via
`VITE_DEV_SERVER_URL`. DevTools opens detached.

> Note: GUI launch is best-effort. In a headless/sandboxed environment Electron
> may not open a window — that does not affect the build or tests.

## Build & package

```bash
# From repo root. Bundled ffmpeg is required for a real packaged app:
bash scripts/build-ffmpeg.sh
npm run build   -w packages/app   # vite: main + preload + renderer → dist/
npm run dist    -w packages/app   # build, then electron-builder --dir → release/mac-arm64/Cast Gorilla.app
npm run dist:dmg -w packages/app  # build, then electron-builder (dir + DMG)
npm run typecheck -w packages/app # tsc --noEmit (app is a standalone TS project)
```

`electron-builder.yml` targets mac `dir` + `dmg` (arm64), Developer ID signing +
notarization when credentials are present, `publish: null` (official DMGs go to
Gumroad only — see `docs/DISTRIBUTION.md`), bundles `vendor/ffmpeg/arm64` into
`Contents/Resources/ffmpeg/`, and injects the local-network Info.plist keys.
Full release traps and post-DMG codesign/staple steps: root `CLAUDE.md` →
RELEASE PACKAGING.

### castv2 + asar (why `asarUnpack`)

The cast transport depends on `castv2`, which loads its Protobuf schema at
runtime by file path:

```js
// node_modules/castv2/lib/proto.js
var builder = protobuf.load(__dirname + "/cast_channel.proto", onLoad);
```

Inside an `asar` archive `__dirname` is a virtual path and protobufjs's own `fs`
read of the `.proto` is unreliable, so the `CastMessage` type can silently fail
to build and cast connections never form. `electron-builder.yml` therefore
**unpacks castv2**:

```yaml
asarUnpack:
  - "**/node_modules/castv2/**"
```

This places `castv2` (and its `cast_channel.proto`) under
`Contents/Resources/app.asar.unpacked/…`, so `__dirname` resolves to a real
on-disk directory and the schema loads normally. Verified in the packaged app:

```bash
# the runtime-loaded asset is present on disk (unpacked, not inside the asar):
ls "release/mac-arm64/Cast Gorilla.app/Contents/Resources/app.asar.unpacked/node_modules/castv2/lib/cast_channel.proto"
# the engine + its runtime deps are inside the asar:
npx asar list "release/mac-arm64/Cast Gorilla.app/Contents/Resources/app.asar" \
  | grep -E '/node_modules/(@castgorilla/engine|castv2|bonjour-service|zod|protobufjs)'
```

## Tests

```bash
npm test -w packages/app          # standalone (packages/app/vitest.config.ts)
# — or — the root run also discovers these via its packages/** glob:
npm test
```

- `test/engine-service.test.ts` — the main-side handlers driven against the
  MockEngine with fake timers (discovery, full session state machine, 1Hz status,
  transport, track selection, single-session invariant).
- `test/store.test.ts` — position interpolation math + state transitions + device
  selection logic.
- `test/ipc-contract.test.ts` — channel-name uniqueness, handler-table coverage vs
  the `REQ` contract, a handler round-trip, and plan-summary formatting.
- `test/engine-host.test.ts` — the engine **gate**: real engine by default,
  `CASTGORILLA_MOCK=1` forces the mock (without importing the real engine), and any
  real-engine load failure falls back to the mock with a visible reason.

## Running the packaged app on a real Chromecast — first-run flow

Prefer the **official Gumroad DMG** when testing what customers get
(`docs/DISTRIBUTION.md`). For a local contributor build:

The real engine needs macOS **local-network** permission. A **signed** official
build also bundles ffmpeg; an old ad-hoc local build may still fall back to
Homebrew. Do realistic TCC tests from an app in `/Applications`:

1. **ffmpeg:** Official DMG — bundled (no Homebrew). Local/dev without
   `scripts/build-ffmpeg.sh` — `brew install ffmpeg`. The engine resolves via
   `$CASTGORILLA_FFMPEG`/`$CASTGORILLA_FFPROBE`, then `PATH`, then
   `/opt/homebrew/bin`. If ffmpeg is missing or too old, opening a file shows a
   **persistent red banner** (the app does not crash).
2. **Build + copy:** `bash scripts/build-ffmpeg.sh`, then
   `npm run dist -w packages/app`, then copy
   `release/mac-arm64/Cast Gorilla.app` to **`/Applications`**.
3. **Gatekeeper:** Official notarized builds open normally. Local unsigned /
   ad-hoc builds need **right-click → Open** the first time. Shipping steps for
   Developer ID + notarization: root `CLAUDE.md` → RELEASE PACKAGING.
4. **Local-network prompt:** on first launch macOS shows a prompt for Cast Gorilla
   to find devices on the local network → **Allow**. This is what lets
   `_googlecast._tcp` discovery see your Chromecasts. If you dismissed it,
   re-enable under `System Settings → Privacy & Security → Local Network`.
5. The device dropdown shows **"Searching…"** until discovery returns (a few
   seconds is normal); then pick a device, **Open File…**, review the plan, and
   **Play**.

### Why not `npm run dev` for real casting?

- **`npm run dev` discovery may be silently blocked.** In dev the running process
  is `Electron.app` (the dev binary), not the signed castgorilla app, so the OS may
  never prompt for or grant local-network access — `_googlecast._tcp` can come
  back empty even on a network full of Chromecasts. This is a TCC limitation,
  **not** an engine bug. (`CASTGORILLA_MOCK=1 npm run dev` gives you two canned mock
  devices for UI work.)
- **For iterating on the streaming pipeline, use the CLI** (`packages/cli`) — it
  is the pipeline dev loop and is not gated the same way as a GUI app doing mDNS.
- The Info.plist keys that back the prompt are baked in by `electron-builder.yml`:
  `NSLocalNetworkUsageDescription` and `NSBonjourServices: ["_googlecast._tcp"]`
  (verified present in the packaged `Contents/Info.plist`).

## The engine gate (real by default, mock as an escape hatch)

The app's **only runtime coupling** to the engine lives in one file:
[`src/main/engine-host.ts`](src/main/engine-host.ts). It exposes
`createEngineForApp()`, which returns `{ engine, mode }`. Everything else in the
app talks to the abstract `Engine` type.

The **real engine is the default**. The single environment switch is
`CASTGORILLA_MOCK`:

```ts
// src/main/engine-host.ts
const FORCE_MOCK = process.env.CASTGORILLA_MOCK === '1';
```

- **Default (unset):** the host does a guarded `await import('@castgorilla/engine')`
  and calls `createEngine()` → `mode: { mock: false }`.
- **`CASTGORILLA_MOCK=1`:** returns the canned MockEngine (two mock devices, a
  canned probe/plan/session) without importing the real engine →
  `mode: { mock: true, reason: 'forced by CASTGORILLA_MOCK=1' }`.
- **Fallback:** if the real import can't resolve or `createEngine()` throws, the
  host falls back to the MockEngine with `mode: { mock: true, reason: 'real engine
  unavailable — …' }` rather than crashing. Both mock paths light the **MOCK MODE**
  badge (its `title` shows the reason); the *fallback* case also raises an
  explanatory banner.

> ffmpeg is resolved **lazily** inside the engine on the first probe/play, so a
> missing ffmpeg does **not** trip this fallback — the real engine still loads and
> the ffmpeg error surfaces as a clear renderer banner when you open a file.

Notes:
- The mock is imported by **relative dist path**
  (`../../../engine/dist/mock/mock-engine.js`), so it is always available as the
  fallback and bundles into `dist/main/index.cjs` (its only deps are a pure
  emitter + the device-profile table — no native modules).
- The real engine and its native/runtime deps (`castv2`, `bonjour-service`, `zod`,
  `protobufjs`) are marked **external** in `electron.main.config.ts` so nothing
  native is bundled into the main chunk; they are instead collected from
  `@castgorilla/engine`'s dependency tree into the packaged asar by
  electron-builder (see [castv2 + asar](#castv2--asar-why-asarunpack)).

## Type-checking & the project graph

This package is a **standalone** TS project (`tsconfig.json`, `noEmit`), typed
via `npm run typecheck` and built by Vite. It is intentionally **not** wired into
the repo-root `tsc -b` project-references graph — adding it would require editing
the root `tsconfig.json`, which is out of scope for this workstream. It consumes
the engine's frozen types from the engine's built `dist` by relative path, so it
never triggers a rebuild of the (concurrently-changing) engine source.
