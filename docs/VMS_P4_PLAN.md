# VMS — Phase 4 plan (playback + export + NVR footage extraction)

Play back recorded video (timeline scrub, synchronized multi-camera), export clips (tamper-evident later in P6), and pull recorded footage from onboarded 3rd-party NVRs. Builds on P3 recordings (fmp4 segments on pooled storage). Same plane split: Go `nvr` orchestrates recorded playback via MediaMTX's **playback server**; `vision` issues recorded PlaybackSessions + export jobs; `nvr` drivers pull NVR footage.

## Approach — MediaMTX playback server
MediaMTX ships a **playback server** (`playback: yes`, its own port) that serves recorded segments of a path as a seekable stream: `/list?path=` (available segments) + `/get?path=&start=&duration=&format=fmp4|mp4`. So the Go `nvr` builds a recorded-playback URL for a camera + time-window from its recorded segments — no re-implementing a segment player. (gvd_nvr's continuous-playback + timeline is the UX reference.)

## Modules

### P4-A — recorded playback (Go nvr + vision)
- **compose/mediamtx.yml**: enable the playback server; expose it internally; route it through Traefik under a `/media/playback` prefix with the **same ForwardAuth media token** as P2-C (reuse `media-auth`).
- **Go nvr** (`internal/mediamtx` + a playback route): `PlaybackList(node, name, from, to)` → available recorded ranges (from MediaMTX `/list`); `PlaybackURL(node, name, from, duration)` → the `/get` URL. Internal endpoint `GET /api/v1/nvr/playback/{camera}/{profile}?from=&to=` → `{segments:[...], playback_url}`.
- **vision** (`live` domain extended, or a `playback` domain): `POST /api/v1/vms/cameras/{id}/playback {from, to, profile?}` → resolve Recording rows in the window + ask nvr for the playback URL → mint a media token → return a **RECORDED** PlaybackSession `{hls_url (playback), token, segments, from, to}` (reuse the P2 PlaybackSession model, `kind="recorded"`). `GET /api/v1/vms/cameras/{id}/timeline?day=` → recording coverage + gaps + (P5) motion/event markers for the scrub bar (from Recording rows).
- Verify (synthetic recorded segments from P3): request playback for a recorded window → get a token-gated playback HLS URL that serves the recorded fmp4; timeline returns coverage; graceful when no recordings.

### P4-B — export + NVR footage extraction (vision + nvr)
- **Clip export** (vision, a job): `POST /api/v1/vms/cameras/{id}/export {from, to, format?=mp4}` → an **export job** (queued, like the retention worker) that concatenates the covered fmp4 segments into a single mp4 (ffmpeg concat/remux — `-c copy` when possible), writes to a downloads area, returns a job id; `GET /export/{job}` (status) + `GET /export/{job}/download` (token-gated file). `Recording` lock already protects source segments.
- **Snapshot from recording** (a frame at a timestamp) — optional, cheap (ffmpeg single-frame).
- **NVR footage extraction** (nvr drivers): implement the P1 driver stubs `search_recordings(nvr, channel, from, to)` + `get_playback_uri(nvr, channel, from)` for **ONVIF Profile G** + **Hikvision ISAPI** (ContentMgmt/search) + **CP-Plus/Dahua** (mediaFileFind RPC) + **Lumina**. Expose `GET /api/v1/vms/nvrs/{id}/channels/{ch}/recordings?from=&to=` (search the NVR's own storage) + `POST .../playback` (a session that plays the NVR's recorded stream, RTSP-with-time or a downloaded clip). This gives the **unified timeline/export across our recordings + client NVRs** — a market differentiator. Fixture-test the URL/search construction; live-validate on owner NVRs (`# LIVE-VALIDATE:`).
- Verify: export a recorded window → mp4 job → download; NVR recording-search returns fixture results; graceful.

### P4-C — frontend playback (timeline scrub + sync + export UI)
- **PlaybackPlayer** (`features/vms/`): a recorded-video player over a **timeline scrub bar** (coverage + gaps from `/timeline`; drag to seek → new playback session at that time; speed 0.5/1/2/4x, frame-step, reverse where feasible). Reuse the P2 media player plumbing (HLS) for the playback URL.
- **Synchronized multi-camera** playback (a few cameras on one shared timeline — port gvd_nvr `MultiPlayback`).
- **Export dialog**: pick range → export → job progress → download. **Bookmarks** (mark a timestamp + note; port gvd_nvr bookmarks) — optional here, can slip to P6.
- Wire playback into the **Recordings** view (the P3-C "Play (P4)" disabled action → open PlaybackPlayer) + a "Playback" surface; NVR recordings browse for onboarded NVRs.
- Verify: routes 200, compile clean; real scrub/playback needs a browser + recorded footage.

## Honest verifiability
Recorded playback + export testable with the synthetic recorded segments (P3). NVR footage extraction is fixture-tested; real NVR playback validates on owner hardware. Tamper-proof signed export = P6.

## Done when
Recorded video plays back with a timeline scrub (single + sync multi-cam), clips export to mp4, and footage can be searched/played from onboarded NVRs — verified on synthetic recordings + fixtures. Then P5 (events + alarms + linkage).
