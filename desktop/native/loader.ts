// Loader for the native video-wall addon.
//
// ══ TODAY IT ALWAYS ANSWERS "NO", AND THAT IS THE POINT ═════════════════════
//
// The addon does not exist. This reports it as unavailable, `AppInfo.
// nativeWallAvailable` is a truthful `false`, and the shell runs exactly as it
// does now: the webview renders live video the way the browser does, because that
// is the same code path. Nothing is degraded, because nothing was ever switched
// on.
//
// The alternative — leaving the flag out, or hard-coding `true` against a future
// build — is how a console ends up offering a 64-tile wall on a machine that
// cannot render one. A capability flag that lies is worse than no flag: the UI
// makes a promise, the frames do not arrive, and the operator reports it as
// "the wall is broken" rather than "this box is not fast enough".
//
// When the addon lands it is a prebuilt N-API binary shipped under
// resources/native/<platform>-<arch>/ and require()'d here. Nothing else in the
// shell changes: the flag starts answering `true` on machines that have it.
//
// The interface, the composition problem it has to solve, and the measurement
// that must happen BEFORE any of it is written are in native/README.md.

let cached: NativeWall | null | undefined;

export interface NativeWall {
  /** libVLC build string, for the diagnostics panel and for bug reports — the
   *  version of the decoder is the first question every video bug asks. */
  version(): string;

  // The surface, sketched in README.md and deliberately NOT declared yet.
  // Declaring methods nothing implements produces a type that compiles, an
  // autocomplete list that suggests them, and a runtime that throws.
  //
  //   createSurface(parent: Buffer, bounds: Rect): SurfaceId
  //   play(surface: SurfaceId, rtspUrl: string, opts: DecodeOpts): void
  //   stop(surface: SurfaceId): void
  //   setBounds(surface: SurfaceId, bounds: Rect): void
}

function tryLoad(): NativeWall | null {
  try {
    // Not resolvable yet, by construction. Wrapped so that a missing addon is a
    // normal "no native wall" rather than a main-process crash on startup —
    // which is what an unguarded require of an absent .node file is.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./build/Release/neubit_wall.node") as NativeWall;
    return mod;
  } catch {
    return null;
  }
}

export function isNativeWallAvailable(): boolean {
  if (cached === undefined) cached = tryLoad();
  return cached !== null;
}

export function nativeWall(): NativeWall | null {
  if (cached === undefined) cached = tryLoad();
  return cached;
}
