"use client";

// VMS → Cameras. The operator-facing camera estate: a compact action toolbar
// (view toggle + ONVIF discovery + Add camera), a filter bar (search + brand +
// site + status), and a sortable/selectable TanStack DataTable (or grid view),
// with onboard (manual + ONVIF bulk-add), bulk actions, per-row snapshot/edit/
// delete. Rethemed to v3's dark tokens + the shared kit/common layer.
//
// Live video (P2-D): grid tiles + the row "Go live" action open a LivePlayer
// modal (WebRTC + HLS fallback); playback (recorded) is P3/P4.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, EmptyState, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { sites as sitesApi } from "@/lib/api/sites";
import { vms } from "./api";
import { BRAND_FILTERS, STATUS_FILTERS } from "./constants";
import CameraTable from "./components/CameraTable";
import CameraGrid from "./components/CameraGrid";
import BulkActionBar from "./components/BulkActionBar";
import OnboardCameraModal from "./components/OnboardCameraModal";
import EditCameraModal from "./components/EditCameraModal";
import BulkDeviceResultModal from "./components/BulkDeviceResultModal";
import OnvifDiscoveryModal from "./components/OnvifDiscoveryModal";
import SnapshotModal from "./components/SnapshotModal";
import LivePlayerModal from "./components/LivePlayerModal";

export default function CamerasPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManageDevices = can("vms.config.manage");
  const [view, setView] = useState("table"); // table | grid
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [brand, setBrand] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());

  const [onboardOpen, setOnboardOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [editTab, setEditTab] = useState("view"); // initial tab for the edit modal
  const [snapTarget, setSnapTarget] = useState(null);
  const [liveTarget, setLiveTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deviceResult, setDeviceResult] = useState(null); // bulk device-op result summary

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
  // Floors/zones are NOT fetched globally (they cap at 100 + don't scale) — the
  // onboard/edit modals load them cascading per selected site/floor.

  const siteNames = useMemo(() => {
    const m = {};
    for (const s of sites) m[s.site_id] = s.name;
    return m;
  }, [sites]);

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
      setDeviceResult(res); // show the per-camera results summary
      setSelectedIds(new Set());
      invalidate(); // codec badges may have flipped to H.264
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Single toolbar row — filters on the left, actions on the right.
          (No title/subtitle; the "Cameras" sub-tab above already labels the page.) */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2">
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
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={STATUS_FILTERS.map((s) => ({ value: s.key, label: s.key === "" ? "All statuses" : s.label }))}
          className="!h-9 !py-1.5 w-40"
        />
        <button
          onClick={() => { invalidate(); healthQ.refetch(); }}
          title="Refresh"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-card-border text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-path" className="text-base" />
        </button>

        {/* Actions pushed to the right */}
        <div className="ml-auto flex items-center gap-2">
          {viewToggle}
          <Button variant="secondary" icon="heroicons-outline:magnifying-glass" onClick={() => setDiscoverOpen(true)}>
            Discovery
          </Button>
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setOnboardOpen(true)}>
            Add camera
          </Button>
        </div>
      </div>

      {/* Body — the ONLY scroll area (page itself never scrolls; toolbar +
          bulk-bar stay fixed). Themed scrollbar. */}
      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto pb-2">
      {camerasQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-20 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading cameras…
        </div>
      ) : camerasQ.isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
          {apiError(camerasQ.error, "Failed to load cameras")}
        </div>
      ) : cameras.length === 0 ? (
        <div className="rounded-xl border border-dashed border-card-border bg-card">
          <EmptyState
            icon="heroicons-outline:video-camera"
            title={search || status || brand || siteFilter ? "No cameras match" : "No cameras yet"}
            subtitle={
              search || status || brand || siteFilter
                ? "Adjust the search or filters above."
                : "Add one manually or run an ONVIF discovery scan."
            }
            action={
              <div className="flex gap-2">
                <Button variant="secondary" icon="heroicons-outline:magnifying-glass" onClick={() => setDiscoverOpen(true)}>Discover</Button>
                <Button variant="success" icon="heroicons-outline:plus" onClick={() => setOnboardOpen(true)}>Add camera</Button>
              </div>
            }
          />
        </div>
      ) : view === "table" ? (
        <CameraTable
          cameras={cameras}
          healthById={healthById}
          siteNames={siteNames}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAll}
          onOpen={(c) => { setEditTab("view"); setEditTarget(c); }}
          onLive={(c) => setLiveTarget(c)}
          onSnapshot={(c) => setSnapTarget(c)}
          onEdit={(c) => { setEditTab("view"); setEditTarget(c); }}
          onDevice={(c) => { setEditTab("device"); setEditTarget(c); }}
          onDelete={askDelete}
        />
      ) : (
        <CameraGrid
          cameras={cameras}
          healthById={healthById}
          siteNames={siteNames}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onLive={(c) => setLiveTarget(c)}
          onSnapshot={(c) => setSnapTarget(c)}
          onEdit={(c) => { setEditTab("view"); setEditTarget(c); }}
          onDelete={askDelete}
        />
      )}
      </div>

      <BulkActionBar
        count={selectedIds.size}
        groups={groups}
        onAction={runBulk}
        onDeviceAction={runBulkDevice}
        canManageDevices={canManageDevices}
        onClear={() => setSelectedIds(new Set())}
        pending={bulk.isPending || bulkDevice.isPending}
      />

      {/* Modals */}
      {onboardOpen && (
        <OnboardCameraModal
          sites={sites}
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
          initialTab={editTab}
          onClose={() => setEditTarget(null)}
          onSuccess={() => { setEditTarget(null); invalidate(); }}
        />
      )}
      {snapTarget && <SnapshotModal camera={snapTarget} onClose={() => setSnapTarget(null)} />}
      {liveTarget && <LivePlayerModal camera={liveTarget} onClose={() => setLiveTarget(null)} />}
      {deviceResult && (
        <BulkDeviceResultModal result={deviceResult} onClose={() => setDeviceResult(null)} />
      )}

      <ConfirmDialog
        state={confirm}
        onClose={() => setConfirm(null)}
        pending={remove.isPending || bulk.isPending || bulkDevice.isPending}
      />
    </div>
  );
}
