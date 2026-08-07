"use client";

// FederatedCameraDetail — the READ-ONLY detail pane for a recorder-owned
// (federated) camera in the unified Devices → Cameras inventory. A federated
// camera is NODE-AUTHORITATIVE: the NVR that owns it holds its config, recording
// and maintenance. The VMS pulls it up + streams it THROUGH the node, so here we
// only ever show a live view + read-only facts + a clear "managed by its recorder"
// note. We NEVER render the config/maintenance editor (CameraDetailView) or invent
// config data we don't own.
//
// The live view reuses LivePlayer's whole WHEP-first / h264-transcode / HLS engine
// via a custom `source` that mints/renews a node-issued token off /vms/federation
// (same seam WallTile uses for wall tiles).
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import LivePlayer from "./LivePlayer";
import PtzOverlay from "./PtzOverlay";
import StatusBadge from "./StatusBadge";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { vms } from "../api";
import { isPtzCapable } from "../formUtils";

export default function FederatedCameraDetail({ camera }) {
  const { can } = useAuth();
  const [snapping, setSnapping] = useState(false);
  const ptzCapable = isPtzCapable(camera);

  // Node-issued live session (mint/renew through the owning recorder). Stable per
  // (node, real id) so the player doesn't re-attach on every parent render.
  const source = useMemo(() => {
    const mint = async (profile) => {
      const s = await vms.federation.live(camera.node_id, camera.real_id, profile);
      return { ...s, ready: true };
    };
    return {
      start: (_camId, profile) => mint(profile),
      renew: () => mint("sub"),
      release: async () => {},
    };
  }, [camera.node_id, camera.real_id]);

  // Snapshot THROUGH the node — one of the only two mutations allowed on a node-
  // owned camera (the other is PTZ below). The endpoint is JWT-authed, so fetch it
  // as an authed blob (same pattern as cameras.snapshotUrl) rather than a bare <a>.
  const snapshot = async () => {
    setSnapping(true);
    try {
      const blob = await api
        .get(vms.federation.snapshotUrl(camera.node_id, camera.real_id), { responseType: "blob" })
        .then((r) => r.data);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${camera.name || camera.real_id || "snapshot"}-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Snapshot failed"));
    } finally {
      setSnapping(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — name · via-recorder · status. No snapshot/delete/save: this
          camera is owned by its recorder, not editable from the VMS. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-nb-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-nb-line bg-[rgba(96,165,250,.08)] text-nb-blueb">
            <Icon icon="heroicons-outline:video-camera" className="text-sm" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-nb-ink">{camera.name}</h2>
            <p className="flex items-center gap-1 truncate font-mono text-[10px] text-nb-faint">
              <Icon icon="heroicons:cpu-chip" className="shrink-0 text-[10px]" />
              via {camera.node_name || "recorder"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Snapshot through the node — an operate-through-node action, not config. */}
          <button
            type="button"
            onClick={snapshot}
            disabled={snapping}
            title="Grab a still through the recorder"
            className="inline-flex items-center gap-1 rounded-md border border-nb-line bg-nb-surface px-2 py-1 text-[11px] font-medium text-nb-soft transition hover:border-nb-blueb hover:text-nb-ink disabled:opacity-50"
          >
            <Icon icon={snapping ? "heroicons-outline:arrow-path" : "heroicons-outline:camera"} className={`text-xs ${snapping ? "animate-spin" : ""}`} />
            Snapshot
          </button>
          <span
            title="This camera is owned by its recorder — read-only here"
            className="inline-flex items-center gap-1 rounded-full border border-[rgba(96,165,250,.3)] bg-[rgba(96,165,250,.08)] px-2 py-0.5 text-[10px] font-medium text-nb-blueb"
          >
            <Icon icon="heroicons-outline:lock-closed" className="text-xs" />
            Read-only
          </span>
          <StatusBadge status={camera.status} />
        </div>
      </div>

      {/* Body — managed-by banner + live view + read-only facts. */}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <div className="mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-[rgba(96,165,250,.25)] bg-[rgba(96,165,250,.06)] px-3 py-2 text-[11px] leading-relaxed text-nb-soft">
          <Icon icon="heroicons-outline:information-circle" className="mt-px shrink-0 text-sm text-nb-blueb" />
          <span>
            Managed by <span className="font-semibold text-nb-ink">{camera.node_name || "its recorder"}</span>. Configuration,
            recording and device maintenance are controlled on the recorder (NVR). This VMS view is live + read-only —
            plot it on a floor plan or view it on the wall like any other camera.
          </span>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-nb-line bg-black">
          <LivePlayer
            key={camera.id}
            cameraId={camera.real_id}
            cameraName={camera.name}
            source={source}
            canTalk={false}
            talkCapable={false}
            className="h-full"
          />

          {/* PTZ control THROUGH the node — the second (and last) mutation allowed
              on a node-owned camera. Only when the recorder reports a PTZ head.
              Commands proxy via vms.federation.ptz; presets/patrols stay on the NVR. */}
          {ptzCapable && (
            <div className="absolute bottom-3 left-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))]">
              <PtzOverlay
                cameraId={camera.real_id}
                canControl={can("vms.ptz.control")}
                fedNodeId={camera.node_id}
                fedRealId={camera.real_id}
              />
            </div>
          )}
        </div>

        {/* Read-only facts we actually own (no fabricated config). */}
        <dl className="mt-3 grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
          <Fact label="Source recorder" value={camera.node_name || "—"} />
          <Fact label="Status" value={<StatusBadge status={camera.status} />} />
          <Fact label="Ownership" value="Node-authoritative" />
        </dl>
      </div>
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-[9px] font-semibold uppercase tracking-[1.2px] text-nb-faint">{label}</dt>
      <dd className="truncate text-nb-ink">{value}</dd>
    </div>
  );
}
