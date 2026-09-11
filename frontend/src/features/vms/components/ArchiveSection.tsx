"use client";

// THE COLD TIER — the difference between a gap in the timeline and footage that
// is gone.
//
// The archive copies footage somewhere durable; retention later deletes the LOCAL
// copy. From an operator's seat the result is indistinguishable from deletion —
// an empty stretch of timeline — and it is not deletion at all. Nothing in this
// console said so, so "we lost that week" was a conclusion people could reach
// while the week sat safely on a NAS.
//
// THREE THINGS, in the order somebody asks them:
//
//   * IS THE ARCHIVE ACTUALLY WORKING. Not "is it enabled" — the recorder reports
//     a `blocked_reason` when it is configured and cannot run (destination not
//     mounted, pool offline), and that is the state worth shouting about. Without
//     it "0 archived" reads as "nothing needed archiving" when it means "nothing
//     ever will".
//   * WHAT IS RECOVERABLE. The cold-only ranges: footage that survives in the
//     archive alone.
//   * HOW PAST RECOVERIES WENT, per segment. A restore that got 40 of 50 back is
//     neither a success nor a failure and only the counts say which.
//
// THERE IS NO RESTORE BUTTON HERE, and its absence is deliberate rather than
// unfinished. Starting a restore writes footage back to local disk and re-indexes
// it; it gates on `vms.storage.manage`, which the federation credential does not
// carry — reading how full a disk is and deciding where footage lives are not the
// same act. A button here could only ever produce a refusal, so this links to the
// recorder that can do it.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { asItems, fmtBytes } from "@/lib/format";
import { vms } from "../api";
import type { FederationNode, NodeArchive, NodeRestoreJob } from "../types";

export interface ArchiveSectionProps {
  node: FederationNode;
}

/** What the recorder is actually doing, in one phrase — and the reason when the
 *  answer is "nothing". `enabled` alone is not the question: an archive that is on
 *  and blocked protects exactly as much footage as one that is off. */
export function archiveVerdict(a: NodeArchive | undefined): {
  tone: "good" | "warn" | "idle";
  text: string;
} {
  if (!a) return { tone: "idle", text: "not reported" };
  if (!a.enabled) return { tone: "idle", text: "Off — footage has no second copy" };
  if (a.blocked_reason) return { tone: "warn", text: a.blocked_reason };
  if (a.last_error) return { tone: "warn", text: a.last_error };
  if (a.ready === false) return { tone: "warn", text: "Enabled, but the recorder reports it is not ready" };
  return { tone: "good", text: "Running" };
}

/** A restore's outcome in the operator's terms. `partial` is its own state on
 *  purpose: calling a 40-of-50 restore "done" is how the missing ten go unnoticed. */
export function jobVerdict(j: NodeRestoreJob): { tone: "good" | "warn" | "bad" | "idle"; text: string } {
  const status = String(j.status ?? "").toLowerCase();
  const restored = j.restored ?? 0;
  const failed = j.failed ?? 0;
  const requested = j.requested ?? 0;
  if (status === "failed") return { tone: "bad", text: "failed" };
  if (status === "pending" || status === "running") return { tone: "idle", text: status };
  if (failed > 0 || (requested > 0 && restored < requested)) {
    return { tone: "warn", text: `${restored} of ${requested} recovered` };
  }
  return { tone: "good", text: `${restored} recovered` };
}

const TONE: Record<string, string> = {
  good: "text-emerald-400",
  warn: "text-amber-300",
  bad: "text-nb-crit",
  idle: "text-nb-faint",
};

