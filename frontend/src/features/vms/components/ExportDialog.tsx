"use client";

// ExportDialog — export a recorded window to a downloadable clip.
//
// The RECORDER produces it. It holds the segments, cuts them with its own ffmpeg,
// hashes the result and signs a chain-of-custody manifest with its own key; the VMS
// asks and relays. That is not a routing detail — it is why "verify" means anything.
// A verification run here, on a copy relayed through the VMS, would only prove the
// copy arrived intact, so verify is asked of the recorder too.
//
// Flow: pick from/to → federation.actions.createExport → poll getExport
// (queued → running → done|failed) → Download pulls the token-gated mp4 as a blob.
// Then the evidence trio: verify (the recorder re-hashes its own file), the signed
// manifest (relayed byte for byte), and the recorder's public key.
//
// NOT offered any more, because the recorder's export API does not take them: a
// container FORMAT choice (it produces mp4) and a burnt-in provenance WATERMARK.
// The dialog used to send both to the VMS's own exporter. Showing controls the
// recorder ignores would be worse than not showing them.
//
// Wired from: the Recordings row "Export" action (pre-fills a single recording's
// range) and the PlaybackPlayer "Export this window" hook.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtBytes, fmtDuration } from "@/lib/format";
import { vms } from "../api";
import type { FederatedExportJob, FederatedExportVerify } from "../types";
import type { ExportRange } from "./playbackTypes";

const POLL_MS = 2_000;

// "2026-07-09T14:30:00Z" → the value shape a datetime-local input wants (local).
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

/** The job as this dialog tracks it: seeded with just `{ id, status }` from the
 *  create call, filled in by each status poll. */
type ExportJobState = Pick<FederatedExportJob, "id" | "status"> & Partial<FederatedExportJob>;

export interface ExportDialogProps {
  open: boolean;
  onClose?: () => void;
  /** The recorder that owns the footage and will produce the clip. */
  nodeId?: string | null;
  /** The camera's id ON that recorder. */
  cameraId?: string | null;
  cameraName?: string | null;
  /** The window to pre-fill (a recording's span, a player's window, a clip selection). */
  range?: ExportRange | null;
}

