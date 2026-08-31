# `native/` — the video-wall decode addon

> **Status: not built.** `loader.ts` reports it unavailable, `AppInfo.nativeWallAvailable`
> is a truthful `false`, and the shell runs without it — the webview renders live video
> exactly as the browser does, because it is the same code path.
>
> This file is the design. It was supposed to arrive with the hand-off from the recorder
> and did not: `neubit_nvr/desktop/native/README.md` says "the design notes below are kept
> verbatim as the starting point for whoever implements it in `neubit_v3`" and then ends.
> There are no notes below that line — the whole file is the twenty-line move notice. So
> this is written from v3's own code rather than inherited, and the gap is recorded here so
> nobody else spends an afternoon looking for a document that does not exist.

## The question, and why it is not yet answered

**Does Chromium keep up with a dense wall of this customer's cameras?** Everything else
follows from that number, and it has not been measured — the development stack has **zero
cameras** in `neubit_vision.cameras`, so there was nothing to measure. Write no C++ until
somebody runs the measurement in §4 on real streams.

That said, three facts about v3's current path are known from the code and they are what
make the addon likely to be needed rather than merely nice.

## 1. What the console does today

`features/vms/components/LivePlayer.jsx` is the single player behind every live surface —
the streaming grid, the camera detail, and **every cell of the video wall** (`WallCell.jsx`
renders `LivePlayer`). Its engine, from its own header:

1. **WebRTC/WHEP first** — the SDP offer goes straight to MediaMTX's `/whep` endpoint. Low
   latency, and it plays HEVC that Chromium's MSE rejects.
2. **HLS fallback** when WHEP will not negotiate.

And the detail that matters most here:

> "WHEP POST for an H265 camera fails to negotiate (MediaMTX returns 400). We then retry
> ONCE against the transcoded variant — the same WHEP URL with `/h264` inserted before the
> trailing `/whep` segment. **MediaMTX runs ffmpeg on demand** to produce it."

## 2. Three reasons the native path is worth its cost

1. **HEVC costs the SERVER, per stream.** Every HEVC camera a Chromium client watches
   becomes an ffmpeg transcode on the recorder. libVLC decodes HEVC directly, in the client,
   on the GPU — the transcode disappears, and with it the reason the server's CPU scales
   with the number of people watching.
2. **One WebRTC PeerConnection per tile.** A 16-cell panel is 16 ICE negotiations, 16 DTLS
   handshakes and 16 jitter buffers, each with its own timers, inside one renderer process.
   Direct RTSP has none of that machinery.
3. **Chromium decides how to decode; we do not.** Hardware decode in the webview is a
   platform decision that varies by GPU driver and silently falls back to software. libVLC
   lets the decoder be chosen, reported and, when it is wrong, fixed.

## 3. How to compose it — the part that actually decides the architecture

Electron gives three ways to get native pixels onto a screen. Two are traps.

**A. A child HWND per tile, parented to the BrowserWindow.**
`win.getNativeWindowHandle()` gives the HWND; libVLC's `libvlc_media_player_set_hwnd` takes
one. It works, and it drags in the classic *airspace* problem: a native child window is
always on top of the web content and is not clipped by DOM stacking. Every overlay the
console draws over a cell — the PTZ pad, the alarm border, the hover toolbar, the drag
target — would disappear behind the video. Rebuilding those natively is rebuilding the UI.

**B. A whole PANEL rendered natively, with no DOM in it at all. ← recommended**
The wall panel screens show only cells. The controls live on the operator's console screen,
which is a different piece of glass — that is what a video wall *is*, and it is already how
v3 is built: `/wall-display/[id]/[mid]` is deliberately outside the `(app)` chrome, and
`WallKiosk.jsx` is read-only with nothing but a small auto-hiding identity badge. So a
panel has no overlays to lose, and the airspace problem never arises.

This also means **the addon replaces the CONTENTS of a wall window, not the console**, and
`main/screens.ts` already produces exactly the right container: one full-screen window per
physical panel, positioned, restored and reconciled. The native path would swap the loaded
URL for a native surface in that same window and keep the wall state subscription (the SSE
in `useWallState`) in a hidden renderer that tells the addon which camera belongs in which
cell.

**C. Frames back into the renderer as textures.**
`libvlc_video_set_callbacks` hands raw frames to a callback; upload them to a WebGL texture
and the DOM composites normally. It is the tidy answer and it does not survive arithmetic:
16 tiles of 1080p30 in NV12 is roughly **1.5 GB/s of memcpy** before a single pixel is
uploaded. A zero-copy variant needs a shared D3D11 texture handle injected into Chromium's
compositor, and Electron exposes no supported way to do that.

## 4. The measurement to run first

On a machine with the customer's real cameras, with the browser panel as it ships today:

| | |
|---|---|
| Load | 1, 4, 9, 16 cells, at the profile the wall actually uses (`sub` for dense, `main` for solo) |
| Dropped frames | `video.getVideoPlaybackQuality()` — `droppedVideoFrames` over `totalVideoFrames`, per tile |
| Decode path | `chrome://media-internals` — is it hardware, and does it stay hardware at 16 tiles |
| Host cost | CPU and GPU decode utilisation, and **ffmpeg processes on the recorder** while watching |
| Latency | glass-to-glass against a clock in frame |

The tile count at which frames start dropping is the whole answer. If it is comfortably
above the densest panel a customer buys, the addon is not worth its maintenance and this
file should say so. If it is at or below it, build B.

## 5. The surface, when it is built

Deliberately narrow, and deliberately not declared in `loader.ts` until something implements
it — a type that compiles, autocompletes and then throws is worse than no type.

```ts
createSurface(parentHwnd: Buffer, bounds: Rect): SurfaceId
play(surface: SurfaceId, rtspUrl: string, opts: { hwDecode: boolean }): void
stop(surface: SurfaceId): void
setBounds(surface: SurfaceId, bounds: Rect): void
version(): string          // the libVLC build string — the first question every video bug asks
```

Built with `cmake-js` against libVLC, shipped as a prebuilt `.node` under
`resources/native/<platform>-<arch>/` and `require()`d by `loader.ts`. It must stay optional:
a build without it is a working product, and `isNativeWallAvailable()` is how the console
finds out.

## 6. What would make this unnecessary

If the recorder transcoded HEVC to H.264 **once, at ingest**, instead of once per watching
client, reason 1 disappears. That is a change in `neubit_nvr`, it costs storage or a second
recorded profile, and it is worth costing before committing to a C++ addon in this repo.
Raise it with the recorder team before starting.
