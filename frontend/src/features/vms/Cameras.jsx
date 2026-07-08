"use client";

// VMS → Cameras. The operator-facing camera estate: table/grid toggle, status +
// brand + site filters, search, onboard (manual + ONVIF discovery bulk-add), bulk
// actions, drag-reorder, per-row snapshot/edit/delete. Ported from gvd_nvr's
// Cameras page UX, rethemed to v3's dark tokens + the shared kit/common layer.
//
// Live video / playback are P2 — tiles show a snapshot placeholder, not a player.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader, Select } from "@/components/ui/kit";
import { StatsStrip } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { vms } from "./api";
import { BRAND_FILTERS, STATUS_FILTERS } from "./constants";
import CameraTable from "./components/CameraTable";
import CameraGrid from "./components/CameraGrid";
import BulkActionBar from "./components/BulkActionBar";
import OnboardCameraModal from "./components/OnboardCameraModal";
import EditCameraModal from "./components/EditCameraModal";
import OnvifDiscoveryModal from "./components/OnvifDiscoveryModal";
import SnapshotModal from "./components/SnapshotModal";

export default function CamerasPage() {
  const qc = useQueryClient();
  const [view, setView] = useState("table"); // table | grid
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [brand, setBrand] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());

  const [onboardOpen, setOnboardOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [snapTarget, setSnapTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // ── Data ─────────────────────────────────────────────────────────────
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", { status, brand, siteFilter, search }],
    queryFn: () =>
      vms.cameras.list({ status, brand, site_id: siteFilter, q: search, limit: 500 }),
    refetchInterval: 20_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  const healthQ = useQuery({
    queryKey: ["vms-health"],
    queryFn: () => vms.health.latest(),
    refetchInterval: 30_000,
  });
  const healthById = useMemo(() => {
    const m = {};
    for (const h of asItems(healthQ.data)) m[h.camera_id] = h;
    return m;
  }, [healthQ.data]);

  const groupsQ = useQuery({ queryKey: ["vms-groups"], queryFn: () => vms.groups.list(), staleTime: 60_000 });
  const groups = asItems(groupsQ.data);

  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }), staleTime: 60_000 });
  const sites = asItems(sitesQ.data);
  const floorsQ = useQuery({ queryKey: ["floors-list"], queryFn: () => sitesApi.floors.list({ limit: 500 }), staleTime: 60_000 });
  const floors = asItems(floorsQ.data);
  const zonesQ = useQuery({ queryKey: ["zones-list"], queryFn: () => sitesApi.zones.list({ limit: 500 }), staleTime: 60_000 });
  const zones = asItems(zonesQ.data);

  const siteNames = useMemo(() => {
    const m = {};
    for (const s of sites) m[s.site_id] = s.name;
    return m;
  }, [sites]);

  // ── Derived ──────────────────────────────────────────────────────────
  const statusCounts = useMemo(() => {
    const c = { "": cameras.length, online: 0, offline: 0, connecting: 0, error: 0 };
    for (const cam of cameras) if (c[cam.status] != null) c[cam.status] += 1;
    return c;
  }, [cameras]);

  const stats = STATUS_FILTERS.map((s) => ({ key: s.key, label: s.label, color: s.color, count: statusCounts[s.key] ?? 0 }));

  // ── Mutations ────────────────────────────────────────────────────────
  const invalidate = () => qc.invalidateQueries({ queryKey: ["vms-cameras"] });

  const remove = useMutation({
    mutationFn: (id) => vms.cameras.remove(id),
    onSuccess: () => { toast.success("Camera removed"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const bulk = useMutation({
    mutationFn: ({ action, group_id, retention_days }) =>
      vms.cameras.bulk({ camera_ids: Array.from(selectedIds), action, group_id, retention_days }),
    onSuccess: (_d, vars) => {
      toast.success(`Bulk ${vars.action} applied`);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Bulk action failed")),
  });

  const reorder = useMutation({
    mutationFn: (ids) => vms.cameras.reorder(ids.map((id, i) => ({ id, display_order: i }))),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(apiError(e, "Reorder failed")),
  });

  // ── Selection helpers ────────────────────────────────────────────────
  const toggleSelect = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAll = (checked) =>
    setSelectedIds(checked ? new Set(cameras.map((c) => c.id)) : new Set());

  const askDelete = (cam) =>
    setConfirm({
      title: "Delete camera",
      message: `Remove ${cam.name}? Recordings are retained per policy. This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => { remove.mutate(cam.id); setConfirm(null); },
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

  const viewToggle = (
    <div className="inline-flex overflow-hidden rounded-md border border-card-border">
      {[
        { k: "table", icon: "heroicons-outline:table-cells" },
        { k: "grid", icon: "heroicons-outline:squares-2x2" },
      ].map((v) => (
        <button
          key={v.k}
          type="button"
          onClick={() => setView(v.k)}
          className={`px-2.5 py-2 text-sm transition ${view === v.k ? "bg-foreground text-background" : "text-muted hover:bg-hover"}`}
        >
          <Icon icon={v.icon} className="text-base" />
        </button>
      ))}
    </div>
  );

  return (
    <div className="pb-8">
      <PageHeader
        title="Cameras"
        subtitle="Onboard, configure and monitor IP cameras across the estate."
        actions={
          <div className="flex items-center gap-2">
            {viewToggle}
            <Button variant="secondary" icon="heroicons-outline:magnifying-glass" onClick={() => setDiscoverOpen(true)}>
              ONVIF discovery
            </Button>
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setOnboardOpen(true)}>
              Add camera
            </Button>
          </div>
        }
      />

      <StatsStrip stats={stats} active={status} onSelect={setStatus} className="mb-4" />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative block w-64 max-w-full">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or IP…"
            className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </label>
        <Select value={brand} onChange={(e) => setBrand(e.target.value)} options={BRAND_FILTERS} className="!h-9 !py-1.5 w-40" />
        <Select
          value={siteFilter}
          onChange={(e) => setSiteFilter(e.target.value)}
          options={[{ value: "", label: "All sites" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
          className="!h-9 !py-1.5 w-44"
        />
        <button
          onClick={() => { invalidate(); healthQ.refetch(); }}
          title="Refresh"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-card-border text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-base" />
        </button>
      </div>

      {/* Body */}
      {camerasQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-20 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading cameras…
        </div>
      ) : camerasQ.isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
          {apiError(camerasQ.error, "Failed to load cameras")}
        </div>
      ) : cameras.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-20 text-center">
          <Icon icon="heroicons-outline:video-camera" className="mb-3 text-4xl text-muted opacity-50" />
          <p className="font-medium text-foreground">No cameras yet</p>
          <p className="mt-1 text-sm text-muted">Add one manually or run an ONVIF discovery scan.</p>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" icon="heroicons-outline:magnifying-glass" onClick={() => setDiscoverOpen(true)}>Discover</Button>
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setOnboardOpen(true)}>Add camera</Button>
          </div>
        </div>
      ) : view === "table" ? (
        <CameraTable
          cameras={cameras}
          healthById={healthById}
          siteNames={siteNames}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAll}
          onOpen={(c) => setEditTarget(c)}
          onSnapshot={(c) => setSnapTarget(c)}
          onEdit={(c) => setEditTarget(c)}
          onDelete={askDelete}
          onReorder={(ids) => reorder.mutate(ids)}
        />
      ) : (
        <CameraGrid
          cameras={cameras}
          healthById={healthById}
          siteNames={siteNames}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onOpen={(c) => setSnapTarget(c)}
          onSnapshot={(c) => setSnapTarget(c)}
          onEdit={(c) => setEditTarget(c)}
          onDelete={askDelete}
        />
      )}

      <BulkActionBar
        count={selectedIds.size}
        groups={groups}
        onAction={runBulk}
        onClear={() => setSelectedIds(new Set())}
        pending={bulk.isPending}
      />

      {/* Modals */}
      {onboardOpen && (
        <OnboardCameraModal
          sites={sites}
          floors={floors}
          zones={zones}
          onClose={() => setOnboardOpen(false)}
          onSuccess={() => { setOnboardOpen(false); invalidate(); }}
        />
      )}
      {discoverOpen && (
        <OnvifDiscoveryModal
          sites={sites}
          onClose={() => setDiscoverOpen(false)}
          onSuccess={() => { setDiscoverOpen(false); invalidate(); }}
        />
      )}
      {editTarget && (
        <EditCameraModal
          camera={editTarget}
          sites={sites}
          floors={floors}
          zones={zones}
          onClose={() => setEditTarget(null)}
          onSuccess={() => { setEditTarget(null); invalidate(); }}
        />
      )}
      {snapTarget && <SnapshotModal camera={snapTarget} onClose={() => setSnapTarget(null)} />}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending || bulk.isPending} />
    </div>
  );
}
