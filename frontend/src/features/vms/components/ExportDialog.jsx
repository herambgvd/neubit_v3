"use client";

// ExportDialog — export a recorded window to a downloadable clip.
//
// Flow (P4-B): pick from/to (+ format) → export.create → poll export.status
// (queued → running → done|failed) → when done, a Download button pulls the
// token-gated mp4 as a blob and saves it. The source segments stay locked by
// the backend during the job.
//
// Wired from: the Recordings row "Export" action (pre-fills a single recording's
// range) and the PlaybackPlayer "Export this window" hook.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal, Select, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtBytes, fmtDuration } from "@/lib/format";
import { vms } from "../api";

const POLL_MS = 2_000;
const FORMATS = [
  { value: "mp4", label: "MP4 (H.264/HEVC remux)" },
  { value: "mkv", label: "MKV (container copy)" },
];

// "2026-07-09T14:30:00Z" → the value shape a datetime-local input wants (local).
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export default function ExportDialog({ open, onClose, cameraId, cameraName, range }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [format, setFormat] = useState("mp4");
  const [job, setJob] = useState(null); // { job_id, status, file_size?, error?, signed?, checksum?, watermark? }
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [verify, setVerify] = useState(null); // { valid, reason } | "loading"
  const pollRef = useRef(null);

  // Seed the range when (re)opened.
  useEffect(() => {
    if (!open) return;
    setFrom(toLocalInput(range?.from));
    setTo(toLocalInput(range?.to));
    setFormat("mp4");
    setJob(null);
    setSubmitting(false);
    setDownloading(false);
    setWatermark(false);
    setVerify(null);
  }, [open, range?.from, range?.to]);

  // Poll the job while it's in flight.
  useEffect(() => {
    if (!job?.job_id) return undefined;
    if (job.status === "done" || job.status === "failed") return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await vms.export.status(job.job_id);
        if (cancelled) return;
        setJob(next);
        if (next.status !== "done" && next.status !== "failed") {
          pollRef.current = setTimeout(tick, POLL_MS);
        }
      } catch {
        if (!cancelled) pollRef.current = setTimeout(tick, POLL_MS);
      }
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job?.job_id, job?.status]);

  const durationSec = useMemo(() => {
    const a = fromLocalInput(from);
    const b = fromLocalInput(to);
    if (!a || !b) return null;
    return (new Date(b) - new Date(a)) / 1000;
  }, [from, to]);

  const rangeValid = durationSec != null && durationSec > 0;

  const startExport = async () => {
    if (!cameraId || !rangeValid) return;
    setSubmitting(true);
    try {
      const res = await vms.export.create(cameraId, {
        from: fromLocalInput(from),
        to: fromLocalInput(to),
        format,
        watermark,
      });
      setJob({ job_id: res.job_id, status: res.status || "queued" });
    } catch (e) {
      toast.error(apiError(e, "Could not start the export"));
    } finally {
      setSubmitting(false);
    }
  };

  const download = async () => {
    if (!job?.job_id) return;
    setDownloading(true);
    try {
      const blob = await vms.export.downloadBlob(job.job_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cameraName || cameraId}-${job.job_id}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Download failed"));
    } finally {
      setDownloading(false);
    }
  };

  const runVerify = async () => {
    if (!job?.job_id) return;
    setVerify("loading");
    try {
      const res = await vms.export.verify(job.job_id);
      setVerify(res);
      if (res.valid) toast.success("Signature verified — clip is authentic");
      else toast.error(`Verification failed: ${res.reason}`);
    } catch (e) {
      setVerify(null);
      toast.error(apiError(e, "Verify failed"));
    }
  };

  const downloadManifest = async () => {
    if (!job?.job_id) return;
    try {
      const blob = await vms.export.manifestBlob(job.job_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cameraName || cameraId}-${job.job_id}.manifest.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Manifest download failed"));
    }
  };

  const status = job?.status;
  const inFlight = status === "queued" || status === "running";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export clip"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {status === "done" ? "Close" : "Cancel"}
          </Button>
          {!job ? (
            <Button
              variant="primary"
              icon="heroicons-outline:scissors"
              disabled={!rangeValid || submitting}
              onClick={startExport}
            >
              {submitting ? "Starting…" : "Export"}
            </Button>
          ) : status === "done" ? (
            <Button
              variant="success"
              icon="heroicons-outline:arrow-down-tray"
              disabled={downloading}
              onClick={download}
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : status === "failed" ? (
            <Button variant="secondary" icon="heroicons-outline:arrow-path" onClick={() => setJob(null)}>
              Try again
            </Button>
          ) : (
            <Button variant="primary" disabled>
              <Icon icon="svg-spinners:180-ring" className="text-base" /> Exporting…
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2 text-sm">
          <span className="text-muted">Camera</span>{" "}
          <span className="font-medium text-foreground">{cameraName || cameraId}</span>
        </div>

        {!job && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">From</span>
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">To</span>
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
                />
              </label>
            </div>
            <div className="flex items-end gap-4">
              <div className="w-40">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Format</span>
                <Select value={format} onChange={(e) => setFormat(e.target.value)} options={FORMATS} className="!h-9 !py-1.5" />
              </div>
              <label className="flex items-center gap-2 pb-1.5">
                <Toggle checked={watermark} onChange={setWatermark} />
                <span className="text-xs text-muted">Burn provenance watermark</span>
              </label>
            </div>
            <p className="text-xs text-muted">
              {rangeValid ? (
                <>
                  Clip length: <span className="text-foreground">{fmtDuration(durationSec)}</span>. Only recorded
                  spans in this range are included.
                </>
              ) : (
                <span className="text-amber-500">Pick a valid time range (To must be after From).</span>
              )}
            </p>
          </>
        )}

        {job && (
          <div className="rounded-lg border border-card-border bg-hover/30 p-4">
            <div className="flex items-center gap-3">
              {status === "done" ? (
                <Icon icon="heroicons-solid:check-circle" className="text-2xl text-emerald-500" />
              ) : status === "failed" ? (
                <Icon icon="heroicons-solid:x-circle" className="text-2xl text-red-500" />
              ) : (
                <Icon icon="svg-spinners:180-ring" className="text-2xl text-foreground/70" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium capitalize text-foreground">
                  {status === "done"
                    ? "Export ready"
                    : status === "failed"
                      ? "Export failed"
                      : `Export ${status || "queued"}…`}
                </p>
                <p className="truncate text-xs text-muted">
                  Job {String(job.job_id).slice(0, 12)}
                  {job.file_size ? ` · ${fmtBytes(job.file_size)}` : ""}
                  {status === "failed" && job.error ? ` · ${job.error}` : ""}
                </p>
              </div>
            </div>
            {inFlight && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-card-border">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/60" />
              </div>
            )}

            {/* Tamper-evidence — signed badge + verify affordance (P6-B) */}
            {status === "done" && (
              <div className="mt-4 space-y-3 border-t border-card-border pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {job.signed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-500">
                      <Icon icon="heroicons-solid:shield-check" className="text-sm" /> Signed (Ed25519)
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2.5 py-1 text-xs text-muted">
                      <Icon icon="heroicons-outline:shield-exclamation" className="text-sm" /> Not signed
                    </span>
                  )}
                  {job.watermark && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2.5 py-1 text-xs text-muted">
                      <Icon icon="heroicons-outline:identification" className="text-sm" /> Watermarked
                    </span>
                  )}
                  {verify && verify !== "loading" && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                        verify.valid ? "bg-emerald-500/15 text-emerald-500" : "bg-red-500/15 text-red-500"
                      }`}
                    >
                      <Icon icon={verify.valid ? "heroicons-solid:check-badge" : "heroicons-solid:x-circle"} className="text-sm" />
                      {verify.valid ? "Verified authentic" : `Tampered — ${verify.reason}`}
                    </span>
                  )}
                </div>

                {job.checksum && (
                  <div className="text-[11px] text-muted">
                    SHA-256 <code className="break-all text-foreground">{job.checksum}</code>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    icon="heroicons-outline:shield-check"
                    disabled={verify === "loading"}
                    onClick={runVerify}
                  >
                    {verify === "loading" ? "Verifying…" : "Verify signature"}
                  </Button>
                  <Button variant="ghost" icon="heroicons-outline:document-text" onClick={downloadManifest}>
                    Manifest
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
