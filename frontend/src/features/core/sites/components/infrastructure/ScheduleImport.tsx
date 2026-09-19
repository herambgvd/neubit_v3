"use client";

// I/O SCHEDULE IMPORT — an .xlsx into systems, equipment and slots.
//
// Two presses, never one. The first sends the file with `dry_run=true` and
// renders the plan: every system (new or reused), every piece of equipment with
// its slots, and every refused row with its sheet row number and the server's
// reason. Only that plan carries the apply button, and applying sends the SAME
// file with `dry_run=false` — the server writes exactly the plan a dry run of it
// shows, in one commit. Choosing another file discards the plan, so the rows on
// screen and the file that would be written can never be two different things.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton } from "@/components/console";
import { Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { InfraImportReport } from "@/lib/types";

import type { VocabIndex } from "./vocabulary";

export interface ScheduleImportProps {
  siteId: string;
  ix: VocabIndex;
  onClose: () => void;
}

const REASON_CLS: Record<string, string> = {
  invalid: "border-[rgba(248,113,113,.45)] text-nb-crit",
  ambiguous: "border-[rgba(251,191,36,.45)] text-nb-warn",
  conflict: "border-[rgba(251,191,36,.45)] text-nb-warn",
  exists: "border-nb-line text-nb-soft",
  duplicate: "border-nb-line text-nb-faint",
};

export default function ScheduleImport({ siteId, ix, onClose }: Readonly<ScheduleImportProps>) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<InfraImportReport | null>(null);
  const [done, setDone] = useState<InfraImportReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: (f: File) => siteInfrastructure.importSchedule(siteId, f, true),
    onSuccess: (r) => {
      setErr(null);
      setPlan(r);
    },
    onError: (e) => {
      setPlan(null);
      setErr(apiError(e, "Could not read the schedule"));
    },
  });

  const apply = useMutation({
    mutationFn: (f: File) => siteInfrastructure.importSchedule(siteId, f, false),
    onSuccess: (r) => {
      setErr(null);
      setPlan(null);
      setDone(r);
      qc.invalidateQueries({ queryKey: ["infra-tree", siteId] });
    },
    onError: (e) => setErr(apiError(e, "Could not apply the schedule")),
  });

  const writes = plan ? plan.counts.systems_created + plan.counts.equipment_created + plan.counts.slots_created : 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      title="Import I/O schedule"
      subtitle="Sheet Equipment_Schedule, one row per slot"
      footer={
        done ? (
          <ActionButton onClick={onClose}>Done</ActionButton>
        ) : (
          <>
            <QuietButton onClick={onClose}>Cancel</QuietButton>
            {plan && file ? (
              <ActionButton disabled={apply.isPending || writes === 0} onClick={() => apply.mutate(file)}>
                {apply.isPending
                  ? "Applying…"
                  : `Apply: ${plan.counts.equipment_created} equipment, ${plan.counts.slots_created} slot(s)`}
              </ActionButton>
            ) : (
              <ActionButton disabled={!file || preview.isPending} onClick={() => file && preview.mutate(file)}>
                {preview.isPending ? "Reading…" : "Preview"}
              </ActionButton>
            )}
          </>
        )
      }
    >
      <div className="space-y-3">
        {!done && (
          <label className="block text-[12px] text-nb-soft">
            Schedule file (.xlsx)
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="mt-1 block w-full text-[12px] text-nb-soft file:mr-3 file:rounded-[6px] file:border file:border-nb-line file:bg-transparent file:px-2 file:py-1 file:text-nb-ink"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPlan(null); // a plan belongs to the file it was read from
                setErr(null);
              }}
            />
          </label>
        )}

        {err && (
          <p role="alert" className="text-[12px] text-nb-crit">
            {err}
          </p>
        )}

        {plan && <Plan report={plan} ix={ix} title="Nothing has been written. Applying creates:" />}
        {done && <Plan report={done} ix={ix} title="Written:" />}
      </div>
    </Modal>
  );
}

function Plan({ report, ix, title }: Readonly<{ report: InfraImportReport; ix: VocabIndex; title: string }>) {
  const c = report.counts;
  return (
    <div className="space-y-3" data-testid="import-plan">
      <p className="text-[12px] text-nb-ink">{title}</p>
      <div className="flex flex-wrap gap-2 font-mono text-[11px]">
        <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">{c.systems_created} new system(s)</span>
        <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">{c.equipment_created} equipment</span>
        <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">{c.slots_created} slot(s)</span>
        <span
          className={`rounded-[6px] border px-2 py-0.5 ${c.rows_skipped ? "border-[rgba(251,191,36,.45)] text-nb-warn" : "border-nb-line text-nb-faint"}`}
        >
          {c.rows_skipped} row(s) skipped
        </span>
        <span className="px-1 py-0.5 text-nb-faint" title={report.ignored_columns.length ? `Ignored columns: ${report.ignored_columns.join(", ")}` : undefined}>
          {report.rows_read} row(s) read
        </span>
      </div>

      {report.systems.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {report.systems.map((s) => (
            <li key={s.name} className="rounded-[6px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-soft">
              {s.name} · {ix.kinds.get(s.kind)?.label ?? s.kind} ·{" "}
              <span className={s.reused ? "text-nb-faint" : "text-nb-good"}>{s.reused ? "existing" : "new"}</span>
            </li>
          ))}
        </ul>
      )}

      {report.equipment.length > 0 && (
        <table className="w-full text-left text-[11.5px]">
          <thead className="text-[10px] uppercase tracking-[1px] text-nb-faint">
            <tr>
              <th className="py-1 font-medium">Tag</th>
              <th className="py-1 font-medium">Class</th>
              <th className="py-1 font-medium">System</th>
              <th className="py-1 font-medium">Slots</th>
              <th className="py-1 font-medium">Rows</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nb-line">
            {report.equipment.map((e) => (
              <tr key={e.tag}>
                <td className="py-1 font-mono text-nb-ink">{e.tag}</td>
                <td className="py-1 text-nb-soft">{ix.classes.get(e.equipment_class)?.label ?? e.equipment_class}</td>
                <td className="py-1 text-nb-soft">{e.system}</td>
                <td className="py-1 font-mono text-nb-soft">
                  {e.slots.length
                    ? e.slots.map((s) => (s.device_tag ? `${s.slot}→${s.device_tag}/${s.point_tag}` : `${s.slot} (unbound)`)).join(", ")
                    : "—"}
                </td>
                <td className="py-1 font-mono text-nb-faint">{e.rows.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.skipped.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-muted">Skipped</p>
          <ul className="space-y-1" aria-label="Skipped rows">
            {report.skipped.map((s, i) => (
              <li key={`${s.row}-${s.slot ?? ""}-${i}`} className="flex items-start gap-2 text-[11.5px]">
                <span className="w-14 shrink-0 font-mono text-nb-faint">row {s.row}</span>
                <span className={`shrink-0 rounded-full border px-1.5 text-[10px] ${REASON_CLS[s.reason] ?? REASON_CLS.exists}`}>
                  {s.reason}
                </span>
                <span className="shrink-0 font-mono text-nb-soft">
                  {s.equipment_tag ?? "—"}
                  {s.slot ? `.${s.slot}` : ""}
                </span>
                <span className="text-nb-soft">{s.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
