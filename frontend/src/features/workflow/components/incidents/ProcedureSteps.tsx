"use client";

// THE PROCEDURE, AS THE WORK RATHER THAN AS A DIAGRAM.
//
// A SOP is a state graph somebody drew in a config screen, and until now that is
// where it stayed: the alarm showed a status word and the graph was somewhere
// else. Here it is the middle of the console — the steps in order, which one the
// alarm is on, and the moves available FROM it as buttons.
//
// The buttons are the SOP's own transitions, fetched per alarm, so they are
// exactly the moves that procedure allows from exactly this state. A transition
// the procedure marks `requires_note` asks for one before it will run — the note
// is the account of what happened, and an incident closed without one teaches
// nobody anything later.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { workflow as wfApi } from "../../api";
import type { InstancePublic, StatePublic, TransitionPublic } from "../../types";
import { isTerminal } from "./lib";

export interface ProcedureStepsProps {
  incident: InstancePublic | null;
  onDone?: () => void;
}

/** Where the alarm is in the ordered list of steps. -1 when the state is not one
 *  of them (a SOP edited after this alarm started), which is a real case: the
 *  steps still render, none is marked current, and nothing pretends otherwise. */
export function currentStepIndex(states: StatePublic[], incident: InstancePublic | null): number {
  if (!incident) return -1;
  return states.findIndex(
    (s) => s.state_id === incident.current_state || s.name === incident.current_state_name,
  );
}

/** The steps an operator reads: the SOP's states in their authored order, with
 *  the cancellation branch left out of the LINE — "Dismissed" is not step four of
 *  four, it is a way off the path, and drawing it inline makes the procedure look
 *  longer than it is. It stays reachable through the transitions below. */
export function orderedSteps(states: StatePublic[]): StatePublic[] {
  return [...states]
    .filter((s) => !s.is_cancellation)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export default function ProcedureSteps({ incident, onDone }: ProcedureStepsProps) {
  const qc = useQueryClient();
  const [pendingNote, setPendingNote] = useState<TransitionPublic | null>(null);
  const [note, setNote] = useState("");

  const statesQ = useQuery({
    queryKey: ["wf-states", incident?.sop_id],
    queryFn: () => wfApi.states.list(incident!.sop_id),
    enabled: !!incident?.sop_id,
    staleTime: 60_000,
  });
  const transitionsQ = useQuery({
    queryKey: ["wf-available-transitions", incident?.instance_id],
    queryFn: () => wfApi.instances.availableTransitions(incident!.instance_id),
    enabled: !!incident?.instance_id && !isTerminal(incident?.status),
    retry: false,
  });

  const states = orderedSteps(statesQ.data || []);
  const moves = transitionsQ.data || [];
  const at = currentStepIndex(states, incident);

  const run = useMutation({
    mutationFn: ({ t, notes }: { t: TransitionPublic; notes?: string }) =>
      wfApi.instances.transition(incident!.instance_id, {
        transition_id: t.transition_id,
        notes: notes || null,
      }),
    onSuccess: (_res, { t }) => {
      toast.success(t.label);
      setPendingNote(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      qc.invalidateQueries({ queryKey: ["wf-available-transitions"] });
      qc.invalidateQueries({ queryKey: ["wf-stats"] });
      onDone?.();
    },
    onError: (e) => toast.error(apiError(e, "Could not move the alarm on")),
  });

  const start = (t: TransitionPublic) => {
    if (t.requires_note) {
      setPendingNote(t);
      setNote("");
      return;
    }
    run.mutate({ t });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Procedure</span>
        {incident?.sop_name && (
          <span className="truncate text-[11px] text-muted">· {incident.sop_name}</span>
        )}
      </div>

      {!incident ? (
        <p className="mt-3 text-[12px] text-muted">Pick an alarm to see the steps it runs through.</p>
      ) : (
        <>
          <ol className="mt-2.5 grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto">
            {states.length === 0 && !statesQ.isLoading && (
              <li className="text-[12px] text-muted">
                This procedure has no steps defined — it can be worked, but nothing here says how.
              </li>
            )}
            {states.map((s, i) => {
              const done = at >= 0 && i < at;
              const current = at === i;
              return (
                <li key={s.state_id} className="flex items-start gap-2 text-[12px]">
                  <span
                    className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full border ${
                      done
                        ? "border-emerald-500 bg-emerald-500"
                        : current
                          ? "border-blue-400 bg-blue-400"
                          : "border-card-border"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className={current ? "text-foreground" : done ? "text-muted" : "text-muted/80"}>
                      {s.name}
                    </span>
                    {current && s.description && (
                      <span className="block text-[11px] text-muted">{s.description}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          {pendingNote ? (
            // The note is not optional decoration: this transition asked for it.
            <div className="mt-2 grid gap-1.5 border-t border-card-border pt-2">
              <label className="text-[11px] text-muted" htmlFor="transition-note">
                {pendingNote.label} — say what happened
              </label>
              <textarea
                id="transition-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-field bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-hidden focus:border-muted"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={!note.trim() || run.isPending}
                  onClick={() => run.mutate({ t: pendingNote, notes: note.trim() })}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <Icon icon="heroicons-outline:check" className="text-xs" /> {pendingNote.label}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingNote(null)}
                  className="rounded-md border border-card-border px-2.5 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            moves.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-card-border pt-2">
                {moves.map((t) => (
                  <button
                    key={t.transition_id}
                    type="button"
                    onClick={() => start(t)}
                    disabled={run.isPending}
                    title={t.description || undefined}
                    className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-[11.5px] font-medium text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50"
                  >
                    {t.label}
                    {t.requires_note && (
                      <Icon icon="heroicons-outline:pencil-square" className="text-[11px] opacity-70" />
                    )}
                  </button>
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
