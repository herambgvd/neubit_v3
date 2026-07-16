"use client";

// VMS → Reports (P6-B). Operational dashboards over a [from, to] window: camera
// uptime, recording coverage, storage usage, event/alarm stats, and a health
// roll-up. Each report is computed server-side (vision) and rendered here as
// summary cards + lightweight inline bars/tables — no chart lib. CSV + PDF exports
// hit the backend renderers. A "Scheduled reports" panel manages recurring
// report→notify schedules.
//
// Reads gate on vms.playback.view; schedule writes on vms.config.manage. The gateway
// routes /api/v1/vms/reports* → the vision service.
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, PageHeader, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtBytes, fmtDateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { vms } from "./api";
import ReportScheduleModal from "./components/ReportScheduleModal";
import ReportRunsPanel, { scheduleRunsKey } from "./components/ReportRunsPanel";

const REPORT_KINDS = [
  { value: "camera-uptime", label: "Camera uptime", icon: "heroicons:signal", desc: "Online % per camera" },
  { value: "recording-coverage", label: "Recording coverage", icon: "heroicons:film", desc: "Recorded vs expected" },
  { value: "storage-usage", label: "Storage usage", icon: "heroicons:circle-stack", desc: "Bytes per pool" },
  { value: "event-stats", label: "Events & alarms", icon: "heroicons:bell-alert", desc: "Counts by type/severity" },
  { value: "health-summary", label: "Health summary", icon: "heroicons:heart", desc: "Estate roll-up" },
  // G8 — operator activity (from core Activity/audit) + alarm response (from workflow).
  { value: "operator-activity", label: "Operator activity", icon: "heroicons:user-group", desc: "Actions per operator" },
  { value: "alarm-response", label: "Alarm response", icon: "heroicons:clock", desc: "Ack-rate & time-to-ack" },
];

