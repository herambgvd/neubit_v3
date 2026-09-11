"use client";

// VMS API module — cameras, NVRs, camera-groups, per-camera ACL, health, and
// ONVIF discovery/onboarding. Wraps the shared `api` axios instance (baseURL
// already "/api/v1") and unwraps `.data` so callers get plain objects — same
// convention as features/ingest/api.js and lib/api/sites.js. The gateway routes
// "/api/v1/vms/*" → the `vision` (Python) service.
//
// Backend contract (VMS P1, all under /api/v1/vms):
//   Cameras:   GET/POST /cameras · GET/PATCH/DELETE /cameras/{id}
//              POST /cameras/bulk (enable|disable|group|retention|delete, cap 200)
//              POST /cameras/reorder
//   Discovery: POST /cameras/onvif/discover|probe|channels|bulk-add|snapshot
//              GET  /cameras/{id}/snapshot
//   Config:    POST /cameras/{id}/ptz · PATCH /cameras/{id}/imaging|io
//              GET/PUT /cameras/{id}/motion-config|privacy-masks|onvif-events
//   NVR:       GET/POST /nvrs · GET/PATCH/DELETE /nvrs/{id}
//              POST /nvrs/discover · GET /nvrs/{id}/channels · POST /nvrs/channels
//              POST /nvrs/{id}/map-channels · GET /nvrs/{id}/health · POST /nvrs/{id}/refresh
//   Groups:    GET/POST /camera-groups · PATCH/DELETE /camera-groups/{id}
//   Patterns:  GET/POST /patterns · GET/PATCH/DELETE /patterns/{id}
//   ACL:       GET/PUT /cameras/{id}/acl
//   Health:    GET /cameras/health · GET /cameras/{id}/health/history
//              POST /cameras/{id}/health/refresh
//
// Credentials (onvif.password / nvr password) are WRITE-ONLY — sent on
// create/update, never returned (public shapes expose has_password/has_credentials).
//
// Types: every request body / response is one of the wire types in ./types
// (one interface per Pydantic model, backend file named there). Ids are strings.
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type { FederatedCameraList, QueryParams } from "@/lib/types";
import type {
  IsolationTrace,
  NodeSysmon,
  PulseOverview,
  BookmarkCreate,
  BookmarkListResponse,
  BookmarkPublic,
  BookmarkUpdate,
  BulkResult,
  CameraBulkBody,
  CameraCreate,
  CameraGroupCreate,
  CameraGroupListResponse,
  CameraGroupPublic,
  CameraGroupUpdate,
  CameraListResponse,
  CameraReorderItem,
  CameraUpdate,
  EvidenceCheckResult,
  EvidenceLockCreate,
  EvidenceLockListResponse,
  EvidenceLockPublic,
  FederatedBackchannel,
  FederatedExportJob,
  FederatedExportList,
  FederatedExportPublicKey,
  FederatedExportVerify,
  FederatedHold,
  FederatedHoldList,
  FederatedLiveSession,
  FederatedMotionSearch,
  FederatedMotionSearchBody,
  FederatedNvrList,
  FederatedOpResult,
  FederatedPatrol,
  FederatedPatrolBody,
  FederatedPlaybackSession,
  FederatedPreset,
  FederatedPresetList,
  FederatedPtzBody,
  FederatedRecordingList,
  FederatedTimeline,
  FederationNodeList,
  ItemList,
  LinkageFireListResponse,
  LinkageRuleCreate,
  LinkageRuleListResponse,
  LinkageRulePublic,
  LinkageRuleUpdate,
  MediaNodeCreate,
  MediaNodeListResponse,
  MediaNodePublic,
  MediaNodeUpdate,
  NodeCredentialPublic,
  NodeEnrollResult,
  NodeRaidStatus,
  NodeStoragePoolList,
  NodeStorageUsage,
  NodeTierRuleList,
  NodeArchive,
  NodeRestoreJobList,
  NodeRestoreRangeList,
  CameraRecordingConfig,
  ScheduleApplyResult,
  ScheduleTemplate,
  ScheduleTemplateBody,
  ScheduleTemplateList,
  NodeUpstreamNvrStorage,
  PatternCreate,
  PatternListResponse,
  PatternPublic,
  PatternUpdate,
  PlaybackSessionPublic,
  PtzResult,
  ReorderResult,
  VmsCameraPublic,
  VmsEventListResponse,
  VmsEventPublic,
} from "./types";

const CAMERAS = "/vms/cameras";
const GROUPS = "/vms/camera-groups";
const PATTERNS = "/vms/patterns";
const EVENTS = "/vms/events";
const LINKAGE = "/vms/linkage-rules";
const BOOKMARKS = "/vms/bookmarks";
const PULSE = "/vms/pulse";
const EVIDENCE = "/vms/evidence";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