export default function ArchiveSection({ node }: ArchiveSectionProps) {
  const archiveQ = useQuery({
    queryKey: ["vms-node-archive", node.id],
    queryFn: () => vms.federation.storage.archive(node.id),
    retry: false,
  });
  const rangesQ = useQuery({
    queryKey: ["vms-node-restore-ranges", node.id],
    queryFn: () => vms.federation.storage.restoreRanges(node.id),
    retry: false,
  });
  const jobsQ = useQuery({
    queryKey: ["vms-node-restore-jobs", node.id],
    queryFn: () => vms.federation.storage.restoreJobs(node.id),
    retry: false,
  });

  const archive = archiveQ.data;
  const stats = archive?.stats ?? {};
  const ranges = useMemo(() => asItems(rangesQ.data), [rangesQ.data]);
  const jobs = useMemo(() => asItems(jobsQ.data) as NodeRestoreJob[], [jobsQ.data]);
  const verdict = archiveVerdict(archive);

  if (archiveQ.isLoading) {
    return (
      <p className="flex items-center gap-1.5 px-1 py-3 text-xs text-nb-faint">
        <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" /> Loading…
      </p>
    );
  }
  if (archiveQ.isError) {
    return <p className="px-1 py-3 text-xs text-nb-crit">{apiError(archiveQ.error, "Failed to load the archive")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-nb-line bg-white/[0.02] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[12.5px] font-semibold ${TONE[verdict.tone]}`}>{verdict.text}</span>
          {archive?.destination_name && (
            <span className="text-[11.5px] text-nb-faint">→ {archive.destination_name}</span>
          )}
          {archive?.at_time && archive.enabled && (
            <span className="ml-auto font-mono text-[11px] text-nb-faint">daily {archive.at_time}</span>
          )}
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2 text-[11.5px]">
          <Stat label="Archived" value={stats.archived_segments ?? 0} sub={fmtBytes(stats.archived_bytes ?? 0)} />
          {/* The number that matters most and reads as least alarming. These have
              ONE copy: if the disk goes, they go. */}
          <Stat
            label="Local only"
            value={stats.local_only ?? 0}
            sub="no second copy"
            tone={(stats.local_only ?? 0) > 0 ? "warn" : undefined}
          />
          <Stat label="Cold only" value={stats.cold_only ?? 0} sub="restore to view" />
        </div>
      </div>

      {(stats.cold_only ?? 0) > 0 || ranges.length > 0 ? (
        <div>
          <p className="mb-1.5 text-[11.5px] text-nb-soft">
            {ranges.length} {ranges.length === 1 ? "stretch" : "stretches"} of footage survive in the
            archive alone. They are not on the timeline and they are not lost.
          </p>
          <ul className="space-y-1">
            {ranges.slice(0, 6).map((r) => (
              <li
                key={String(r.segment_path)}
                className="flex items-center gap-2 rounded-[8px] border border-nb-line px-2.5 py-1.5 text-[11.5px]"
              >
                <Icon icon="heroicons:archive-box" className="shrink-0 text-xs text-nb-faint" />
                <span className="truncate text-nb-soft">
                  {r.started_at ? new Date(String(r.started_at)).toLocaleString() : "undated"}
                </span>
                <span className="ml-auto shrink-0 font-mono text-nb-faint">
                  {fmtBytes(Number(r.size_bytes ?? 0))}
                </span>
              </li>
            ))}
          </ul>
          {ranges.length > 6 && (
            <p className="mt-1 text-[11px] text-nb-faint">and {ranges.length - 6} more</p>
          )}
        </div>
      ) : null}

      {jobs.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            Recent restores
          </p>
          <ul className="space-y-1">
            {jobs.slice(0, 5).map((j) => {
              const v = jobVerdict(j);
              return (
                <li
                  key={j.id}
                  className="flex items-center gap-2 rounded-[8px] border border-nb-line px-2.5 py-1.5 text-[11.5px]"
                  title={j.last_error ?? undefined}
                >
                  <span className="truncate text-nb-soft">
                    {j.created_at ? new Date(String(j.created_at)).toLocaleString() : "—"}
                  </span>
                  <span className={`ml-auto shrink-0 ${TONE[v.tone]}`}>{v.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* The one act that is not ours. Said plainly rather than left as a missing
          button somebody hunts for. */}
      <p className="text-[11.5px] text-nb-faint">
        Recovering footage and changing the archive schedule are the recorder&apos;s to do — they
        decide where footage lives, which is {node.name}&apos;s own call. Open its console to start
        a restore.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-[8px] border border-nb-line px-2.5 py-2">
      <span className="block text-[10.5px] uppercase tracking-[1px] text-nb-faint">{label}</span>
      <span
        className={`block font-mono text-[15px] font-semibold tabular-nums ${
          tone === "warn" ? "text-amber-300" : "text-nb-text"
        }`}
      >
        {value}
      </span>
      {sub && <span className="block text-[10.5px] text-nb-faint">{sub}</span>}
    </div>
  );
}
