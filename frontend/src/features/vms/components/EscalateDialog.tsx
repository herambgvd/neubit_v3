"use client";

// ESCALATE AN EVENT INTO AN ALARM.
//
// The two surfaces do different jobs. Events is the LEDGER — what the recorders
// reported, high volume, look and move on. Alarms is the WORK — the things a
// person must do, with a procedure, an owner, a deadline and an outcome. This
// dialog is the door between them, and an operator standing at it has already
// decided; what is left is choosing which procedure to run.
//
// So it asks for one thing (the playbook) and shows one thing (what is being
// escalated, so somebody who came from a corner toast can see what they grabbed).
// Priority and the SLA clock come from the SOP — asking the operator to set them
// per incident is asking them to re-decide, mid-incident, what the procedure
// already decided.
//
// THE PICKER RANKS ITSELF. A SOP lists the event types it answers to; the one
// that names THIS event's type goes to the top, marked. The common case becomes a
// single click, and the uncommon case is still the whole list.
//
// AN EMPTY PICKER IS A DEAD END, and a fresh deployment has exactly that: zero
// SOPs. So when there are none, the dialog offers to install the starter
// playbooks rather than showing an empty select and a disabled button.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { workflow as wfApi } from "@/features/workflow/api";
import type { SopPublic } from "@/features/workflow/types";
import { eventTypeLabel, fmtDate, fmtTime, sevPreset, type NormalizedVmsEvent } from "../eventLib";

export interface EscalateDialogProps {
  open: boolean;
  onClose: () => void;
  event: NormalizedVmsEvent;
  cameraName?: string | null;
  recorderName?: string | null;
  /** The recorder-side node id, carried into the envelope so an incident can be
   *  traced back to the machine that reported it. */
  nodeId?: string | null;
  /** Called with the new incident id once it exists. */
  onCreated?: (instanceId: string) => void;
}

/** The envelope. It is the SAME shape the bus publishes for a camera event, and
 *  that is not cosmetic: the backend derives `event_source` and `source_event_id`
 *  from `{source, payload.event_id}`, which is what powers the Source filter, the
 *  link back from this event, and the camera + instant on the alarm card. A
 *  different shape still SAVES — it just arrives with all of that missing. */
export function escalationEnvelope(
  event: NormalizedVmsEvent,
  extras: { cameraName?: string | null; recorderName?: string | null; nodeId?: string | null } = {},
): Record<string, unknown> {
  const eventId = event.event_id || event.id || null;
  return {
    source: "vision",
    // How it got here, said plainly: this incident exists because a person
    // decided, not because a rule matched.
    raised_by: "operator",
    payload: {
      event_id: eventId,
      camera_id: event.camera_id ?? null,
      camera_name: extras.cameraName ?? event.camera_name ?? null,
      node_id: extras.nodeId ?? null,
      node_name: extras.recorderName ?? null,
      event_type: event.event_type ?? null,
      severity: event.severity ?? null,
      occurred_at: event.occurred_at ?? null,
    },
  };
}

/** SOPs, most relevant first: the ones naming this event's type, then the rest.
 *  Stable inside each group (the server's order), so the list does not reshuffle
 *  between openings. */
export function rankSops(sops: SopPublic[], eventType: string | null | undefined): SopPublic[] {
  const t = String(eventType || "").toLowerCase();
  const matches = (s: SopPublic) =>
    !!t && (s.trigger_event_types || []).some((e) => String(e).toLowerCase() === t);
  return [...sops.filter(matches), ...sops.filter((s) => !matches(s))];
}

export function sopMatches(sop: SopPublic, eventType: string | null | undefined): boolean {
  const t = String(eventType || "").toLowerCase();
  return !!t && (sop.trigger_event_types || []).some((e) => String(e).toLowerCase() === t);
}

