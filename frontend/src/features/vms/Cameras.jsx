"use client";

// VMS → Cameras. A FEDERATED, READ-ONLY camera view. Single-ownership: the
// standalone recorder node owns ALL cameras (direct + 3rd-party NVRs onboarded on
// the recorder edge). The VMS never onboards or manages cameras — it federates
// recorder NODES and surfaces their cameras here, streamed THROUGH each node.
//
// So this page has NO onboarding/management actions (no Add, ONVIF discovery,
// onboard, bulk device ops, snapshot, delete). It is a two-card master/detail:
// a left list of node-owned cameras (search + status filter + counts), tagged with
// their owning recorder, and a right READ-ONLY detail pane (FederatedCameraDetail —
// live view + a note that management happens on the owning recorder).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Select } from "@/components/ui/kit";
import { EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "./api";
import { STATUS_FILTERS } from "./constants";
import { StatusDot } from "./components/StatusBadge";
import FederatedCameraDetail from "./components/FederatedCameraDetail";

export default function CamerasPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState(null); // detail selection

  // ── Data ─────────────────────────────────────────────────────────────
  // Federated (recorder-owned) cameras — cameras OWNED by registered recorder
  // nodes (our own standalone recorder + 3rd-party NVRs surfaced through the node),
  // pulled up READ-ONLY and streamed THROUGH each node. This is the entire Devices →
  // Cameras inventory now: there are no local VMS cameras.
  const fedQ = useQuery({
    queryKey: ["vms-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });

  // Map federated items to a display shape tagged `federated`. The composite id
  // (`fed:<node>:<cam>`) matches the floor-builder inventory + the video wall, so a
  // camera plotted here keys the same everywhere. Filtered client-side by status +
  // search (name or owning node).
  const cameras = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (fedQ.data?.items || [])
      .map((c) => ({
        id: `fed:${c.node_id}:${c.id}`,
        real_id: c.id,
        name: c.name,
        status: c.status,
        federated: true,
        // PTZ capability as the node reported it (public.ptz.capable) — drives the
        // detail pane's PTZ control; commands proxy through the node.
        ptz_capable: !!(c.ptz && c.ptz.capable),
        node_id: c.node_id,
        node_name: c.node_name,
        source_label: c.node_name,
      }))
      .filter((c) => (status ? c.status === status : true))
      .filter((c) =>
        q ? c.name?.toLowerCase().includes(q) || (c.node_name || "").toLowerCase().includes(q) : true,
      );
  }, [fedQ.data, status, search]);

  const statusCounts = useMemo(() => {
    let online = 0;
    for (const c of cameras) if (c.status === "online") online += 1;
    return { online, offline: cameras.length - online, total: cameras.length };
  }, [cameras]);

  // Derived detail selection + auto-select the first camera.
  const selected = cameras.find((c) => c.id === selectedId) || null;
  useEffect(() => {
    if (cameras.length === 0) return;
    if (!selectedId || !cameras.some((c) => c.id === selectedId)) {
      setSelectedId(cameras[0].id);
    }
  }, [cameras, selectedId]);

  const fieldCls =
    "h-8 w-full rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 text-[13px] text-nb-ink placeholder:text-nb-faint outline-none focus:border-nb-blue";

  return (
    <div
      className="flex h-[calc(100%+1.5rem)] min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 pt-3 pb-2 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* Two-card master/detail — fills the whole body. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[24rem_1fr]">
        {/* ── Left: camera list ── */}
        <aside className="flex min-h-0 flex-col rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)]">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-nb-line px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Icon icon="heroicons-outline:video-camera" className="text-sm text-nb-muted" />
              <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Cameras</span>
              <span className="rounded-full border border-nb-line bg-[rgba(10,18,40,.65)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-nb-faint">{statusCounts.total}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => fedQ.refetch()}
                title="Refresh"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            </div>
          </header>

          {/* Federated-view note — management lives on the owning recorder. */}
          <div className="mx-2 mt-2 flex shrink-0 items-start gap-2 rounded-[10px] border border-[rgba(96,165,250,.25)] bg-[rgba(96,165,250,.06)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-nb-soft">
            <Icon icon="heroicons-outline:information-circle" className="mt-px shrink-0 text-xs text-nb-blueb" />
            <span>
              Cameras are owned by their recorder. This is a read-only view — onboarding &amp;
              management happen on the owning recorder.
            </span>
          </div>

          {/* Filters + status counts */}
          <div className="shrink-0 space-y-1.5 px-2 pb-2 pt-2">
            <label className="relative block">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nb-faint" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or recorder…" className={`${fieldCls} pl-8`} />
            </label>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTERS.map((s) => ({ value: s.key, label: s.key === "" ? "All statuses" : s.label }))} className="!h-8 !py-1" />
            <div className="flex items-center gap-3 px-0.5 pt-0.5 text-[11px]">
              <span className="flex items-center gap-1 text-nb-soft"><span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />{statusCounts.online} online</span>
              <span className="flex items-center gap-1 text-nb-soft"><span className="h-1.5 w-1.5 rounded-full bg-nb-faint" />{statusCounts.offline} offline</span>
            </div>
          </div>

          {/* List */}
          <div className="scroll-themed min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {fedQ.isLoading && cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-faint">Loading…</div>
            ) : fedQ.isError && cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-crit">{apiError(fedQ.error, "Failed to load cameras")}</div>
            ) : cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-faint">
                {search || status ? "No cameras match." : "No cameras — register a recorder to surface its cameras."}
              </div>
            ) : (
              <div className="space-y-0.5">
                {cameras.map((c) => (
                  <CameraListItem
                    key={c.id}
                    camera={c}
                    selected={c.id === selectedId}
                    onSelect={() => setSelectedId(c.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ── Right: inline read-only detail ── */}
        {selected ? (
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)]">
            {/* Recorder-owned camera → live view + read-only facts. Management (config,
                recording, maintenance) lives on the owning recorder. */}
            <FederatedCameraDetail key={selected.id} camera={selected} />
          </section>
        ) : (
          <EmptyDetail
            icon="heroicons-outline:video-camera"
            title="No camera selected"
            subtitle="Choose a camera to view its live stream and details."
          />
        )}
      </div>
    </div>
  );
}

// Compact camera row for the left list — status dot + name, with the owning
// recorder as a quiet secondary line (no loud "via …" pill). All rows are
// read-through (node-owned): no bulk checkbox, no editable recorder line.
function CameraListItem({ camera, selected, onSelect }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-2.5 py-2 transition ${
        selected
          ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
          : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
      }`}
    >
      <StatusDot status={camera.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-nb-ink">{camera.name}</p>
        <p className="flex items-center gap-1 truncate text-[10.5px] text-nb-faint">
          <Icon icon="heroicons:server-stack" className="shrink-0 text-[10px]" />
          <span className="truncate">{camera.node_name || "recorder"}</span>
        </p>
      </div>
      <Icon
        icon="heroicons-outline:lock-closed"
        title="Owned by its recorder — read-only here"
        className="shrink-0 text-[11px] text-nb-faint/70"
      />
    </div>
  );
}