// A blob-typed GET/POST; the caller saves it (Bearer header rides along).
const blob = (p: Promise<AxiosResponse<Blob>>): Promise<Blob> => p.then((r) => r.data);

// Drop null/undefined/"" so URLSearchParams doesn't emit empty filters.
function qs(params: QueryParams = {}): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}


/** A `[from, to]` ISO window (both optional on the reads). */
interface WindowOpt {
  from?: string | null;
  to?: string | null;
}

/** `{ month:"YYYY-MM", tzOffsetMinutes }` for the recording-days calendar marks. */

/** A federated recording-index page: window + profile + skip/limit. */
interface FederatedRecordingsOpt extends WindowOpt {
  profile?: string | null;
  limit?: number;
  offset?: number;
}

export const vms = {
  // ── Pulse — the estate's operational health ──────────────────────────────
  // Served by vision's `app/vms/pulse`, which fans out to each recorder's own
  // System-Monitor board. The overview NEVER computes a figure across a recorder
  // that did not answer: `partial` says whether any did not, and `unreachable`
  // names them, so the console can say "3 of 4 recorders answered" above its
  // totals rather than presenting a partial estate as the whole one.
  pulse: {
    overview: () => unwrap(api.get<PulseOverview>(`${PULSE}/overview`)),
    // One recorder's whole board, relayed exactly as the recorder reports it.
    nodeSysmon: (nodeId: string) => unwrap(api.get<NodeSysmon>(`${PULSE}/nodes/${nodeId}/sysmon`)),
    // The per-camera fault trace: camera → network → ingest → decode → storage →
    // display, with the recorder's own evidence and verdict.
    isolate: (nodeId: string, cameraId: string, profile?: string | null) =>
      unwrap(
        api.get<IsolationTrace>(
          `${PULSE}/nodes/${nodeId}/cameras/${cameraId}/isolate${qs({ profile })}`,
        ),
      ),
  },

  // ── Federation — node-authoritative cameras across recorder nodes ────────
  // The VMS pulls each registered recorder's own cameras up + streams them THROUGH
  // the node (the node owns them). GET cameras aggregates all online nodes; live
  // mints a node-issued token for a federated camera.
  federation: {
    nodes: () => unwrap(api.get<FederationNodeList>("/vms/federation/nodes")),
    cameras: () => unwrap(api.get<FederatedCameraList>("/vms/federation/cameras")),
    live: (nodeId: string, cameraId: string, profile?: string | null) =>
      unwrap(
        api.post<FederatedLiveSession>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/live${qs({ profile })}`,
        ),
      ),
    // Recorded-coverage ranges (scrub-bar timeline) for a federated camera.
    timeline: (nodeId: string, cameraId: string, { profile, from, to }: WindowOpt & { profile?: string | null } = {}) =>
      unwrap(
        api.get<FederatedTimeline>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/timeline${qs({ profile, from, to })}`,
        ),
      ),
    // Per-segment recording index for a federated camera.
    recordings: (nodeId: string, cameraId: string, { profile, from, to, limit, offset }: FederatedRecordingsOpt = {}) =>
      unwrap(
        api.get<FederatedRecordingList>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/recordings${qs({ profile, from, to, limit, offset })}`,
        ),
      ),
    // Mint a playback session (tokenized fmp4 URL + t=0 start) through the node.
    playback: (nodeId: string, cameraId: string, { from, to }: WindowOpt = {}) =>
      unwrap(
        api.post<FederatedPlaybackSession>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/playback${qs({ from, to })}`,
        ),
      ),
    // ── operate-THROUGH-node — the operator command surface on a node-owned camera
    // PTZ a federated camera through its recorder. `body` = { action:"move"|"stop",
    // ...payload } (the node forwards the payload to the device). Zoom is the `zoom`
    // velocity in a move body, not an action of its own.
    //
    // Node-side PTZ gates on vms.ptz.control, which the scoped federation credential
    // DOES carry — so this works over federation alone. (It did not: the node gated
    // these routes on vms.camera.manage, a permission deliberately withheld from a
    // federation credential, so every federated PTZ command 403'd. Fixed node-side.)
    ptz: (nodeId: string, cameraId: string, body: FederatedPtzBody) =>
      unwrap(api.post<PtzResult>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz`, body)),

    // Presets live in the CAMERA's firmware; the recorder reads and writes them there.
    // So `token` is the device's handle, list/save/goto/remove all speak it, and there
    // is no VMS-side preset row behind a federated camera to drift from it.
    presets: {
      list: (nodeId: string, cameraId: string) =>
        unwrap(api.get<FederatedPresetList>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/presets`)),
      // Empty token CREATES at the head's current position; a supplied token
      // OVERWRITES that preset with it — two different intentions, so the caller
      // states which.
      save: (nodeId: string, cameraId: string, name: string, token?: string) =>
        unwrap(api.post<FederatedPreset>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/presets`, { name, token })),
      goto: (nodeId: string, cameraId: string, token: string, speed?: number) =>
        unwrap(api.post<PtzResult>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/presets/${encodeURIComponent(token)}/goto`,
          { speed })),
      remove: (nodeId: string, cameraId: string, token: string) =>
        unwrap(api.delete<void>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/presets/${encodeURIComponent(token)}`)),
    },

    // ONE host-driven patrol per camera — the recorder drives it, the camera does not
    // store it. Not a list: that is the node's model, and inventing a multi-patrol
    // shape here would mean asking the recorder to fake the other rows.
    patrol: {
      get: (nodeId: string, cameraId: string) =>
        unwrap(api.get<FederatedPatrol>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/patrol`)),
      set: (nodeId: string, cameraId: string, body: FederatedPatrolBody) =>
        unwrap(api.put<FederatedPatrol>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/patrol`, body)),
      operate: (nodeId: string, cameraId: string, operation: "start" | "stop") =>
        unwrap(api.post<FederatedOpResult>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/ptz/patrol/operate`, { operation })),
    },

    // Focus is a MOTOR on the lens, not a PTZ head command, so it has its own
    // routes. Same hold-to-move discipline as the pad: one move on press, one stop
    // on release.
    focus: {
      move: (nodeId: string, cameraId: string, body: { direction: "near" | "far"; speed?: number }) =>
        unwrap(api.post<FederatedOpResult>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/imaging/focus/move`, body)),
      stop: (nodeId: string, cameraId: string) =>
        unwrap(api.post<FederatedOpResult>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/imaging/focus/stop`, {})),
    },
    // Two-way audio. `begin` is the recorder's capability + transport check and the
    // audited record that somebody spoke; the UPLINK itself is not here, because it
    // streams a request body and axios buffers one — holding every frame until the
    // operator lets go. TalkButton issues that one with fetch.
    talk: {
      begin: (nodeId: string, cameraId: string) =>
        unwrap(api.post<FederatedOpResult>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/talk`, {})),
      // Whether the camera can RECEIVE talk-back AND this recorder can carry it —
      // two different facts that fail differently, which is why the response keeps
      // `support` and `talk_stream_ready` apart.
      capability: (nodeId: string, cameraId: string) =>
        unwrap(api.get<FederatedBackchannel>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/backchannel`)),
    },
    // Forensic region motion search over the recorder's OWN recorded footage. It has
    // to run there: the search decodes the segment files, and those are on its disk.
    //
    // Synchronous and BOUNDED — the recorder caps span, frames and time, and reports
    // what it actually examined. Render `complete`/`notes` or an incomplete search
    // reads as "the footage is clear", and render `method` or a list of timestamps
    // reads as object detection. Neither is optional.
    motionSearch: (nodeId: string, cameraId: string, body: FederatedMotionSearchBody) =>
      unwrap(api.post<FederatedMotionSearch>(
        `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/motion-search`, body)),
    // Snapshot URL for a federated camera (relative path — fetched as an authed
    // blob, same as cameras.snapshotUrl, since the endpoint needs the Bearer header).
    snapshotUrl: (nodeId: string, cameraId: string) =>
      `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/snapshot`,

    // ── operate-THROUGH-node — operational actions PROXIED to the owning recorder
    // The VMS never touches a node-owned camera directly; it asks the node to do it.
    // Same seam as ptz/snapshot above. All best-effort — the node forwards to the
    // device/recorder and echoes its result. Node-side gates apply; the VMS also
    // hides each control behind the operator's own permission (see FederatedCameraDetail).
    actions: {
      // Manual recording — flip the node's recording on this camera on/off now.
      recordStart: (nodeId: string, cameraId: string) =>
        unwrap(api.post<FederatedOpResult>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/recording/start`, {})),
      recordStop: (nodeId: string, cameraId: string) =>
        unwrap(api.post<FederatedOpResult>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/recording/stop`, {})),
      // Reboot the camera through its recorder's brand driver.
      reboot: (nodeId: string, cameraId: string) =>
        unwrap(api.post<FederatedOpResult>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/reboot`, {})),
      // ── Clip export (job) — { from, to } (RFC3339) → { id, status }. Poll getExport
      // until status is ready/done, then pull the mp4 as an authed blob (Bearer header,
      // same idiom as export.downloadBlob) rather than a bare <a href>.
      // `watermark` burns a visible provenance stamp into the picture. It makes the
      // recorder RE-ENCODE — pixels cannot be drawn into a stream copy — so the clip
      // stops being bit-identical to the recorded segments and the job takes
      // materially longer. Off by default; the operator opts in per export.
      createExport: (nodeId: string, cameraId: string, from: string, to: string, watermark = false) =>
        unwrap(api.post<FederatedExportJob>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/exports`, { from, to, watermark })),
      listExports: (nodeId: string, cameraId: string) =>
        unwrap(api.get<FederatedExportList>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/exports`)),
      getExport: (nodeId: string, exportId: string) =>
        unwrap(api.get<FederatedExportJob>(`/vms/federation/nodes/${nodeId}/exports/${exportId}`)),
      downloadExportBlob: (nodeId: string, exportId: string) =>
        blob(api.get<Blob>(`/vms/federation/nodes/${nodeId}/exports/${exportId}/download`, { responseType: "blob" })),
      // ── Chain of custody ──────────────────────────────────────────────────
      // The recorder re-hashes ITS copy of the clip and checks the manifest
      // signature. It has to be the recorder: the clip lives on its disk, and a
      // hash taken here would only prove the copy we were handed arrived intact.
      // valid:false comes back as a 200 with a reason — "this cannot be verified"
      // is the answer, not a failure to ask.
      verifyExport: (nodeId: string, exportId: string) =>
        unwrap(api.post<FederatedExportVerify>(
          `/vms/federation/nodes/${nodeId}/exports/${exportId}/verify`, {})),
      // The signed manifest, relayed byte for byte (the signature covers the
      // document's canonical bytes, so it must not be re-encoded in transit).
      exportManifestBlob: (nodeId: string, exportId: string) =>
        blob(api.get<Blob>(`/vms/federation/nodes/${nodeId}/exports/${exportId}/manifest`, { responseType: "blob" })),
      // The recorder's signing key, so a verifier can pin it independently of the
      // manifest that claims it. Per recorder — each signs with its own identity.
      exportPublicKey: (nodeId: string) =>
        unwrap(api.get<FederatedExportPublicKey>(`/vms/federation/nodes/${nodeId}/exports/public-key`)),
      // ── Evidence hold — retention-lock a [from,to] window of this camera's footage
      // on the owning recorder (reason is a free-text note). Release cancels it.
      holds: (nodeId: string, cameraId: string) =>
        unwrap(api.get<FederatedHoldList>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/holds`)),
      holdCreate: (nodeId: string, cameraId: string, from: string, to: string, reason?: string | null) =>
        unwrap(api.post<FederatedHold>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/holds`, { from, to, reason })),
      holdRelease: (nodeId: string, cameraId: string, from: string, to: string) =>
        unwrap(api.delete<FederatedOpResult>(`/vms/federation/nodes/${nodeId}/cameras/${cameraId}/holds${qs({ from, to })}`)),
    },

    // ── Storage (single-ownership) — READ-ONLY per recorder node ────────────
    // Storage is OWNED + managed by the standalone recorder; the VMS only reads it
    // through the node. All GET, read-only. Tagged with node_id/node_name.
    //   usage      → { total_bytes, free_bytes, used_bytes, used_percent, reachable, … }
    //   raid       → md-array health ({ available, arrays:[…], reason? })
    //   pools      → { items:[StoragePool{ id, name, kind local|nfs|smb|s3, path, usage }] }
    //   tierRules  → { items:[TierRule…] } (source → target after N hours)
    //   upstreamNvr→ a 3rd-party NVR's own HDDs as reported by the recorder, or
    //                { available:false } when not yet available.
    // The third-party NVR/DVR appliances a recorder has onboarded. READ-ONLY, and
    // that is the whole shape of third-party NVR support: the recorder onboards them,
    // holds their credentials and syncs their channels into proxy cameras; this says
    // which appliances exist and how they are doing.
    //
    // Their footage needs no route of its own — a channel IS a camera on the node, so
    // it arrives in `cameras` above and plays through the ordinary camera routes.
    nvrs: (nodeId: string) =>
      unwrap(api.get<FederatedNvrList>(`/vms/federation/nodes/${nodeId}/nvrs`)),

    storage: {
      usage: (nodeId: string) => unwrap(api.get<NodeStorageUsage>(`/vms/federation/nodes/${nodeId}/storage/usage`)),
      raid: (nodeId: string) => unwrap(api.get<NodeRaidStatus>(`/vms/federation/nodes/${nodeId}/storage/raid`)),
      pools: (nodeId: string) => unwrap(api.get<NodeStoragePoolList>(`/vms/federation/nodes/${nodeId}/storage/pools`)),
      tierRules: (nodeId: string) => unwrap(api.get<NodeTierRuleList>(`/vms/federation/nodes/${nodeId}/storage/tier-rules`)),
      upstreamNvr: (nodeId: string, nvrId: string) =>
        unwrap(api.get<NodeUpstreamNvrStorage>(`/vms/federation/nodes/${nodeId}/nvrs/${nvrId}/storage`)),

      // The cold tier. Read-only, and the missing write is the point: starting a
      // restore and configuring the archive both gate node-side on
      // vms.storage.manage, which the federation credential does not carry. The
      // screen links out to the recorder for those rather than offering a button
      // that can only fail.
      archive: (nodeId: string) =>
        unwrap(api.get<NodeArchive>(`/vms/federation/nodes/${nodeId}/storage/archive`)),
      restoreRanges: (nodeId: string, opts: { camera_id?: string; from?: string; to?: string } = {}) =>
        unwrap(api.get<NodeRestoreRangeList>(
          `/vms/federation/nodes/${nodeId}/storage/restore/ranges${qs(opts)}`)),
      restoreJobs: (nodeId: string) =>
        unwrap(api.get<NodeRestoreJobList>(`/vms/federation/nodes/${nodeId}/storage/restore/jobs`)),
    },

    // ── recording schedules — the one CONFIG the VMS authors on a recorder ─────
    // Everything else on this client operates a recorder; these write to it. The
    // node's credential carries exactly one authorship grant and this is what it
    // is for: "record 09:00-18:00 on weekdays" is weekly operator work that used
    // to mean opening each recorder's own console.
    schedules: {
      list: (nodeId: string) =>
        unwrap(api.get<ScheduleTemplateList>(`/vms/federation/nodes/${nodeId}/recording-schedule-templates`)),
      create: (nodeId: string, body: ScheduleTemplateBody) =>
        unwrap(api.post<ScheduleTemplate>(`/vms/federation/nodes/${nodeId}/recording-schedule-templates`, body)),
      update: (nodeId: string, templateId: string, body: ScheduleTemplateBody) =>
        unwrap(api.put<ScheduleTemplate>(
          `/vms/federation/nodes/${nodeId}/recording-schedule-templates/${templateId}`, body)),
      remove: (nodeId: string, templateId: string) =>
        unwrap(api.delete<void>(
          `/vms/federation/nodes/${nodeId}/recording-schedule-templates/${templateId}`)),
      // Applying COPIES the document onto each camera. Editing the template later
      // does NOT reach back into them — the recorder says so, and the screen must
      // not imply a link that is not there.
      apply: (nodeId: string, templateId: string, cameraIds: string[]) =>
        unwrap(api.post<ScheduleApplyResult>(
          `/vms/federation/nodes/${nodeId}/recording-schedule-templates/${templateId}/apply`,
          { camera_ids: cameraIds })),
      // One camera's own config, read and written through its recorder. The PUT is
      // a PATCH: send only what is being changed. The same permission also gates
      // retention_days on this endpoint, so a schedule edit that posted the whole
      // object back would be deciding how long footage survives as a side effect.
      camera: (nodeId: string, cameraId: string) =>
        unwrap(api.get<CameraRecordingConfig>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/recording-config`)),
      setCamera: (nodeId: string, cameraId: string, patch: Partial<CameraRecordingConfig>) =>
        unwrap(api.put<CameraRecordingConfig>(
          `/vms/federation/nodes/${nodeId}/cameras/${cameraId}/recording-config`, patch)),
    },
  },


  cameras: {
    // REGISTRY ONLY. The device calls that used to live here — PTZ, imaging, I/O,
    // encoder, OSD, motion config, privacy masks, ONVIF event subscription, stream
    // policy — are gone with the backend routes behind them. Every one of them needed
    // the camera's credentials, which the recorder holds; they live under
    // `federation` above, against the node that owns the camera.
    // GET /cameras → { items, total, skip, limit }. Filters: status, brand,
    // site_id, group_id, q + skip/limit.
    list: (params: QueryParams = {}) => unwrap(api.get<CameraListResponse>(`${CAMERAS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<VmsCameraPublic>(`${CAMERAS}/${id}`)),
    create: (body: CameraCreate) => unwrap(api.post<VmsCameraPublic>(CAMERAS, body)),
    update: (id: string, body: CameraUpdate) => unwrap(api.patch<VmsCameraPublic>(`${CAMERAS}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${CAMERAS}/${id}`)),
    // POST /cameras/bulk { camera_ids, action, group_id?, retention_days? }.
    bulk: (body: CameraBulkBody) => unwrap(api.post<BulkResult>(`${CAMERAS}/bulk`, body)),
    // POST /cameras/reorder { items: [{ id, display_order }] }.
    reorder: (items: CameraReorderItem[]) => unwrap(api.post<ReorderResult>(`${CAMERAS}/reorder`, { items })),

    snapshotUrl: (id: string) => `${CAMERAS}/${id}/snapshot`,
  },




  // ── Media nodes (recorders) — independent recorder machines ─────────────
  // A MediaNode is a standalone recorder box (its own MediaMTX + storage) that
  // cameras are pinned to via `media_node_id`; unassigned cameras record on the
  // default/"Auto" node. Tenant-scoped. Public shape: { id, name, api_url,
  // hls_base, webrtc_base, rtsp_base, label, capacity_channels, used_channels,
  // status ("online"|"offline"|"draining"|"error"|"unknown"), last_heartbeat }.
  //   GET    /vms/media-nodes → { items }
  //   GET    /vms/media-nodes/{id} → node
  //   POST   /vms/media-nodes { name, api_url, hls_base?, webrtc_base?, rtsp_base?,
  //            label?, capacity_channels?, pairing_code? } → node (may carry `warning`
  //            if the box was unreachable at create time — saved anyway). A supplied
  //            `pairing_code` is write-only and spent during create; a code the
  //            recorder REFUSES fails the create rather than registering an untrusted
  //            node that would 401 on every later call.
  //   PATCH  /vms/media-nodes/{id} — any subset incl. status (allow "draining").
  //   DELETE /vms/media-nodes/{id} — 409/400 with an error if cameras still assigned.
  mediaNodes: {
    list: (params: QueryParams = {}) => unwrap(api.get<MediaNodeListResponse>(`/vms/media-nodes${qs(params)}`)),
    get: (id: string) => unwrap(api.get<MediaNodePublic>(`/vms/media-nodes/${id}`)),
    create: (body: MediaNodeCreate) => unwrap(api.post<MediaNodePublic>("/vms/media-nodes", body)),
    update: (id: string, body: MediaNodeUpdate) => unwrap(api.patch<MediaNodePublic>(`/vms/media-nodes/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`/vms/media-nodes/${id}`)),

    // ── Federation trust — per-node credential management ────────────────────
    // A node is enrolled when it holds a federation credential (MediaNodePublic
    // carries `has_credential`). The RAW credential is returned ONCE on enroll and
    // never again — surface it to copy immediately.
    //   GET    /vms/media-nodes/{id}/credentials → { items:[{ id, label, grants[],
    //            created_at, last_used_at, revoked_at }] }
    //   POST   /vms/media-nodes/{id}/enroll → 201 { credential (RAW), id, label, grants[] }
    //   DELETE /vms/media-nodes/{id}/credentials/{credId} → 204
    // Two bootstraps, for two deployments. `enroll` signs its call with the shared
    // VE_JWT_SECRET, so only a recorder brought up as part of THIS stack answers it —
    // an independently deployed box has its own secret and 401s. For that one an
    // operator mints a one-use code on the recorder's console and `pair` trades it.
    // Same 201 body either way: { credential (RAW), id, label, grants[] }.
    //   POST /vms/media-nodes/{id}/pair { code } → 201
    credentials: (id: string) =>
      unwrap(api.get<ItemList<NodeCredentialPublic>>(`/vms/media-nodes/${id}/credentials`)),
    enroll: (id: string) => unwrap(api.post<NodeEnrollResult>(`/vms/media-nodes/${id}/enroll`, {})),
    pair: (id: string, code: string) => unwrap(api.post<NodeEnrollResult>(`/vms/media-nodes/${id}/pair`, { code })),
    revokeCredential: (id: string, credId: string) =>
      unwrap(api.delete<void>(`/vms/media-nodes/${id}/credentials/${credId}`)),
  },

  // Camera groups — a named set of cameras shown in a grid `layout`
  // ("1x1|2x2|3x3|4x3|4x4|6x4|6x5|6x6|8x8"). Groups are the unit a Pattern
  // rotates through on the video wall. Public shape: { id, name, description,
  // camera_ids[], layout, is_active, color }.
  groups: {
    list: (params: QueryParams = {}) => unwrap(api.get<CameraGroupListResponse>(`${GROUPS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<CameraGroupPublic>(`${GROUPS}/${id}`)),
    create: (body: CameraGroupCreate) => unwrap(api.post<CameraGroupPublic>(GROUPS, body)),
    update: (id: string, body: CameraGroupUpdate) => unwrap(api.patch<CameraGroupPublic>(`${GROUPS}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${GROUPS}/${id}`)),
  },

  // Patterns — a named ROTATING sequence of camera groups. On the wall a pattern
  // cycles through its groups every `seconds` (dwell), each group filling the
  // wall with its cameras in its layout. Public shape: { id, name, description,
  // camera_group_ids[], seconds, is_active }.
  patterns: {
    // GET /patterns?is_active= → { items, total } (or bare array).
    list: (params: QueryParams = {}) =>
      unwrap(api.get<PatternListResponse>(`${PATTERNS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<PatternPublic>(`${PATTERNS}/${id}`)),
    create: (body: PatternCreate) => unwrap(api.post<PatternPublic>(PATTERNS, body)),
    update: (id: string, body: PatternUpdate) => unwrap(api.patch<PatternPublic>(`${PATTERNS}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${PATTERNS}/${id}`)),
  },



  // ── Camera device-events (P5-A) — the normalized event feed ─────────────
  // ONVIF/brand device notifications (motion|tamper|video_loss|io_input|
  // line_crossing|zone_intrusion|audio|…) + system events (camera_online/offline,
  // recording_error, storage_low), normalized + deduped. Live updates arrive over
  // the core realtime SSE bridge (useVmsEventStream); this is the INITIAL history +
  // the ack action. Public shape: { id, camera_id, event_type, severity, source,
  // title, description, raw, occurred_at, acknowledged, acknowledged_by/_at,
  // snapshot_path, recording_id, created_at }.
  events: {
    // GET /vms/events?camera_id=&event_type=&severity=&acknowledged=&from=&to=&skip=&limit=
    //   → { items, total, skip, limit } (newest first).
    list: (params: QueryParams = {}) => unwrap(api.get<VmsEventListResponse>(`${EVENTS}${qs(params)}`)),
    // GET /vms/cameras/{id}/events?… → one camera's events.
    listForCamera: (cameraId: string, params: QueryParams = {}) =>
      unwrap(api.get<VmsEventListResponse>(`${CAMERAS}/${cameraId}/events${qs(params)}`)),
    // POST /vms/events/{id}/ack → the acknowledged VmsEventPublic (idempotent).
    ack: (id: string) => unwrap(api.post<VmsEventPublic>(`${EVENTS}/${id}/ack`, {})),
  },

  // ── Linkage / action rules (P5-B) — event → action automation ───────────
  // A rule fires actions when a matching camera event arrives: start_recording
  // (event-clip w/ pre/post buffer), notify (channel), ptz_preset, trigger_output
  // (relay), popup (operator UI). Public shape: { id, name, description, is_active,
  // trigger_event_type, trigger_filter{}, camera_scope{scope,camera_ids?,group_ids?},
  // actions[{type,config}], cooldown_seconds, schedule{}, created_by, created_at,
  // updated_at }. Writes gate on vms.config.manage; the fire-audit is read-only.
  linkage: {
    // GET /vms/linkage-rules?trigger_event_type=&is_active=&skip=&limit= → { items, total }.
    list: (params: QueryParams = {}) => unwrap(api.get<LinkageRuleListResponse>(`${LINKAGE}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<LinkageRulePublic>(`${LINKAGE}/${id}`)),
    create: (body: LinkageRuleCreate) => unwrap(api.post<LinkageRulePublic>(LINKAGE, body)),
    update: (id: string, body: LinkageRuleUpdate) => unwrap(api.patch<LinkageRulePublic>(`${LINKAGE}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${LINKAGE}/${id}`)),
    // GET /vms/linkage-fires?rule_id=&camera_id=&skip=&limit= → the fire-audit log.
    fires: (params: QueryParams = {}) => unwrap(api.get<LinkageFireListResponse>(`/vms/linkage-fires${qs(params)}`)),
  },

  // ── Live streaming (P2-D) — PlaybackSession issue / renew / release ──────
  // The Go `nvr` orchestrates MediaMTX; Python `vision` issues sessions. The
  // returned hls_url/webrtc_url are ALREADY gateway-routed and ALREADY carry
  // "?token=" — the player consumes them verbatim (never re-append the token).
  // webrtc_url already ends in "/whep" (the WHEP endpoint), so POST the SDP
  // offer straight to it.
  live: {
    // POST /cameras/{id}/live { profile } → PlaybackSessionPublic
    //   { session_id, camera_id, profile, hls_url, webrtc_url, rtsp_url,
    //     token, expires_at, ready }. `profile` defaults to the low-bandwidth
    //   "sub" stream; the backend falls back to main/onvif when absent.
    start: (cameraId: string, profile: string = "sub") =>
      unwrap(api.post<PlaybackSessionPublic>(`${CAMERAS}/${cameraId}/live`, { profile })),
    // POST /cameras/{id}/live/{session}/renew → fresh token + expiry (call
    //   before expiry to keep long views alive; TTL ~300s). Does NOT re-ensure
    //   the MediaMTX path — playback never drops.
    renew: (cameraId: string, sessionId: string) =>
      unwrap(api.post<PlaybackSessionPublic>(`${CAMERAS}/${cameraId}/live/${sessionId}/renew`, {})),
    // DELETE /live/{session} → release the session (nvr path teardown + row).
    //   Call on unmount so idle MediaMTX paths get reaped.
    release: (sessionId: string) => unwrap(api.delete<void>(`/vms/live/${sessionId}`)),
  },


  // ── Recorded playback (P4-A) — timeline + a RECORDED PlaybackSession ─────
  // The Go `nvr` builds a seekable playback URL from MediaMTX's playback server
  // over a recorded window; `vision` mints a media token and returns a session.
  // hls_url ALREADY carries "?token=" — the player consumes it verbatim.
  // Seeking to a new timestamp = requesting a NEW session at that `from`.
  // NO `playback` BLOCK — and that absence is the architecture.
  //
  // `POST /cameras/{id}/playback`, `/timeline` and `/recording-days` answer about
  // footage in THIS platform's own pooled storage. It stores none: the recorder
  // owns every camera, writes every frame and keeps every disk, which is why the
  // recording, retention, tiering and RAID data-plane was removed from this
  // service. Playback asks the owning recorder through the federation routes
  // above, and a client method pointing at the old surface would be an invitation
  // to add a second answer about the same footage.



  // ── Operational reports (P6-B) — uptime / coverage / storage / events ────
  // Each report is computed over a [from, to] window (ISO). `kind` ∈
  //   camera-uptime | recording-coverage | storage-usage | event-stats |
  //   health-summary. JSON shape: { kind, window{from,to,seconds}, rows[],
  //   totals{}, by_type?, by_severity?, status_counts? }. Reads gate on
  //   vms.playback.view; schedule writes on vms.config.manage.
  // NO `reports` BLOCK. The VMS's own report console — uptime, coverage, storage,
  // event counts, plus a scheduler that mailed them — is retired: reporting is
  // DashForge's, surfaced through the dashboards registered under Configurations →
  // Dashboards. Two reporting surfaces means two definitions of the same number,
  // and the one nobody maintains is the one an operator quotes.


  // ── Bookmarks (G3) — mark moments / ranges on a camera timeline ──────────
  // An operator flags an instant (point) or a span (range) in recorded footage
  // with a title + optional note + tags. Rendered as clickable markers on the
  // playback ScrubBar and listed in a side panel. Both reads and writes gate on
  // vms.playback.view — a bookmark is part of the investigation surface. Public
  // shape: { id, camera_id, start_ts, end_ts?, title, note?, tags[], created_by,
  // created_at, updated_at }. end_ts null = a point bookmark.
  bookmarks: {
    // GET /vms/bookmarks?camera_id=&from=&to=&skip=&limit= → { items, total }.
    list: (params: QueryParams = {}) => unwrap(api.get<BookmarkListResponse>(`${BOOKMARKS}${qs(params)}`)),
    // POST /vms/bookmarks { camera_id, start_ts, end_ts?, title, note?, tags? }.
    create: (body: BookmarkCreate) => unwrap(api.post<BookmarkPublic>(BOOKMARKS, body)),
    // PATCH /vms/bookmarks/{id} { start_ts?, end_ts?, title?, note?, tags? }.
    update: (id: string, body: BookmarkUpdate) => unwrap(api.patch<BookmarkPublic>(`${BOOKMARKS}/${id}`, body)),
    // DELETE /vms/bookmarks/{id} → 204.
    remove: (id: string) => unwrap(api.delete<void>(`${BOOKMARKS}/${id}`)),
  },

  // ── Evidence lock / legal hold (G3) — protect a camera+range from deletion
  // An active lock keeps EVERY recording overlapping [start_ts,end_ts] safe from
  // the retention/tiering worker until released. Rendered as a shaded band on the
  // playback timeline and a "Protected" badge on recordings. Writes (create/
  // release/delete) gate on vms.recording.control; reads (list/check) on
  // vms.playback.view. Public shape: { id, camera_id, start_ts, end_ts, reason?,
  // case_ref?, is_active, created_by, created_at, released_by?, released_at? }.
  evidence: {
    // GET /vms/evidence?camera_id=&active_only=&skip=&limit= → { items, total }.
    list: (params: QueryParams = {}) => unwrap(api.get<EvidenceLockListResponse>(`${EVIDENCE}${qs(params)}`)),
    // POST /vms/evidence { camera_id, start_ts, end_ts, reason?, case_ref? }.
    create: (body: EvidenceLockCreate) => unwrap(api.post<EvidenceLockPublic>(EVIDENCE, body)),
    // POST /vms/evidence/{id}/release → the released lock (is_active:false).
    release: (id: string) => unwrap(api.post<EvidenceLockPublic>(`${EVIDENCE}/${id}/release`, {})),
    // DELETE /vms/evidence/{id} → 204 (hard delete; prefer release for the trail).
    remove: (id: string) => unwrap(api.delete<void>(`${EVIDENCE}/${id}`)),
    // GET /vms/evidence/check?camera_id=&ts= (or &from=&to=) → { camera_id, locked }.
    check: (params: QueryParams = {}) => unwrap(api.get<EvidenceCheckResult>(`${EVIDENCE}/check${qs(params)}`)),
  },





};

export default vms;