export default function ExportDialog({ open, onClose, nodeId, cameraId, cameraName, range }: ExportDialogProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [job, setJob] = useState<ExportJobState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [verify, setVerify] = useState<FederatedExportVerify | "loading" | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the range when (re)opened.
  useEffect(() => {
    if (!open) return;
    setFrom(toLocalInput(range?.from));
    setTo(toLocalInput(range?.to));
    setJob(null);
    setSubmitting(false);
    setDownloading(false);
    setVerify(null);
  }, [open, range?.from, range?.to]);

  // Poll the job while it's in flight.
  useEffect(() => {
    if (!job?.id || !nodeId) return undefined;
    if (job.status === "done" || job.status === "failed") return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await vms.federation.actions.getExport(nodeId, job.id);
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
  }, [nodeId, job?.id, job?.status]);

  const durationSec = useMemo(() => {
    const a = fromLocalInput(from);
    const b = fromLocalInput(to);
    if (!a || !b) return null;
    return (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  }, [from, to]);

  const rangeValid = durationSec != null && durationSec > 0;

  const startExport = async () => {
    const a = fromLocalInput(from);
    const b = fromLocalInput(to);
    if (!nodeId || !cameraId || !rangeValid || !a || !b) return;
    setSubmitting(true);
    try {
      const res = await vms.federation.actions.createExport(nodeId, cameraId, a, b);
      setJob({ id: res.id, status: res.status || "queued" });
    } catch (e) {
      toast.error(apiError(e, "Could not start the export"));
    } finally {
      setSubmitting(false);
    }
  };

  const download = async () => {
    if (!job?.id || !nodeId) return;
    setDownloading(true);
    try {
      const blob = await vms.federation.actions.downloadExportBlob(nodeId, job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cameraName || cameraId}-${job.id}.mp4`;
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
    if (!job?.id || !nodeId) return;
    setVerify("loading");
    try {
      const res = await vms.federation.actions.verifyExport(nodeId, job.id);
      setVerify(res);
      // `detail` is the recorder's sentence about what it found; `reason` is the
      // machine token. The operator gets the sentence when there is one.
      if (res.valid) toast.success("Verified — the clip still hashes to its signed manifest");
      else toast.error(res.detail || `Verification failed: ${res.reason}`);
    } catch (e) {
      setVerify(null);
      toast.error(apiError(e, "Verify failed"));
    }
  };

  const downloadManifest = async () => {
    if (!job?.id || !nodeId) return;
    try {
      const blob = await vms.federation.actions.exportManifestBlob(nodeId, job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cameraName || cameraId}-${job.id}.manifest.json`;
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
        <div className="rounded-lg border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.08)]/40 px-3 py-2 text-sm">
          <span className="text-[#aec2e8]">Camera</span>{" "}
          <span className="font-medium text-[#f2f6ff]">{cameraName || cameraId}</span>
        </div>

        {!job && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">From</span>
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[#aec2e8]">To</span>
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 w-full rounded-lg border border-[rgba(150,180,245,.22)] bg-transparent px-3 text-sm text-[#f2f6ff] outline-hidden focus:border-[rgba(34,211,238,.5)]"
                />
              </label>
            </div>
            <p className="text-xs text-[#aec2e8]">
              {rangeValid ? (
                <>
                  Clip length: <span className="text-[#f2f6ff]">{fmtDuration(durationSec)}</span>. Only recorded
                  spans in this range are included.
                </>
              ) : (
                <span className="text-amber-500">Pick a valid time range (To must be after From).</span>
              )}
            </p>
          </>
        )}

        {job && (
          <div className="rounded-lg border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.08)]/30 p-4">
            <div className="flex items-center gap-3">
              {status === "done" ? (
                <Icon icon="heroicons-solid:check-circle" className="text-2xl text-[#22d3ee]" />
              ) : status === "failed" ? (
                <Icon icon="heroicons-solid:x-circle" className="text-2xl text-red-500" />
              ) : (
                <Icon icon="svg-spinners:180-ring" className="text-2xl text-[#f2f6ff]/70" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium capitalize text-[#f2f6ff]">
                  {status === "done"
                    ? "Export ready"
                    : status === "failed"
                      ? "Export failed"
                      : `Export ${status || "queued"}…`}
                </p>
                <p className="truncate text-xs text-[#aec2e8]">
                  Job {String(job.job_id).slice(0, 12)}
                  {job.file_size ? ` · ${fmtBytes(job.file_size)}` : ""}
                  {status === "failed" && job.error ? ` · ${job.error}` : ""}
                </p>
              </div>
            </div>
            {inFlight && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[rgba(150,180,245,.22)]">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[rgba(34,211,238,.6)]" />
              </div>
            )}

            {/* Tamper-evidence — signed badge + verify affordance (P6-B) */}
            {status === "done" && (
              <div className="mt-4 space-y-3 border-t border-[rgba(150,180,245,.22)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {job.signed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(34,211,238,.15)] px-2.5 py-1 text-xs font-medium text-[#67e8f9]">
                      <Icon icon="heroicons-solid:shield-check" className="text-sm" /> Signed (Ed25519)
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(150,180,245,.08)] px-2.5 py-1 text-xs text-[#aec2e8]">
                      <Icon icon="heroicons-outline:shield-exclamation" className="text-sm" /> Not signed
                    </span>
                  )}
                  {job.encode_mode === "reencode" && (
                    /* Worth surfacing on an evidence artefact: the clip was
                       re-encoded because the source segments could not be
                       concatenated by stream copy, so it is not bit-identical to
                       what was recorded. The manifest still pins both. */
                    <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(150,180,245,.08)] px-2.5 py-1 text-xs text-[#aec2e8]">
                      <Icon icon="heroicons-outline:arrow-path" className="text-sm" /> Re-encoded
                    </span>
                  )}
                  {verify && verify !== "loading" && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                        verify.valid ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]" : "bg-red-500/15 text-red-500"
                      }`}
                    >
                      <Icon icon={verify.valid ? "heroicons-solid:check-badge" : "heroicons-solid:x-circle"} className="text-sm" />
                      {verify.valid ? "Verified authentic" : `Not verified — ${verify.reason}`}
                    </span>
                  )}
                </div>

                {job.sha256 && (
                  <div className="text-[11px] text-[#aec2e8]">
                    SHA-256 <code className="break-all text-[#f2f6ff]">{job.sha256}</code>
                  </div>
                )}

                {/* The recorder's own words about what it found, and — when the
                    clip does not match — both hashes, because "tampered" with no
                    numbers behind it is not something anybody can act on. */}
                {verify && verify !== "loading" && !verify.valid && (
                  <div className="space-y-1 text-[11px] text-[#aec2e8]">
                    {verify.detail && <p>{verify.detail}</p>}
                    {verify.expected_sha256 && verify.actual_sha256 && (
                      <>
                        <div>
                          Manifest says{" "}
                          <code className="break-all text-[#f2f6ff]">{verify.expected_sha256}</code>
                        </div>
                        <div>
                          File hashes to{" "}
                          <code className="break-all text-red-400">{verify.actual_sha256}</code>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Verifying against the key EMBEDDED in the manifest proves only
                    that whoever holds the matching private key signed it. This says
                    whether that key is the recorder's current one. */}
                {verify && verify !== "loading" && verify.valid && verify.signed_by_this_node === false && (
                  <p className="text-[11px] text-amber-400">
                    The manifest is internally valid but was not signed by this recorder&apos;s current
                    key — it predates a key rotation, or it came from another recorder.
                  </p>
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
