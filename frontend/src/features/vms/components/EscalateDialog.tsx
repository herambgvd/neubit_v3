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
import type { CreateTriggerRequest, SopPublic, TriggerPublic } from "@/features/workflow/types";
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

/** How wide a rule reaches: this one camera, or every camera on the estate. */
export type AutomationScope = "camera" | "estate";

/** The camera-id field a condition addresses, as the correlation engine walks it
 *  (a dotted path into the published envelope). */
export const CAMERA_FIELD = "payload.camera_id";

/** At most one alarm per hour for the same thing, so a burst of motion from one
 *  camera is one incident and not forty. */
export const AUTOMATION_WINDOW_SECONDS = 3600;

/** The rule an operator gets when they say "do this next time".
 *
 *  It matches on the event's own type: the bus publishes `type` as
 *  `vms.camera.<event_type>` AND `payload.event_type` as the bare type, and the
 *  correlation engine matches a trigger against either — so "tamper" is the
 *  value that reads correctly in the rules list and still fires.
 *
 *  Scope is the whole difference between the two answers an operator can give,
 *  and it is a CONDITION, not a different kind of rule: one camera adds
 *  `payload.camera_id eq <id>`, the estate adds nothing. */
export function automationRule(
  event: NormalizedVmsEvent,
  sop: SopPublic,
  scope: AutomationScope,
  cameraLabel: string,
): CreateTriggerRequest {
  const type = event.event_type || "";
  const perCamera = scope === "camera" && !!event.camera_id;
  return {
    name: perCamera
      ? `Auto: ${eventTypeLabel(type)} on ${cameraLabel}`
      : `Auto: ${eventTypeLabel(type)} (any camera)`,
    description: "Created from an escalated event — raise this alarm automatically.",
    sop_id: sop.sop_id,
    event_source: "vision",
    event_type: type,
    conditions: perCamera
      ? [{ field: CAMERA_FIELD, operator: "eq", value: event.camera_id as string }]
      : [],
    dedup: perCamera
      ? { strategy: "per_field", key_field: CAMERA_FIELD, window_seconds: AUTOMATION_WINDOW_SECONDS }
      : { strategy: "per_event_type", key_field: null, window_seconds: AUTOMATION_WINDOW_SECONDS },
    priority: sop.priority,
    enabled: true,
  };
}

/** Is this event already handled by a rule? A second rule for the same type and
 *  camera would raise two alarms for one event, which is how an operator learns
 *  to distrust the queue. */
export function existingRuleFor(
  triggers: TriggerPublic[],
  event: NormalizedVmsEvent,
): TriggerPublic | null {
  const type = String(event.event_type || "").toLowerCase();
  const cam = event.camera_id || null;
  return (
    triggers.find((t) => {
      if (!t.enabled) return false;
      const tType = String(t.event_type || "").toLowerCase();
      if (tType && tType !== type && tType !== `vms.camera.${type}`) return false;
      const camConds = (t.conditions || []).filter((c) => c.field === CAMERA_FIELD);
      // No camera condition = every camera, which covers this one too.
      if (camConds.length === 0) return true;
      return camConds.some((c) => c.value === cam);
    }) || null
  );
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
  // TWO STEPS, ONE DIALOG. The alarm is raised on the first; the second asks
  // whether it should happen by itself next time. It is a second step rather than
  // a toast because the answer has three options, and because the moment an
  // operator has just decided this event matters is the only moment they know.
  const [raised, setRaised] = useState<{ id: string; name: string } | null>(null);

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
    if (!open) {
      setNote("");
      setRaised(null);
    }
  }, [open]);

  const triggersQ = useQuery({
    queryKey: ["wf-triggers", "escalate"],
    queryFn: () => wfApi.triggers.list({ limit: 200 }),
    enabled: open && !!raised,
    retry: false,
  });
  const triggers = useMemo<TriggerPublic[]>(
    () => (triggersQ.data ? asItems(triggersQ.data) : []),
    [triggersQ.data],
  );
  const alreadyAutomatic = useMemo(
    () => (raised ? existingRuleFor(triggers, event) : null),
    [raised, triggers, event],
  );

  const automate = useMutation({
    mutationFn: (scope: AutomationScope) => {
      const chosen = sops.find((s) => s.sop_id === sopId);
      if (!chosen) throw new Error("no procedure selected");
      return wfApi.triggers.create(
        automationRule(event, chosen, scope, cameraName || event.camera_name || "this camera"),
      );
    },
    onSuccess: (t) => {
      toast.success("Rule created", { description: t.name });
      qc.invalidateQueries({ queryKey: ["wf-triggers"] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e, "Could not create the rule")),
  });

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
      // The alarm exists either way; the second step is an offer, never a gate.
      if (canAutomate) setRaised({ id: inc.instance_id, name: inc.name || "Alarm" });
      else onClose();
    },
    onError: (e) => toast.error(apiError(e, "Could not raise the alarm")),
  });

  const chosen = sops.find((s) => s.sop_id === sopId) || null;
  const loading = sopsQ.isLoading;
  const empty = !loading && sops.length === 0;
  const canInstall = can("workflow.sop.create");
  const canAutomate = can("workflow.trigger.create");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={raised ? "Alarm raised" : "Escalate to an alarm"}
      subtitle={
        raised
          ? "It is on the Alarms board now."
          : "Pick the procedure to run. Its priority and time limit come with it."
      }
      footer={
        raised ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-card-border px-3 py-1.5 text-[12px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            Done
          </button>
        ) : (
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
        )
      }
    >
      {raised ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-[12.5px] text-foreground">
            <Icon icon="heroicons-outline:check-circle" className="text-base text-emerald-400" />
            <span className="truncate">{raised.name}</span>
          </p>

          {/* THE SECOND HALF OF AUTOMATION. The correlation engine has been
              listening the whole time; what it lacks is a rule. This is where
              rules come from — a person who has just decided, about a real event,
              rather than a configuration session nobody books. */}
          {alreadyAutomatic ? (
            <div className="rounded-lg border border-card-border bg-hover/40 p-3">
              <p className="text-[12px] text-foreground">This already happens automatically</p>
              <p className="mt-1 text-[11.5px] text-muted">
                The rule <b className="text-foreground">{alreadyAutomatic.name}</b> covers events
                like this one, so the next will raise its own alarm.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
              <p className="text-[12.5px] font-medium text-blue-200">Do this by itself next time?</p>
              <p className="mt-1 text-[11.5px] text-blue-200/80">
                A rule raises the same alarm without waiting for anyone — at most one
                an hour, so a burst is one alarm and not forty.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {event.camera_id && (
                  <button
                    type="button"
                    onClick={() => automate.mutate("camera")}
                    disabled={automate.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/15 px-2.5 py-1 text-[11.5px] font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
                  >
                    <Icon icon="heroicons-outline:video-camera" className="text-xs" />
                    Only {cameraName || event.camera_name || "this camera"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => automate.mutate("estate")}
                  disabled={automate.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/15 px-2.5 py-1 text-[11.5px] font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
                >
                  <Icon icon="heroicons-outline:building-office-2" className="text-xs" />
                  Every camera
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center rounded-md border border-card-border px-2.5 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
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
      )}
    </Modal>
  );
}
