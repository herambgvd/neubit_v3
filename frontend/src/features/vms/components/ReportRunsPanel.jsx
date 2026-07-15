"use client";

// VMS → Reports → per-schedule run history (P6-B, Task 3). Rendered inside an
// expanded row of the Scheduled reports table: a compact table of that schedule's
// past runs (computed_at, format badge, size, status) with a per-run Download
// button. The runs list is a per-schedule TanStack query, enabled only when the
// row is expanded; run-now (in the parent) invalidates it. Downloads mirror the
// ad-hoc report export: fetch the file as a blob so the Bearer header is sent,
// then object-URL → anchor click → revoke.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems, fmtBytes, fmtDateTime } from "@/lib/format";
import { vms } from "../api";

export const scheduleRunsKey = (id) => ["vms-report-schedule-runs", id];

// Map an export format → a sensible download extension.
const EXT = { csv: "csv", pdf: "pdf", json: "json" };

export default function ReportRunsPanel({ schedule }) {
  const [downloading, setDownloading] = useState(null); // runId | null

  const runsQ = useQuery({
    queryKey: scheduleRunsKey(schedule.id),
    queryFn: () => vms.reports.schedules.runs(schedule.id, { limit: 20, offset: 0 }),
    staleTime: 15_000,
  });
  const runs = asItems(runsQ.data);

  const download = async (run) => {
    setDownloading(run.id);
    try {
      const blob = await vms.reports.schedules.runDownloadBlob(schedule.id, run.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = EXT[run.export_format] || run.export_format || "dat";
      const base = (run.name || run.kind || "report").replace(/[^\w.-]+/g, "-");
      const stamp = (run.computed_at || "").slice(0, 19).replace(/[:T]/g, "-");
      a.download = `${base}-${stamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Download failed"));
    } finally {
      setDownloading(null);
    }
  };

  if (runsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading run history…
      </div>
    );
  }
  if (runsQ.isError) {
    return (
      <div className="px-4 py-6 text-xs text-red-500">
        {apiError(runsQ.error, "Failed to load run history")}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted">
        No runs yet — this schedule hasn’t fired. Use “Run now” to generate one.
      </div>
    );
  }

  const th = "px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted";
  return (
    <div className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border/60 bg-hover/30 text-left">
            <th className={th}>Run at</th>
            <th className={th}>Format</th>
            <th className={`${th} text-right`}>Size</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Download</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const ok = run.status === "done";
            const canDownload = ok && (run.output_size || 0) > 0;
            return (
              <tr key={run.id} className="border-b border-card-border/40 last:border-0">
                <td className="px-4 py-2 text-muted tabular-nums">{fmtDateTime(run.computed_at)}</td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center rounded bg-hover px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                    {run.export_format}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">
                  {run.output_size ? fmtBytes(run.output_size) : "—"}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      ok ? "bg-emerald-500/15 text-emerald-500" : "bg-red-500/15 text-red-500"
                    }`}
                    title={!ok && run.error ? run.error : undefined}
                  >
                    <Icon
                      icon={ok ? "heroicons-solid:check-circle" : "heroicons-solid:exclamation-circle"}
                      className="text-xs"
                    />
                    {ok ? "Done" : "Error"}
                  </span>
                  {!ok && run.error && (
                    <span className="ml-2 truncate text-[11px] text-red-500/80" title={run.error}>
                      {run.error}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="inline-flex items-center gap-1 text-xs text-muted transition enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canDownload || downloading === run.id}
                    title={
                      !ok
                        ? "Run errored — nothing to download"
                        : !canDownload
                        ? "Empty report"
                        : "Download report file"
                    }
                    onClick={() => download(run)}
                  >
                    {downloading === run.id ? (
                      <Icon icon="svg-spinners:180-ring" className="text-sm" />
                    ) : (
                      <Icon icon="heroicons-outline:arrow-down-tray" className="text-sm" />
                    )}
                    Download
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
