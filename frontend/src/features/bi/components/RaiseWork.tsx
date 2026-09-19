"use client";

// GATE 6 · ACTS — the press that turns a finding into work.
//
// WHAT THIS COMPONENT DOES NOT DO. It does not write the ticket. The reading
// store composed `finding.work` — the name, the description and the evidence
// envelope — out of the same outcome the screen is showing, and this modal posts
// that block back with one field added: the procedure a person chose. A console
// that composed its own sentence would be a second author of the evidence, and
// the two would drift the first time a metric's wording changed.
//
// 201 AND 200 ARE DIFFERENT ANSWERS AND THE OPERATOR IS TOLD WHICH. Every
// finding carries a stable `source_key` naming WHAT it is about, and the
// workflow service allows one OPEN incident per key. So a second raise does not
// fail and does not duplicate: it returns the incident that is already open. An
// operator who is not told that would think they had just raised something.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton } from "@/components/console";
import { Modal, Select } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { workflow } from "@/features/workflow/api";
import type { SopPublic } from "@/features/workflow/types";

import type { Finding } from "../findings";

export const PERM_RAISE = "workflow.instance.create";
/** Installing playbooks is creating SOPs, and is gated as such. */
export const PERM_INSTALL = "workflow.sop.create";

/** A SOP that names this kind of finding in its triggers is the one meant for
 *  it, so it is offered first. Nothing is auto-selected beyond that ordering —
 *  the procedure is the operator's decision, and it is the only one they make. */
export function rankSops(sops: SopPublic[], eventType: string | undefined): SopPublic[] {
  const named = (s: SopPublic) => (eventType ? (s.trigger_event_types || []).includes(eventType) : false);
  return sops
    .slice()
    .sort((a, b) => Number(named(b)) - Number(named(a)) || a.name.localeCompare(b.name));
}

/** The `type` the store put in the envelope, e.g. `bi.finding.equipment_metric`. */
export const eventTypeOf = (f: Finding): string | undefined => {
  const t = (f.work?.trigger_data as any)?.type;
  return typeof t === "string" ? t : undefined;
};

export default function RaiseWork({
  finding,
  open,
  onClose,
}: Readonly<{ finding: Finding; open: boolean; onClose: () => void }>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sopId, setSopId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: boolean; id: string; name: string | null } | null>(null);

  const mayRaise = can(PERM_RAISE);
  const sopsQ = useQuery<any>({
    queryKey: ["workflow-sops"],
    queryFn: () => workflow.sops.list({ limit: 200 }),
    enabled: open && mayRaise,
  });
  const sops: SopPublic[] = rankSops(sopsQ.data?.items ?? [], eventTypeOf(finding));

  // The dead end, answered. Raising work REQUIRES a procedure, so a deployment
  // with none opens an empty select and stops. The building set only: a tenant
  // that never bought the recorder has no use for camera tamper.
  const install = useMutation({
    mutationFn: () => workflow.sops.installStarters("bi"),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["workflow-sops"] });
    },
    onError: (e) => setErr(apiError(e, "Could not install the building playbooks")),
  });
  const noProcedures = !sopsQ.isLoading && !sopsQ.isError && sops.length === 0;

  const raise = useMutation({
    mutationFn: () => workflow.instances.raise({ ...(finding.work as any), sop_id: sopId }),
    onSuccess: (r) => {
      setDone({ created: r.created, id: r.instance.instance_id, name: r.instance.name });
      // The gate's counts and the worklist both read who has open work.
      qc.invalidateQueries({ queryKey: ["bi-open-work"] });
      qc.invalidateQueries({ queryKey: ["workflow-instances"] });
    },
    onError: (e) => setErr(apiError(e, "Could not raise work")),
  });

  function close() {
    setDone(null);
    setErr(null);
    setSopId("");
    onClose();
  }

  if (done) {
    return (
      <Modal
        open={open}
        onClose={close}
        title={done.created ? "Work raised" : "Already open"}
        footer={<ActionButton onClick={close}>Done</ActionButton>}
      >
        <p className="text-sm">
          {done.created ? (
            <>
              Raised <span className="font-medium">{done.name || finding.work.name}</span>. The evidence went with it.
            </>
          ) : (
            <>
              Work was already open about this finding — <span className="font-medium">{done.name || finding.work.name}</span>.
              Nothing was raised a second time.
            </>
          )}
        </p>
        <a className="mt-3 inline-flex items-center gap-1 text-sm text-nb-accent hover:underline"
           href={`/workflow/incidents?instance=${done.id}`}>
          Open the incident ↗
        </a>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Raise work"
      size="wide"
      staticBackdrop
      footer={
        <>
          <QuietButton onClick={close}>Cancel</QuietButton>
          <ActionButton onClick={() => raise.mutate()} disabled={!sopId || raise.isPending}>
            {raise.isPending ? "Raising…" : sopId ? "Raise work" : "Choose a procedure"}
          </ActionButton>
        </>
      }
    >
      <div className="grid gap-3">
        <Select
          label="Procedure"
          required
          placeholder={sopsQ.isLoading ? "Loading…" : "Choose a procedure"}
          value={sopId}
          onChange={(e) => setSopId(e.target.value)}
          options={sops.map((s) => ({ value: s.sop_id, label: s.name }))}
        />
        {noProcedures && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200/90">
            <p className="font-medium text-amber-200">No procedures yet</p>
            <p className="mt-1">
              Work runs a procedure — which states it moves through, how long it may
              take. There are none on this system yet.
            </p>
            {can(PERM_INSTALL) ? (
              <QuietButton className="mt-2" onClick={() => install.mutate()} disabled={install.isPending}>
                {install.isPending ? "Installing…" : "Install the building playbooks"}
              </QuietButton>
            ) : (
              <p className="mt-1">Needs {PERM_INSTALL}.</p>
            )}
          </div>
        )}
        {/* What travels, in the store's own words. Read before pressing, not after. */}
        <div className="rounded-lg border border-nb-line bg-nb-sunk p-3">
          <div className="text-[11px] font-mono uppercase tracking-wider text-nb-muted">
            Goes with it
          </div>
          <p className="mt-1 text-sm font-medium">{finding.work.name}</p>
          <p className="mt-1 whitespace-pre-line text-xs text-nb-muted">{finding.work.description}</p>
          <p className="mt-2 font-mono text-[11px] text-nb-muted" title={finding.source_key}>
            {finding.source_key}
          </p>
        </div>
        {err ? <p className="text-sm text-nb-crit">{err}</p> : null}
      </div>
    </Modal>
  );
}