export default function EscalateDialog({
  open,
  onClose,
  event,
  cameraName = null,
  recorderName = null,
  nodeId = null,
  onCreated,
}: EscalateDialogProps) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [sopId, setSopId] = useState("");
  const [note, setNote] = useState("");

  // Only while the dialog is open: an operator who never escalates should not be
  // fetching the playbook list on every visit to the Events page.
  const sopsQ = useQuery({
    queryKey: ["wf-sops", "escalate"],
    queryFn: () => wfApi.sops.list({ limit: 200, is_active: true }),
    enabled: open,
  });
  const sops = useMemo<SopPublic[]>(() => (sopsQ.data ? asItems(sopsQ.data) : []), [sopsQ.data]);
  const ranked = useMemo(() => rankSops(sops, event.event_type), [sops, event.event_type]);

  // The best guess is pre-selected, not merely listed first — one click for the
  // ordinary case. Re-runs when the list arrives, and when a different event is
  // escalated from the same mounted dialog.
  useEffect(() => {
    if (!open) return;
    setSopId((current) => (current && ranked.some((s) => s.sop_id === current) ? current : ranked[0]?.sop_id || ""));
  }, [open, ranked]);

  useEffect(() => {
    if (!open) setNote("");
  }, [open]);

  const install = useMutation({
    mutationFn: () => wfApi.sops.installStarters(),
    onSuccess: (res) => {
      toast.success(
        res.created > 0
          ? `${res.created} starter playbook${res.created === 1 ? "" : "s"} installed`
          : "The starter playbooks were already installed",
      );
      qc.invalidateQueries({ queryKey: ["wf-sops"] });
    },
    onError: (e) => toast.error(apiError(e, "Could not install the starter playbooks")),
  });

  const create = useMutation({
    mutationFn: () => {
      const chosen = sops.find((s) => s.sop_id === sopId);
      return wfApi.instances.create({
        sop_id: sopId,
        name: `${eventTypeLabel(event.event_type)} · ${cameraName || event.camera_name || "camera"}`,
        description: note.trim() || chosen?.description || null,
        trigger_data: escalationEnvelope(event, { cameraName, recorderName, nodeId }),
        event_id: event.event_id || event.id || null,
        event_type: event.event_type || null,
      });
    },
    onSuccess: (inc) => {
      toast.success("Alarm raised", { description: inc.name });
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      qc.invalidateQueries({ queryKey: ["wf-incidents-by-camera-event"] });
      onCreated?.(inc.instance_id);
      onClose();
    },
    onError: (e) => toast.error(apiError(e, "Could not raise the alarm")),
  });

  const chosen = sops.find((s) => s.sop_id === sopId) || null;
  const loading = sopsQ.isLoading;
  const empty = !loading && sops.length === 0;
  const canInstall = can("workflow.sop.create");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Escalate to an alarm"
      subtitle="Pick the procedure to run. Its priority and time limit come with it."
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-card-border px-3 py-1.5 text-[12px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!sopId || create.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/50 bg-orange-500/15 px-3 py-1.5 text-[12px] font-medium text-orange-200 transition hover:bg-orange-500/25 disabled:opacity-50"
          >
            {create.isPending ? (
              <Icon icon="svg-spinners:180-ring" className="text-sm" />
            ) : (
              <Icon icon="heroicons-outline:arrow-trending-up" className="text-sm" />
            )}
            Raise alarm
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* WHAT IS BEING ESCALATED. An operator who arrived from a corner toast
            has not read the row; this is the last chance to see it. */}
        <div className="rounded-lg border border-card-border bg-hover/40 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground">
              {eventTypeLabel(event.event_type)}
            </span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sevPreset(event.severity).cls}`}
            >
              {sevPreset(event.severity).label}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-foreground/90">
            {cameraName || event.camera_name || "Unnamed camera"}
            {recorderName && <span className="text-muted"> · {recorderName}</span>}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-muted">
            {fmtTime(event.occurred_at)} · {fmtDate(event.occurred_at)}
          </p>
        </div>

        {loading && (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading playbooks…
          </p>
        )}

        {empty ? (
          // The dead end, answered. A deployment with no SOP cannot raise an
          // alarm at all — saying so, with the way out, beats an empty select.
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-[12.5px] font-medium text-amber-200">No procedures yet</p>
            <p className="mt-1 text-[11.5px] text-amber-200/80">
              An alarm runs a procedure — which states it moves through, how long it
              may take. There are none on this system yet.
            </p>
            {canInstall ? (
              <button
                type="button"
                onClick={() => install.mutate()}
                disabled={install.isPending}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
              >
                {install.isPending ? (
                  <Icon icon="svg-spinners:180-ring" className="text-xs" />
                ) : (
                  <Icon icon="heroicons-outline:sparkles" className="text-xs" />
                )}
                Install the starter playbooks
              </button>
            ) : (
              <p className="mt-2 text-[11.5px] text-amber-200/80">
                Ask an administrator to add one under Workflow configuration.
              </p>
            )}
          </div>
        ) : (
          !loading && (
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted">Procedure</span>
              <div className="max-h-48 space-y-1.5 overflow-y-auto pr-0.5">
                {ranked.map((s) => {
                  const match = sopMatches(s, event.event_type);
                  const active = s.sop_id === sopId;
                  return (
                    <button
                      key={s.sop_id}
                      type="button"
                      onClick={() => setSopId(s.sop_id)}
                      aria-pressed={active}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                        active
                          ? "border-blue-500/50 bg-blue-500/10"
                          : "border-card-border hover:bg-hover"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium text-foreground">{s.name}</span>
                        {match && (
                          <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
                            matches this event
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">
                          {s.priority}
                          {s.sla_hours ? ` · ${s.sla_hours}h` : ""}
                        </span>
                      </span>
                      {s.description && (
                        <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted">{s.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )
        )}

        {!empty && !loading && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted">
              Note <span className="text-muted/70">(optional — what you saw)</span>
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. lens covered, view is grey since 10:12"
              className="w-full rounded-lg border border-field bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-hidden focus:border-muted"
            />
          </label>
        )}

        {chosen && (
          <p className="text-[11px] text-muted">
            Raising this puts the alarm in <b className="text-foreground">{chosen.name}</b> at{" "}
            <b className="text-foreground">{chosen.priority}</b> priority
            {chosen.sla_hours ? <> with <b className="text-foreground">{chosen.sla_hours}h</b> to close it</> : null}.
            The event is marked acknowledged — it is somebody&apos;s work now.
          </p>
        )}
      </div>
    </Modal>
  );
}
