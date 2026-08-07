"use client";

// VMS → Cameras. neubit_v2-parity two-card master/detail: a left list of cameras
// (search + filters + bulk-select) and a right INLINE detail pane (CameraDetailView
// — live view, config edit, maintenance) — NO edit modal. Onboarding + ONVIF
// discovery stay modal (add-only). Consistent with the NVR + Access Control pages.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Select } from "@/components/ui/kit";
import { EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, titleize } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { sites as sitesApi } from "@/lib/api/sites";
import { vms } from "./api";
import { BRAND_FILTERS, STATUS_FILTERS } from "./constants";
import { StatusDot } from "./components/StatusBadge";
import CameraDetailView from "./components/CameraDetailView";
import FederatedCameraDetail from "./components/FederatedCameraDetail";
import BulkActionBar from "./components/BulkActionBar";
import OnboardCameraModal from "./components/OnboardCameraModal";
import BulkDeviceResultModal from "./components/BulkDeviceResultModal";
import OnvifDiscoveryModal from "./components/OnvifDiscoveryModal";
import SnapshotModal from "./components/SnapshotModal";

const cameraIp = (c) => c.network_info?.ip || c.onvif?.host || "—";

export default function CamerasPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManageDevices = can("vms.config.manage");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [brand, setBrand] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set()); // bulk selection
  const [selectedId, setSelectedId] = useState(null); // detail (single) selection

  const [onboardOpen, setOnboardOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [snapTarget, setSnapTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deviceResult, setDeviceResult] = useState(null); // bulk device-op result summary

  // ── Data ─────────────────────────────────────────────────────────────
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", { status, brand, siteFilter, search }],
    queryFn: () =>
      vms.cameras.list({ status, brand, site_id: siteFilter, q: search, limit: 500 }),
    refetchInterval: 20_000,
  });
  const localCameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  // Federated (recorder-owned) cameras — cameras OWNED by registered NVR nodes
  // (our own standalone recorder + 3rd-party NVRs surfaced through federation),
  // pulled up READ-ONLY and streamed THROUGH each node. They are NOT local Camera
  // rows — never edited/deleted/configured from here — but they belong in the one
  // Devices inventory so every camera is discoverable + floor-plan-plottable.
  const fedQ = useQuery({
    queryKey: ["vms-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });

  // Map federated items to a display shape consistent with local cameras, tagged
  // `federated`. The composite id (`fed:<node>:<cam>`) matches the floor-builder
  // inventory + the video wall, so a camera plotted here keys the same everywhere.
  // The local list is already server-filtered (status/brand/site/q); brand + site
  // don't apply to node-owned cameras, so when either is set we drop federated
  // (the local-only result is authoritative) and otherwise filter them client-side
  // by status + search so the two lists behave as one.
  const fedCameras = useMemo(() => {
    if (brand || siteFilter) return [];
    const q = search.trim().toLowerCase();
    return (fedQ.data?.items || [])
      .map((c) => ({
        id: `fed:${c.node_id}:${c.id}`,
        real_id: c.id,
        name: c.name,
        status: c.status,
        federated: true,
        node_id: c.node_id,
        node_name: c.node_name,
        source_label: c.node_name,
      }))
      .filter((c) => (status ? c.status === status : true))
      .filter((c) =>
        q ? c.name?.toLowerCase().includes(q) || (c.node_name || "").toLowerCase().includes(q) : true,
      );
  }, [fedQ.data, brand, siteFilter, status, search]);

  // The one unified inventory: local first, then read-through recorder cameras.
  const cameras = useMemo(() => [...localCameras, ...fedCameras], [localCameras, fedCameras]);

  const healthQ = useQuery({
    queryKey: ["vms-health"],
    queryFn: () => vms.health.latest(),
    refetchInterval: 30_000,
  });

  // Which cameras are ACTUALLY recording right now (live nvr state) — polled so the
  // ● Recording indicator reflects reality, not just the configured mode.
  const recActiveQ = useQuery({
    queryKey: ["vms-recording-active"],
    queryFn: () => vms.recordingConfig.active(),
    refetchInterval: 15_000,
  });
  const recordingIds = useMemo(
    () => new Set(recActiveQ.data?.available ? recActiveQ.data.camera_ids || [] : []),
    [recActiveQ.data],
  );

  const groupsQ = useQuery({ queryKey: ["vms-groups"], queryFn: () => vms.groups.list(), staleTime: 60_000 });
  const groups = asItems(groupsQ.data);

  // Media nodes (recorders) — for the per-camera "Recorder" label + the bulk
  // "Assign to recorder" dropdown. Unassigned cameras (media_node_id null) → "Auto".
  const nodesQ = useQuery({ queryKey: ["vms-media-nodes"], queryFn: () => vms.mediaNodes.list({ limit: 500 }), staleTime: 60_000 });
  const nodes = asItems(nodesQ.data);
  const nodeNames = useMemo(() => {
    const m = {};
    for (const n of nodes) m[n.id] = n.name;
    return m;
  }, [nodes]);

  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }), staleTime: 60_000 });
  const sites = asItems(sitesQ.data);

  const siteNames = useMemo(() => {
    const m = {};
    for (const s of sites) m[s.site_id] = s.name;
    return m;
  }, [sites]);

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

  // ── Mutations ────────────────────────────────────────────────────────
  const invalidate = () => qc.invalidateQueries({ queryKey: ["vms-cameras"] });

  const remove = useMutation({
    mutationFn: (id) => vms.cameras.remove(id),
    onSuccess: () => { toast.success("Camera removed"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const bulk = useMutation({
    // media_node_id is intentionally passed through even when null — that's how the
    // "Unassign (Auto)" option clears the pin. The other actions ignore it.
    mutationFn: ({ action, group_id, retention_days, media_node_id }) => {
      const body = { camera_ids: Array.from(selectedIds), action, group_id, retention_days };
      if (action === "assign_node") body.media_node_id = media_node_id ?? null;
      return vms.cameras.bulk(body);
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.action === "assign_node" ? "Recorder assigned" : `Bulk ${vars.action} applied`);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Bulk action failed")),
  });

  // ── Bulk device fleet ops (G7) — reboot / ntp / password across selection ──
  const bulkDevice = useMutation({
    mutationFn: ({ action, server, user, new_password }) => {
      const ids = Array.from(selectedIds);
      if (action === "reboot") return vms.deviceMgmt.bulk.reboot(ids);
      if (action === "ntp") return vms.deviceMgmt.bulk.ntp(ids, server);
      if (action === "password") return vms.deviceMgmt.bulk.password(ids, { user, new_password });
      if (action === "apply-stream-policy") return vms.deviceMgmt.bulk.applyStreamPolicy(ids);
      return Promise.reject(new Error("Unknown device action"));
    },
    onSuccess: (res) => {
      setDeviceResult(res);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Bulk device action failed")),
  });

  const runBulkDevice = (payload) => {
    if (payload.action === "reboot") {
      setConfirm({
        title: "Reboot cameras",
        message: `Reboot ${selectedIds.size} selected camera(s)? Each will be offline for ~30–60s.`,
        confirmLabel: "Reboot",
        onConfirm: () => { bulkDevice.mutate(payload); setConfirm(null); },
      });
    } else if (payload.action === "password") {
      setConfirm({
        title: "Change device passwords",
        message: `Change the ${payload.user || "current"} account password on ${selectedIds.size} camera(s)? Ensure the stored ONVIF credentials still match afterwards, or cameras may go unreachable.`,
        confirmLabel: "Change password",
        danger: false,
        onConfirm: () => { bulkDevice.mutate(payload); setConfirm(null); },
      });
    } else {
      bulkDevice.mutate(payload);
    }
  };

  // ── Selection helpers ────────────────────────────────────────────────
  // Bulk selection is LOCAL-only — federated cameras never carry a checkbox, but
  // guard here too so a stray composite id can never enter a bulk op payload.
  const toggleSelect = (id) => {
    if (typeof id === "string" && id.startsWith("fed:")) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const askDelete = (cam) =>
    setConfirm({
      title: "Delete camera",
      message: `Remove ${cam.name}? Recordings are retained per policy. This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        remove.mutate(cam.id);
        if (selectedId === cam.id) setSelectedId(null);
        setConfirm(null);
      },
    });

  const runBulk = (payload) => {
    if (payload.action === "delete") {
      setConfirm({
        title: "Delete cameras",
        message: `Remove ${selectedIds.size} selected camera(s)? This cannot be undone.`,
        confirmLabel: "Delete",
        onConfirm: () => { bulk.mutate(payload); setConfirm(null); },
      });
    } else {
      bulk.mutate(payload);
    }
  };

  const fieldCls =
    "h-8 w-full rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 text-[13px] text-nb-ink placeholder:text-nb-faint outline-none focus:border-nb-blue";

  return (
    <div
      className="flex h-[calc(100%+1.5rem)] min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 pt-3 pb-2 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* Two-card master/detail — fills the whole body (list actions live in the
          aside header, so no toolbar row eats vertical space). */}
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
                onClick={() => { invalidate(); healthQ.refetch(); fedQ.refetch(); }}
                title="Refresh"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
              <button
                onClick={() => setDiscoverOpen(true)}
                title="ONVIF discovery"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-outline:magnifying-glass" className="text-sm" />
              </button>
              <button
                onClick={() => setOnboardOpen(true)}
                title="Add camera"
                className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)]"
              >
                <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
              </button>
            </div>
          </header>

          {/* Filters + status counts */}
          <div className="shrink-0 space-y-1.5 px-2 pb-2 pt-2">
            <label className="relative block">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nb-faint" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or IP…" className={`${fieldCls} pl-8`} />
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTERS.map((s) => ({ value: s.key, label: s.key === "" ? "All statuses" : s.label }))} className="!h-8 !py-1" />
              <Select value={brand} onChange={(e) => setBrand(e.target.value)} options={BRAND_FILTERS} className="!h-8 !py-1" />
            </div>
            <Select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} options={[{ value: "", label: "All sites" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]} className="!h-8 !py-1" />
            <div className="flex items-center gap-3 px-0.5 pt-0.5 text-[11px]">
              <span className="flex items-center gap-1 text-nb-soft"><span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />{statusCounts.online} online</span>
              <span className="flex items-center gap-1 text-nb-soft"><span className="h-1.5 w-1.5 rounded-full bg-nb-faint" />{statusCounts.offline} offline</span>
            </div>
          </div>

          {/* List */}
          <div className="scroll-themed min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {camerasQ.isLoading && cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-faint">Loading…</div>
            ) : camerasQ.isError && cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-crit">{apiError(camerasQ.error, "Failed to load cameras")}</div>
            ) : cameras.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-nb-faint">
                {search || status || brand || siteFilter ? "No cameras match." : "No cameras yet — click Add camera."}
              </div>
            ) : (
              <div className="space-y-0.5">
                {cameras.map((c) => (
                  <CameraListItem
                    key={c.id}
                    camera={c}
                    siteName={siteNames[c.placement?.site_id]}
                    nodeName={c.media_node_id ? nodeNames[c.media_node_id] : null}
                    recording={recordingIds.has(c.id)}
                    selected={c.id === selectedId}
                    bulkChecked={selectedIds.has(c.id)}
                    onSelect={() => setSelectedId(c.id)}
                    onToggleBulk={() => toggleSelect(c.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ── Right: inline detail ── */}
        {selected ? (
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)]">
            {selected.federated ? (
              // Recorder-owned camera → live view + read-only facts. NO config /
              // maintenance / delete editor (the NVR owns it).
              <FederatedCameraDetail key={selected.id} camera={selected} />
            ) : (
              <CameraDetailView
                key={selected.id}
                camera={selected}
                sites={sites}
                recording={recordingIds.has(selected.id)}
                onUpdated={invalidate}
                onDelete={askDelete}
                onSnapshot={(c) => setSnapTarget(c)}
              />
            )}
          </section>
        ) : (
          <EmptyDetail
            icon="heroicons-outline:video-camera"
            title="No camera selected"
            subtitle="Choose a camera to view its details, streams and health."
          />
        )}
      </div>

      {/* Bulk-action bar (floats when cameras are selected) */}
      <BulkActionBar
        count={selectedIds.size}
        groups={groups}
        nodes={nodes}
        onAction={runBulk}
        onDeviceAction={runBulkDevice}
        canManageDevices={canManageDevices}
        onClear={() => setSelectedIds(new Set())}
        pending={bulk.isPending || bulkDevice.isPending}
      />

      {/* Modals (add-only + snapshot + bulk result) */}
      {onboardOpen && (
        <OnboardCameraModal
          sites={sites}
          onClose={() => setOnboardOpen(false)}
          onSuccess={(created) => { setOnboardOpen(false); invalidate(); if (created?.id) setSelectedId(created.id); }}
        />
      )}
      {discoverOpen && (
        <OnvifDiscoveryModal
          sites={sites}
          onClose={() => setDiscoverOpen(false)}
          onSuccess={() => { setDiscoverOpen(false); invalidate(); }}
        />
      )}
      {snapTarget && <SnapshotModal camera={snapTarget} onClose={() => setSnapTarget(null)} />}
      {deviceResult && <BulkDeviceResultModal result={deviceResult} onClose={() => setDeviceResult(null)} />}

      <ConfirmDialog
        state={confirm}
        onClose={() => setConfirm(null)}
        pending={remove.isPending || bulk.isPending || bulkDevice.isPending}
      />
    </div>
  );
}

// Compact camera row for the left list — status dot + name + codec badge + a
// meta line (ip · brand · site). Bulk-checkbox on the left; the row selects for
// the detail pane. Selected row gets an accent border + hover fill.
//
// Federated (recorder-owned) rows are READ-THROUGH: no bulk checkbox (they can't
// participate in local bulk ops), no editable recorder line — instead they carry a
// "via <node>" source pill so the operator sees at a glance which recorder owns
// them. The row still selects for the (read-only) detail pane.
function CameraListItem({ camera, siteName, nodeName, recording, selected, bulkChecked, onSelect, onToggleBulk }) {
  const federated = !!camera.federated;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className={`flex cursor-pointer items-center gap-2 rounded-[10px] border px-2 py-1.5 transition ${
        selected
          ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
          : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
      }`}
    >
      {federated ? (
        // No bulk-select for node-owned cameras — a recorder glyph holds the slot
        // so rows stay aligned with the local (checkbox) rows.
        <span
          title={`Managed by ${camera.node_name || "recorder"}`}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-nb-faint"
        >
          <Icon icon="heroicons:cpu-chip" className="text-[11px]" />
        </span>
      ) : (
        <input
          type="checkbox"
          checked={bulkChecked}
          onChange={onToggleBulk}
          onClick={(e) => e.stopPropagation()}
          className="accent-nb-blue"
          aria-label={`Select ${camera.name}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-nb-ink">
          <StatusDot status={camera.status} />
          <span className="truncate">{camera.name}</span>
          {federated && (
            <span
              title={`Streamed via ${camera.node_name || "recorder"}`}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[rgba(96,165,250,.3)] bg-[rgba(96,165,250,.08)] px-1.5 py-px text-[9px] font-medium text-nb-blueb"
            >
              <Icon icon="heroicons-mini:link" className="text-[9px]" />
              via {camera.node_name || "recorder"}
            </span>
          )}
        </p>
        <p className="truncate font-mono text-[10px] text-nb-faint">
          {federated
            ? "Recorder camera · read-only"
            : `${cameraIp(camera)}${camera.brand ? ` · ${titleize(camera.brand)}` : ""}${siteName ? ` · ${siteName}` : ""}`}
        </p>
        {/* Recorder (media node) the LOCAL camera is pinned to — "Auto" when
            unassigned. Federated cameras record on their own recorder, so we
            don't show a (meaningless) media-node line for them. */}
        {!federated && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-nb-faint">
            <Icon icon="heroicons:cpu-chip" className="shrink-0 text-[10px]" />
            <span className="truncate">{nodeName || "Auto"}</span>
          </p>
        )}
      </div>
      {recording && !federated && (
        <span
          title="Recording"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.12)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-nb-crit"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nb-crit" /> REC
        </span>
      )}
    </div>
  );
}
