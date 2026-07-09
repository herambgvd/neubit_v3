"use client";

// VMS → Recordings. Browse recorded footage across the estate or per-camera.
// Camera picker + date range → a filtered list (start/end, duration, size,
// trigger badge, integrity dot, lock state) with row actions (lock/unlock,
// verify integrity). A per-camera coverage strip shows the recording timeline
// for the selected day. Ported from gvd_nvr's Recordings page, reskinned to v3.
//
// Play jumps to the Playback surface (P4-C); Export opens the clip-export dialog
// for a recording's range. Real recordings need cameras that are actively
// recording.
import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, PageHeader, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtBytes } from "@/lib/format";
import { vms } from "./api";
import { TRIGGER_PRESETS } from "./constants";
import RecordingsTable from "./components/RecordingsTable";
import RecordingTimeline from "./components/RecordingTimeline";
import ExportDialog from "./components/ExportDialog";

// Default the date range to "today".
const todayStr = () => new Date().toISOString().slice(0, 10);

const TRIGGER_OPTIONS = [
  { value: "", label: "All triggers" },
  ...Object.entries(TRIGGER_PRESETS).map(([value, p]) => ({ value, label: p.label })),
];

export default function RecordingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [cameraId, setCameraId] = useState(""); // "" = all cameras (estate)
  const [trigger, setTrigger] = useState("");
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [pendingId, setPendingId] = useState(null);
  const [exportRec, setExportRec] = useState(null); // Recording being exported

  // ── Cameras (picker + name lookup) ─────────────────────────────────────
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "recordings-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const cameraNames = useMemo(() => {
    const m = {};
    for (const c of cameras) m[c.id] = c.name;
    return m;
  }, [cameras]);

  // Build the shared time-window filter (inclusive whole days).
  const filters = useMemo(() => {
    const f = { trigger: trigger || undefined, limit: 500 };
    if (fromDate) f.from = new Date(`${fromDate}T00:00:00`).toISOString();
    if (toDate) f.to = new Date(`${toDate}T23:59:59`).toISOString();
    return f;
  }, [trigger, fromDate, toDate]);

  // ── Per-camera view — one query ────────────────────────────────────────
  const singleQ = useQuery({
    queryKey: ["vms-recordings", cameraId, filters],
    queryFn: () => vms.recordings.list(cameraId, filters),
    enabled: !!cameraId,
  });

  // ── Estate view — fan out across all cameras, merge + sort ─────────────
  const estateQueries = useQueries({
    queries: cameras.map((c) => ({
      queryKey: ["vms-recordings", c.id, filters],
      queryFn: () => vms.recordings.list(c.id, filters),
      enabled: !cameraId, // only when browsing the whole estate
    })),
  });

  const { recordings, total, isLoading, isError, error } = useMemo(() => {
    if (cameraId) {
      return {
        recordings: asItems(singleQ.data),
        total: singleQ.data?.total ?? asItems(singleQ.data).length,
        isLoading: singleQ.isLoading,
        isError: singleQ.isError,
        error: singleQ.error,
      };
    }
    const merged = [];
    for (const q of estateQueries) merged.push(...asItems(q.data));
    merged.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
    return {
      recordings: merged,
      total: merged.length,
      isLoading: camerasQ.isLoading || estateQueries.some((q) => q.isLoading),
      isError: estateQueries.some((q) => q.isError),
      error: estateQueries.find((q) => q.isError)?.error,
    };
  }, [cameraId, singleQ.data, singleQ.isLoading, singleQ.isError, singleQ.error, estateQueries, camerasQ.isLoading]);

  const totalBytes = useMemo(
    () => recordings.reduce((sum, r) => sum + (r.file_size || 0), 0),
    [recordings],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["vms-recordings"] });

  // ── Row-action mutations ───────────────────────────────────────────────
  const withPending = (fn) => async (r) => {
    setPendingId(r.id);
    try {
      await fn(r);
    } finally {
      setPendingId(null);
    }
  };

  const lock = useMutation({
    mutationFn: (r) => vms.recordings.lock(r.id),
    onSuccess: () => { toast.success("Recording locked"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Lock failed")),
  });
  const unlock = useMutation({
    mutationFn: (r) => vms.recordings.unlock(r.id),
    onSuccess: () => { toast.success("Recording unlocked"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Unlock failed")),
  });
  const verify = useMutation({
    mutationFn: (r) => vms.recordings.verify(r.id),
    onSuccess: (res) => {
      const status = res?.integrity_status || res?.status;
      toast.success(status ? `Integrity: ${status}` : "Verification complete");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Verify failed")),
  });

  const cameraOptions = [
    { value: "", label: "All cameras (estate)" },
    ...cameras.map((c) => ({ value: c.id, label: c.name })),
  ];

  const resetFilters = () => {
    setCameraId("");
    setTrigger("");
    setFromDate(todayStr());
    setToDate(todayStr());
  };

  // Play → the Playback surface, deep-linked to this recording's camera.
  const playRecording = (r) => router.push(`/playback?camera=${r.camera_id}`);
  // Export → the clip-export dialog, pre-filled with this recording's range.
  const exportRecording = (r) => setExportRec(r);

  return (
    <div className="pb-8">
      <PageHeader
        title="Recordings"
        subtitle="Browse recorded footage across the estate. Lock protects clips from retention & tiering."
        actions={
          <Button
            variant="secondary"
            icon="heroicons-outline:arrow-path"
            onClick={() => invalidate()}
          >
            Refresh
          </Button>
        }
      />

      {/* Summary */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryTile label="Recordings" value={total} />
        <SummaryTile label="Total size" value={fmtBytes(totalBytes)} />
        <SummaryTile label="Locked" value={recordings.filter((r) => r.locked).length} />
        <SummaryTile
          label="Scope"
          value={cameraId ? cameraNames[cameraId] || "Camera" : "Estate"}
        />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
        <div className="w-56">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Camera</label>
          <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)} options={cameraOptions} className="!h-9 !py-1.5" />
        </div>
        <div className="w-40">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Trigger</label>
          <Select value={trigger} onChange={(e) => setTrigger(e.target.value)} options={TRIGGER_OPTIONS} className="!h-9 !py-1.5" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
          />
        </div>
        <Button variant="ghost" onClick={resetFilters}>Reset</Button>
      </div>

      {/* Coverage strip — only when a single camera + single day are selected */}
      {cameraId && fromDate && fromDate === toDate && !isLoading && (
        <div className="mb-4 rounded-xl border border-card-border bg-card p-4">
          <RecordingTimeline
            recordings={recordings}
            day={fromDate}
            onSeek={() => router.push(`/playback?camera=${cameraId}`)}
          />
        </div>
      )}

      {/* Body */}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-20 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading recordings…
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
          {apiError(error, "Failed to load recordings")}
        </div>
      ) : recordings.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-20 text-center">
          <Icon icon="heroicons-outline:film" className="mb-3 text-4xl text-muted opacity-50" />
          <p className="font-medium text-foreground">No recordings found</p>
          <p className="mt-1 text-sm text-muted">
            Adjust the camera or date range. Recordings appear once a camera is actively recording.
          </p>
        </div>
      ) : (
        <RecordingsTable
          recordings={recordings}
          cameraNames={cameraNames}
          showCamera={!cameraId}
          pendingId={pendingId}
          onLock={withPending((r) => lock.mutateAsync(r))}
          onUnlock={withPending((r) => unlock.mutateAsync(r))}
          onVerify={withPending((r) => verify.mutateAsync(r))}
          onPlay={playRecording}
          onExport={exportRecording}
        />
      )}

      <ExportDialog
        open={!!exportRec}
        onClose={() => setExportRec(null)}
        cameraId={exportRec?.camera_id}
        cameraName={exportRec ? cameraNames[exportRec.camera_id] : undefined}
        range={exportRec ? { from: exportRec.start_time, to: exportRec.end_time } : null}
      />
    </div>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div className="rounded-xl border border-card-border bg-card px-4 py-3">
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}