// Default the window to the last 7 days.
const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function ReportsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can("vms.config.manage");

  const [kind, setKind] = useState("camera-uptime");
  const [cameraId, setCameraId] = useState("");
  const [fromDate, setFromDate] = useState(isoDaysAgo(7));
  const [toDate, setToDate] = useState(todayStr());
  const [downloading, setDownloading] = useState(null); // "csv" | "pdf" | null
  const [scheduleModal, setScheduleModal] = useState(null); // {} to open
  const [expanded, setExpanded] = useState(null); // schedule id whose run history is open

  // Cameras (optional narrowing + name lookup).
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "reports-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  const params = useMemo(() => {
    const p = { camera_id: cameraId || undefined };
    if (fromDate) p.from = new Date(`${fromDate}T00:00:00`).toISOString();
    if (toDate) p.to = new Date(`${toDate}T23:59:59`).toISOString();
    return p;
  }, [cameraId, fromDate, toDate]);

  const reportQ = useQuery({
    queryKey: ["vms-report", kind, params],
    queryFn: () => vms.reports.get(kind, params),
    enabled: !!params.from && !!params.to,
    keepPreviousData: true,
  });
  const report = reportQ.data;

  // ── Scheduled reports ──────────────────────────────────────────────────
  const schedulesQ = useQuery({
    queryKey: ["vms-report-schedules"],
    queryFn: () => vms.reports.schedules.list(),
    staleTime: 30_000,
  });
  const schedules = useMemo(() => asItems(schedulesQ.data), [schedulesQ.data]);

  const deleteSchedule = useMutation({
    mutationFn: (id) => vms.reports.schedules.remove(id),
    onSuccess: () => {
      toast.success("Schedule removed");
      qc.invalidateQueries({ queryKey: ["vms-report-schedules"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  // Run-now: fires the report immediately. The endpoint returns 201 with the
  // created run even on a compute-error, so branch on run.status. Either way,
  // refresh that schedule's run history and expand it so the result is visible.
  const runNow = useMutation({
    mutationFn: (id) => vms.reports.schedules.runNow(id),
    onSuccess: (run, id) => {
      if (run?.status === "error") {
        toast.warning(run.error || "Report ran but failed to compute");
      } else {
        toast.success("Report generated");
      }
      setExpanded(id);
      qc.invalidateQueries({ queryKey: scheduleRunsKey(id) });
      qc.invalidateQueries({ queryKey: ["vms-report-schedules"] });
    },
    onError: (e) => toast.error(apiError(e, "Run failed")),
  });

  const download = async (fmt) => {
    setDownloading(fmt);
    try {
      const blob = await vms.reports.exportBlob(kind, { ...params, format: fmt });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind}-report.${fmt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      if (fmt === "pdf" && e?.response?.status === 503) {
        toast.error("PDF export unavailable (reportlab not installed on server)");
      } else {
        toast.error(apiError(e, "Export failed"));
      }
    } finally {
      setDownloading(null);
    }
  };

  const cameraOptions = [
    { value: "", label: "All cameras (estate)" },
    ...cameras.map((c) => ({ value: c.id, label: c.name })),
  ];
  const kindOptions = REPORT_KINDS.map((k) => ({ value: k.value, label: k.label }));

  return (
    <div className="pb-8">
      <PageHeader
        title="Reports"
        subtitle="Operational analytics across the estate — uptime, coverage, storage & events. Export to CSV/PDF or schedule delivery."
        actions={
          <Button
            variant="secondary"
            icon="heroicons-outline:arrow-path"
            onClick={() => qc.invalidateQueries({ queryKey: ["vms-report"] })}
          >
            Refresh
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
        <div className="w-56">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Report</label>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} options={kindOptions} className="!py-1.5" />
        </div>
        <div className="w-56">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Camera</label>
          <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)} options={cameraOptions} className="!py-1.5" />
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
        <div className="ml-auto flex items-end gap-2">
          <Button
            variant="secondary"
            icon="heroicons-outline:table-cells"
            disabled={downloading === "csv" || !report}
            onClick={() => download("csv")}
          >
            {downloading === "csv" ? "Exporting…" : "CSV"}
          </Button>
          <Button
            variant="secondary"
            icon="heroicons-outline:document-arrow-down"
            disabled={downloading === "pdf" || !report}
            onClick={() => download("pdf")}
          >
            {downloading === "pdf" ? "Exporting…" : "PDF"}
          </Button>
        </div>
      </div>

      {/* Report body */}
      {reportQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-20 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Computing report…
        </div>
      ) : reportQ.isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
          {apiError(reportQ.error, "Failed to compute the report")}
        </div>
      ) : report ? (
        <ReportView report={report} />
      ) : null}

      {/* Scheduled reports */}
      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Scheduled reports</h2>
            <p className="text-xs text-muted">Recurring reports delivered automatically to recipients.</p>
          </div>
          {canManage && (
            <Button icon="heroicons-outline:plus" onClick={() => setScheduleModal({})}>
              New schedule
            </Button>
          )}
        </div>

        {schedulesQ.isLoading ? (
          <div className="rounded-xl border border-card-border bg-card py-8 text-center text-sm text-muted">
            Loading schedules…
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-12 text-center">
            <Icon icon="heroicons-outline:clock" className="mb-2 text-3xl text-muted opacity-50" />
            <p className="text-sm font-medium text-foreground">No scheduled reports</p>
            <p className="mt-1 text-xs text-muted">
              {canManage ? "Create one to have reports emailed on a daily/weekly cadence." : "An admin can create scheduled reports."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-card-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="w-8 px-4 py-2.5" />
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Report</th>
                  <th className="px-4 py-2.5 font-medium">Cadence</th>
                  <th className="px-4 py-2.5 font-medium">Format</th>
                  <th className="px-4 py-2.5 font-medium">Recipients</th>
                  <th className="px-4 py-2.5 font-medium">Next run</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  {canManage && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => {
                  const isOpen = expanded === s.id;
                  const colSpan = canManage ? 9 : 8;
                  return (
                    <Fragment key={s.id}>
                      <tr
                        className={`cursor-pointer border-b border-card-border/60 transition hover:bg-hover/40 last:border-0 ${
                          isOpen ? "bg-hover/40" : ""
                        }`}
                        onClick={() => setExpanded(isOpen ? null : s.id)}
                      >
                        <td className="px-4 py-2.5 text-muted">
                          <Icon
                            icon="heroicons-solid:chevron-right"
                            className={`text-sm transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                        </td>
                        <td className="px-4 py-2.5 font-medium text-foreground">{s.name}</td>
                        <td className="px-4 py-2.5 text-muted">
                          {REPORT_KINDS.find((k) => k.value === s.kind)?.label || s.kind}
                        </td>
                        <td className="px-4 py-2.5 capitalize text-muted">{s.cadence}</td>
                        <td className="px-4 py-2.5 uppercase text-muted">{s.export_format}</td>
                        <td className="px-4 py-2.5 text-muted">{(s.recipients || []).length || "—"}</td>
                        <td className="px-4 py-2.5 text-muted">{s.next_run_at ? fmtDateTime(s.next_run_at) : "—"}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                              s.enabled ? "bg-emerald-500/15 text-emerald-500" : "bg-hover text-muted"
                            }`}
                          >
                            {s.enabled ? "Active" : "Paused"}
                          </span>
                          {s.last_error && (
                            <span className="ml-1.5 text-[11px] text-red-500" title={s.last_error}>
                              error
                            </span>
                          )}
                        </td>
                        {canManage && (
                          <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="text-muted transition hover:text-foreground disabled:opacity-40"
                              title="Run now"
                              disabled={runNow.isPending && runNow.variables === s.id}
                              onClick={() => runNow.mutate(s.id)}
                            >
                              <Icon
                                icon={
                                  runNow.isPending && runNow.variables === s.id
                                    ? "svg-spinners:180-ring"
                                    : "heroicons-outline:play"
                                }
                                className="text-base"
                              />
                            </button>
                            <button
                              className="ml-2 text-muted transition hover:text-foreground"
                              title="Edit"
                              onClick={() => setScheduleModal(s)}
                            >
                              <Icon icon="heroicons-outline:pencil-square" className="text-base" />
                            </button>
                            <button
                              className="ml-2 text-muted transition hover:text-red-500"
                              title="Delete"
                              onClick={() => {
                                if (window.confirm(`Delete schedule "${s.name}"?`)) deleteSchedule.mutate(s.id);
                              }}
                            >
                              <Icon icon="heroicons-outline:trash" className="text-base" />
                            </button>
                          </td>
                        )}
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-card-border/60 last:border-0">
                          <td colSpan={colSpan} className="bg-hover/20 p-0">
                            <ReportRunsPanel schedule={s} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ReportScheduleModal
        open={!!scheduleModal}
        schedule={scheduleModal && scheduleModal.id ? scheduleModal : null}
        reportKinds={REPORT_KINDS}
        onClose={() => setScheduleModal(null)}
        onSaved={() => {
          setScheduleModal(null);
          qc.invalidateQueries({ queryKey: ["vms-report-schedules"] });
        }}
      />
    </div>
  );
}

// ── Report renderer — one component per shape, driven by report.kind ─────────
function ReportView({ report }) {
  const totals = report.totals || {};
  const rows = report.rows || [];

  if (report.kind === "camera-uptime") {
    return (
      <div className="space-y-4">
        <SummaryRow
          tiles={[
            { label: "Cameras", value: totals.cameras ?? rows.length, icon: "heroicons:video-camera", tone: "info" },
            { label: "Avg uptime", value: `${totals.avg_uptime_pct ?? 0}%`, icon: "heroicons:signal", tone: (totals.avg_uptime_pct ?? 0) >= 90 ? "ok" : (totals.avg_uptime_pct ?? 0) >= 50 ? "warn" : "bad" },
          ]}
        />
        <BarTable
          rows={rows}
          nameKey="camera_name"
          valueKey="uptime_pct"
          nameLabel="Camera"
          valueLabel="Uptime"
          suffix="%"
          max={100}
          columns={[
            { key: "samples", label: "Samples" },
            { key: "online_samples", label: "Online" },
          ]}
        />
      </div>
    );
  }

  if (report.kind === "recording-coverage") {
    return (
      <div className="space-y-4">
        <SummaryRow
          tiles={[
            { label: "Cameras", value: totals.cameras ?? rows.length },
            { label: "Avg coverage", value: `${totals.avg_coverage_pct ?? 0}%` },
            { label: "Total size", value: fmtBytes(totals.total_bytes || 0) },
          ]}
        />
        <BarTable
          rows={rows}
          nameKey="camera_name"
          valueKey="coverage_pct"
          nameLabel="Camera"
          valueLabel="Coverage"
          suffix="%"
          max={100}
          columns={[
            { key: "segments", label: "Segments" },
            { key: "bytes", label: "Size", fmt: fmtBytes },
          ]}
        />
      </div>
    );
  }

  if (report.kind === "storage-usage") {
    const maxBytes = Math.max(1, ...rows.map((r) => r.bytes || 0));
    return (
      <div className="space-y-4">
        <SummaryRow
          tiles={[
            { label: "Pools", value: totals.pools ?? rows.length },
            { label: "Total size", value: fmtBytes(totals.total_bytes || 0) },
            { label: "Segments", value: totals.total_segments ?? 0 },
          ]}
        />
        <BarTable
          rows={rows}
          nameKey="pool_name"
          valueKey="bytes"
          nameLabel="Pool"
          valueLabel="Usage"
          valueFmt={fmtBytes}
          max={maxBytes}
          columns={[
            { key: "pool_type", label: "Type" },
            { key: "segments", label: "Segments" },
          ]}
        />
      </div>
    );
  }

  if (report.kind === "event-stats") {
    return (
      <div className="space-y-4">
        <SummaryRow tiles={[{ label: "Total events", value: totals.total_events ?? 0 }]} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BreakdownCard title="By type" data={report.by_type} />
          <BreakdownCard title="By severity" data={report.by_severity} />
        </div>
        {rows.length > 0 && (
          <BarTable
            rows={rows}
            nameKey="camera_name"
            valueKey="events"
            nameLabel="Camera"
            valueLabel="Events"
            title="By camera"
            max={Math.max(1, ...rows.map((r) => r.events || 0))}
          />
        )}
      </div>
    );
  }

  if (report.kind === "health-summary") {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {rows.map((r) => (
          <SummaryTile key={r.metric} label={r.metric.replace(/_/g, " ")} value={r.value} />
        ))}
      </div>
    );
  }

  // ── G8: Operator activity — per-operator action rollup (core Activity/audit) ──
  if (report.kind === "operator-activity") {
    const totalActions = totals.total_actions ?? totals.actions ?? rows.reduce((s, r) => s + (r.actions || r.count || 0), 0);
    return (
      <div className="space-y-4">
        <SummaryRow
          tiles={[
            { label: "Operators", value: totals.operators ?? rows.length },
            { label: "Total actions", value: totalActions },
          ]}
        />
        <BarTable
          rows={rows}
          nameKey={rows[0]?.operator_name != null ? "operator_name" : "operator"}
          valueKey={rows[0]?.actions != null ? "actions" : "count"}
          nameLabel="Operator"
          valueLabel="Actions"
          title="By operator"
          max={Math.max(1, ...rows.map((r) => r.actions || r.count || 0))}
        />
        {report.by_action && Object.keys(report.by_action).length > 0 && (
          <BreakdownCard title="By action" data={report.by_action} />
        )}
        <SourceNote note={report.source_note} />
      </div>
    );
  }

  // ── G8: Alarm response — ack-rate + time-to-ack per camera/severity (workflow) ──
  if (report.kind === "alarm-response") {
    const ackRate = totals.ack_rate_pct ?? totals.ack_rate ?? 0;
    const avgTtaSec = totals.avg_time_to_ack_seconds ?? totals.avg_ack_seconds ?? totals.avg_tta_seconds;
    return (
      <div className="space-y-4">
        <SummaryRow
          tiles={[
            { label: "Alarms", value: totals.total_alarms ?? totals.alarms ?? rows.length },
            { label: "Acknowledged", value: totals.acknowledged ?? totals.acked ?? "—" },
            { label: "Ack rate", value: `${ackRate}%` },
            { label: "Avg time-to-ack", value: fmtDuration(avgTtaSec) },
          ]}
        />
        {report.by_severity && Object.keys(report.by_severity).length > 0 && (
          <BreakdownCard title="By severity" data={report.by_severity} />
        )}
        {rows.length > 0 && (
          <BarTable
            rows={rows}
            nameKey={rows[0]?.camera_name != null ? "camera_name" : "name"}
            valueKey={rows[0]?.ack_rate_pct != null ? "ack_rate_pct" : "ack_rate"}
            nameLabel="Camera"
            valueLabel="Ack rate"
            suffix="%"
            max={100}
            title="By camera"
            columns={[
              { key: "alarms", label: "Alarms" },
              {
                key: rows[0]?.avg_time_to_ack_seconds != null ? "avg_time_to_ack_seconds" : "avg_ack_seconds",
                label: "Avg TTA",
                fmt: fmtDuration,
              },
            ]}
          />
        )}
        <SourceNote note={report.source_note} />
      </div>
    );
  }

  // Fallback — raw JSON so unknown kinds still render.
  return (
    <pre className="overflow-auto rounded-xl border border-card-border bg-card p-4 text-xs text-muted">
      {JSON.stringify(report, null, 2)}
    </pre>
  );
}

// Format a duration in seconds → "1m 20s" / "45s" / "1h 5m". null → "—".
function fmtDuration(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const s = Math.round(Number(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// Small caption explaining where the report's full data lives (core Activity / workflow).
function SourceNote({ note }) {
  if (!note) return null;
  return (
    <p className="flex items-start gap-1.5 px-1 text-[11px] text-muted">
      <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
      <span>{note}</span>
    </p>
  );
}

// Columns sized to the tile count (capped at 4) so the KPI row always fills the
// width instead of leaving a half-empty gap on the right.
const _COLS = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 5: "sm:grid-cols-5", 6: "sm:grid-cols-6" };
function SummaryRow({ tiles }) {
  const cols = _COLS[Math.min(tiles.length, 6)] || "sm:grid-cols-4";
  return (
    <div className={`grid grid-cols-2 gap-2.5 ${cols}`}>
      {tiles.map((t) => (
        <SummaryTile key={t.label} label={t.label} value={t.value} icon={t.icon} tone={t.tone} />
      ))}
    </div>
  );
}

const _TONE = {
  ok: "text-emerald-500 bg-emerald-500/10",
  warn: "text-amber-500 bg-amber-500/10",
  bad: "text-red-500 bg-red-500/10",
  info: "text-blue-500 bg-blue-500/10",
};
const _BAR = { ok: "bg-emerald-500/70", warn: "bg-amber-500/70", bad: "bg-red-500/70", info: "bg-blue-500/70" };
function SummaryTile({ label, value, icon, tone = "info" }) {
  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-card-border bg-card px-4 py-3.5">
      <span className={`absolute inset-y-0 left-0 w-1 ${_BAR[tone] || _BAR.info}`} />
      {icon && (
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${_TONE[tone] || _TONE.info}`}>
          <Icon icon={icon} className="text-lg" />
        </span>
      )}
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight tracking-tight text-foreground tabular-nums">{value}</div>
        <div className="mt-0.5 truncate text-[11px] font-medium uppercase tracking-wide capitalize text-muted">{label}</div>
      </div>
    </div>
  );
}

// A rows table where each row gets a horizontal bar for its primary metric.
// Renders a proper column-header row so numeric columns are always labelled.
function BarTable({
  rows,
  nameKey,
  valueKey,
  nameLabel = "Name",
  valueLabel = "Value",
  suffix = "",
  valueFmt,
  max = 100,
  columns = [],
  title,
}) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-card-border bg-card py-12 text-center text-sm text-muted">
        No data in this window.
      </div>
    );
  }
  const th = "px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted";
  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card">
      {title && (
        <div className="border-b border-card-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border bg-hover/40 text-left">
            <th className={`${th} w-48`}>{nameLabel}</th>
            <th className={th}>{valueLabel}</th>
            {columns.map((c) => (
              <th key={c.key} className={`${th} text-right`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const v = r[valueKey] || 0;
            const pct = Math.min(100, (v / max) * 100);
            return (
              <tr
                key={r[nameKey] || i}
                className="border-b border-card-border/50 transition last:border-0 hover:bg-hover/40"
              >
                <td className="w-48 px-4 py-2.5 font-medium text-foreground">{r[nameKey]}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-hover">
                      <div
                        className={`h-full rounded-full ${pct >= 66 ? "bg-emerald-500" : pct >= 33 ? "bg-amber-500" : "bg-red-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-24 text-right text-xs font-semibold tabular-nums text-foreground">
                      {valueFmt ? valueFmt(v) : `${v}${suffix}`}
                    </span>
                  </div>
                </td>
                {columns.map((c) => (
                  <td key={c.key} className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums text-muted">
                    {c.fmt ? c.fmt(r[c.key]) : r[c.key] ?? "—"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownCard({ title, data }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No events.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([label, n]) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-32 truncate text-xs capitalize text-foreground">{label.replace(/_/g, " ")}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-hover">
                <div className="h-full rounded-full bg-foreground/60" style={{ width: `${(n / max) * 100}%` }} />
              </div>
              <span className="w-8 text-right text-xs tabular-nums text-muted">{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
