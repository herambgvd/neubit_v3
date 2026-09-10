"use client";

// ONE ALARM, AS THE RECORD OF IT — the case file behind a row on /alarms.
//
// The queue screen answers "what now". This page answers what outlives the shift:
// what happened, what was done about it, by whom, on what evidence. It is where
// somebody reconstructs an incident a week later, and where the PDF an
// investigation asks for comes from.
//
// SO IT IS A DOCUMENT, not a dashboard. A masthead carrying the four facts that
// identify the case, then plain sections in the order a reader needs them —
// Evidence, Procedure, Log, Close out, and the raw event last. The first attempt
// at this page was the queue's bento again with more fields in it, which is why
// it read as a repeat rather than as the record.
//
// The shape is deliberate: what an operator reads here and what an investigator
// receives as a PDF should be the same artefact, so the screen can hide nothing
// the export would have to invent.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems, fmtDateTime } from "@/lib/format";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import type { EstateCamera } from "@/features/vms/types";
import { workflow as wfApi } from "./api";
import type { FormPublic, InstanceStatus, StatePublic, TransitionPublic } from "./types";
import { EvidencePicture } from "./components/incidents/AlarmEvidence";
import { originOf } from "./components/incidents/AlarmFacts";
import { currentStepIndex, orderedSteps } from "./components/incidents/ProcedureSteps";
import {
  incCameraId,
  incEventTime,
  incSiteName,
  incTitle,
  isOpen,
  isTerminal,
  sev,
  slaFor,
} from "./components/incidents/lib";
import StateMachine from "./components/detail/StateMachine";
import EventPayloadInspector from "./components/detail/EventPayloadInspector";
import AssignModal from "./components/detail/AssignModal";
import TransitionFormModal from "./components/detail/TransitionFormModal";
import ReasonModal from "./components/detail/ReasonModal";
import type { ReasonAction } from "./components/detail/ReasonModal";

const SLA_TONE: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  breach: "text-red-400",
  done: "text-muted",
};

/** A section of the record: a small caps heading with a rule running off it, then
 *  the content. Plain typography rather than a card — a page of stacked cards
 *  reads as a dashboard, and this is a document. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5">
      <h2 className="flex items-center gap-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-foreground/80">
        {title}
        <span className="h-px flex-1 bg-card-border" aria-hidden />
      </h2>
      {children}
    </section>
  );
}

export default function WorkflowDetailPage() {
  const params = useParams();
  // `[id]` is a single segment; a catch-all would hand back an array.
  const rawId = params?.id;
  const id = (Array.isArray(rawId) ? rawId[0] : rawId) ?? "";
  const qc = useQueryClient();

  const instQ = useQuery({
    queryKey: ["wf-instance", id],
    queryFn: () => wfApi.instances.get(id),
    enabled: !!id,
    refetchInterval: 15000,
  });
  const inst = instQ.data;
  const sopId = inst?.sop_id ?? "";

  const statesQ = useQuery({
    queryKey: ["wf-states", sopId],
    queryFn: () => wfApi.states.list(sopId),
    enabled: !!sopId,
  });
  const transitionsQ = useQuery({
    queryKey: ["wf-transitions", sopId],
    queryFn: () => wfApi.transitions.list(sopId),
    enabled: !!sopId,
  });
  const movesQ = useQuery({
    queryKey: ["wf-available-transitions", id],
    queryFn: () => wfApi.instances.availableTransitions(id),
    enabled: !!id && !!inst && !isTerminal(inst.status),
    retry: false,
  });
  const formsQ = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 200 }) });

  const states = useMemo<StatePublic[]>(() => (statesQ.data ? asItems(statesQ.data) : []), [statesQ.data]);
  const transitions = useMemo<TransitionPublic[]>(
    () => (transitionsQ.data ? asItems(transitionsQ.data) : []),
    [transitionsQ.data],
  );
  const formList = useMemo<FormPublic[]>(() => (formsQ.data ? asItems(formsQ.data) : []), [formsQ.data]);

  // WHAT THIS ALARM CAN DO NEXT, from the server — a transition can carry
  // conditions, and a button the backend would refuse is worse than no button.
  // But a page with NO moves is worse still: when that call fails, fall back to
  // the structurally-legal ones and say so.
  const movesUnavailable = movesQ.isError;
  const moves = useMemo<TransitionPublic[]>(() => {
    if (!movesUnavailable) return movesQ.data || [];
    const here = inst?.current_state;
    return transitions.filter((t) => !here || t.from_state_id === here);
  }, [movesUnavailable, movesQ.data, transitions, inst?.current_state]);

  // A move that ENDS the case belongs under Close out; the rest carry the
  // procedure forward and belong under Procedure. Same list, split by where the
  // move lands, so neither section invents a button the other already owns.
  const endsCase = useMemo(() => {
    const terminal = new Set(
      states.filter((s) => s.is_terminal || s.is_cancellation).map((s) => s.state_id),
    );
    return (t: TransitionPublic) => terminal.has(t.to_state_id);
  }, [states]);
  const closingMoves = moves.filter(endsCase);
  const forwardMoves = moves.filter((t) => !endsCase(t));

  // The camera as the ESTATE knows it — the alarm carries the node-side id the
  // recorder reported, and without the owning recorder there is no session to mint.
  const { cameras } = useEstateCameras();
  const camera = useMemo<EstateCamera | null>(() => {
    const camId = inst ? incCameraId(inst) : null;
    if (!camId) return null;
    return cameras.find((c) => c.id === camId || (c as { real_id?: string }).real_id === camId) ?? null;
  }, [inst, cameras]);

  const [assignOpen, setAssignOpen] = useState(false);
  const [formFor, setFormFor] = useState<TransitionPublic | null>(null);
  const [noteFor, setNoteFor] = useState<TransitionPublic | null>(null);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wf-instance", id] });
    qc.invalidateQueries({ queryKey: ["wf-available-transitions", id] });
    qc.invalidateQueries({ queryKey: ["wf-instances"] });
    qc.invalidateQueries({ queryKey: ["wf-stats"] });
  };

  const doTransition = useMutation({
    mutationFn: (body: {
      transition_id: string;
      notes?: string | null;
      form_data?: Record<string, unknown> | null;
    }) => wfApi.instances.transition(id, body),
    onSuccess: () => {
      toast.success("Alarm moved on");
      setFormFor(null);
      setNoteFor(null);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Could not move the alarm on")),
  });

  const statusMut = useMutation({
    mutationFn: ({ status, outcome }: { status: InstanceStatus; outcome?: string | null }) =>
      wfApi.instances.setStatus(id, status, outcome),
    onSuccess: () => {
      toast.success("Updated");
      setReasonAction(null);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const escalateMut = useMutation({
    mutationFn: (reason: string | null) => wfApi.instances.escalate(id, reason),
    onSuccess: () => {
      toast.success("Escalated");
      setReasonAction(null);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const [pdfPending, setPdfPending] = useState(false);
  const exportPdf = async () => {
    setPdfPending(true);
    try {
      const blob = await wfApi.instances.pdfBlob(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `alarm-${id.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e, "Could not export this alarm"));
    } finally {
      setPdfPending(false);
    }
  };

  const runMove = (t: TransitionPublic) => {
    if (t.form_id) {
      setFormFor(t);
      return;
    }
    if (t.requires_note) {
      setNoteFor(t);
      return;
    }
    doTransition.mutate({ transition_id: t.transition_id });
  };

  if (instQ.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-lg" /> Loading the case…
      </div>
    );
  }

  if (instQ.isError || !inst) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <Icon icon="heroicons:exclamation-triangle" className="mb-3 text-4xl text-muted opacity-60" />
        <p className="font-medium text-foreground">This alarm could not be opened</p>
        <p className="mt-1 text-[12.5px] text-muted">
          {instQ.isError ? apiError(instQ.error, "Unknown error") : "It may have been deleted."}
        </p>
        <Link
          href="/alarms"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-card-border px-3 py-1.5 text-[12px] text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-left" className="text-xs" /> Back to the queue
        </Link>
      </div>
    );
  }

  const s = sev(inst.priority);
  const sla = slaFor(inst);
  const open = isOpen(inst.status);
  const cameraId = incCameraId(inst);
  const eventTime = incEventTime(inst);
  const steps = orderedSteps(states);
  const at = currentStepIndex(steps, inst);
  const trail = [...(inst.timeline || [])].sort((a, b) =>
    String(a.executed_at || "").localeCompare(String(b.executed_at || "")),
  );

  return (
    <article className="grid w-full gap-6 pb-10">
      {/* ── MASTHEAD ───────────────────────────────────────────────────────
          Who this case is, and the moves that are not part of the procedure. A
          document's title block, not a toolbar card. */}
      <header className="grid gap-3 border-b-2 border-card-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/alarms"
            title="Back to the queue"
            aria-label="Back to the queue"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-left" className="text-xs" />
          </Link>
          <span className={`h-6 w-[3px] shrink-0 rounded-full ${s.band}`} aria-hidden />
          <h1 className="min-w-0 truncate text-[22px] font-semibold tracking-[-0.01em] text-foreground">
            {incTitle(inst)}
          </h1>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.soft} ${s.text}`}>
            {s.label}
          </span>
          <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-foreground">
            {inst.current_state_name || inst.status}
          </span>
          <span className="font-mono text-[11px] text-muted">
            case {id.slice(0, 8)} · raised {fmtDateTime(inst.created_at)}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {open && inst.status === "pending" && (
              <button
                type="button"
                onClick={() => statusMut.mutate({ status: "active" })}
                disabled={statusMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
              >
                <Icon icon="heroicons-outline:check" className="text-xs" /> Take it
              </button>
            )}
            {open && (
              <>
                <button
                  type="button"
                  onClick={() => setAssignOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
                >
                  <Icon icon="heroicons-outline:user-plus" className="text-xs" />
                  {inst.assigned_to ? "Reassign" : "Assign"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setReasonAction({
                      title: "Escalate this alarm",
                      verb: "Escalate",
                      run: (reason) => escalateMut.mutate(reason),
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-300 transition hover:bg-amber-500/20"
                >
                  <Icon icon="heroicons-outline:arrow-trending-up" className="text-xs" /> Escalate
                </button>
              </>
            )}
            <button
              type="button"
              onClick={exportPdf}
              disabled={pdfPending}
              title="Export this case as a PDF"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-[11.5px] text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50"
            >
              <Icon
                icon={pdfPending ? "svg-spinners:180-ring" : "heroicons-outline:document-arrow-down"}
                className="text-xs"
              />
              Export PDF
            </button>
            <button
              type="button"
              onClick={() => instQ.refetch()}
              title="Re-read this alarm"
              aria-label="Refresh"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:arrow-path" className="text-xs" />
            </button>
          </div>
        </div>

        {/* The four facts that identify a case, in one line of the document. */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Where</dt>
            <dd className="mt-0.5 text-[14px] text-foreground">
              {[incSiteName(inst, {}), camera?.name || cameraId].filter(Boolean).join(" · ") || "—"}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Owner</dt>
            <dd className="mt-0.5 text-[14px]">
              {inst.assignment?.assigned_to_name || inst.assigned_to ? (
                <span className="text-foreground">
                  {inst.assignment?.assigned_to_name || inst.assigned_to}
                </span>
              ) : (
                <span className="text-amber-400">Unassigned</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Procedure</dt>
            <dd className="mt-0.5 text-[14px] text-foreground">
              {inst.sop_name || "—"}
              {inst.sop_version ? (
                <span className="ml-1.5 font-mono text-[11px] text-muted">v{inst.sop_version}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Deadline</dt>
            <dd className={`mt-0.5 text-[14px] ${sla ? SLA_TONE[sla.tone] : "text-muted"}`}>
              {sla ? (
                <>
                  {new Date(sla.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  <span className="ml-1.5 font-mono text-[11.5px]">· {sla.label}</span>
                </>
              ) : (
                "No time limit"
              )}
            </dd>
          </div>
        </dl>
      </header>

      {/* ── EVIDENCE ───────────────────────────────────────────────────── */}
      <Section title="Evidence">
        {cameraId ? (
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <figure className="m-0 self-start overflow-hidden rounded-xl border border-card-border">
              <div className={`relative aspect-video w-full ${camera ? "bg-black" : ""}`}>
                <EvidencePicture incident={inst} camera={camera} kind="recording" />
              </div>
              <figcaption className="flex items-center gap-2 border-t border-card-border px-3 py-2 text-[11px] text-muted">
                What the recorder held when it fired
                {eventTime && <span className="font-mono">· {fmtDateTime(eventTime)}</span>}
                {camera && (
                  <Link
                    href={`/playback?camera=${encodeURIComponent(cameraId)}${
                      eventTime ? `&t=${encodeURIComponent(eventTime)}` : ""
                    }`}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-0.5 transition hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:film" className="text-xs" /> Timeline
                  </Link>
                )}
              </figcaption>
            </figure>

            <figure className="m-0 self-start overflow-hidden rounded-xl border border-card-border">
              <div className={`relative aspect-video w-full ${camera ? "bg-black" : ""}`}>
                <EvidencePicture incident={inst} camera={camera} kind="live" />
              </div>
              <figcaption className="border-t border-card-border px-3 py-2 text-[11px] text-muted">
                What the same camera shows now
              </figcaption>
            </figure>
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            No camera behind this one — it was raised without a camera event, so the record
            holds no footage.
          </p>
        )}
      </Section>

      {/* ── PROCEDURE beside LOG ───────────────────────────────────────────
          What to do next, against what has already been done. Side by side
          because an operator reads one to decide the other, and because a
          single narrow column left most of a control-room screen empty. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Section title="Procedure">
        {/* THE FLOW ITSELF. A list can say which step an alarm is on; only the
            graph says what leads where — which is the question an operator has
            when the obvious next step is not the one they want. */}
        {states.length > 0 && (
          <StateMachine
            title="How this procedure runs"
            states={states}
            transitions={transitions}
            currentStateId={inst.current_state ?? undefined}
            currentStateName={inst.current_state_name ?? undefined}
          />
        )}

        {steps.length === 0 ? (
          <p className="text-[13px] text-muted">
            {statesQ.isLoading
              ? "Reading the procedure…"
              : "This procedure has no steps defined — it can be worked, but nothing here says how."}
          </p>
        ) : (
          <ol className="grid gap-2">
            {steps.map((st, i) => {
              const done = at >= 0 && i < at;
              const current = at === i;
              return (
                <li key={st.state_id} className="flex items-start gap-2.5 text-[13px]">
                  {/* A ROUND mark, not a square one: the squares read as
                      checkboxes an operator was meant to tick. Done is filled
                      green, the current step is a lit ring, the rest are outlines. */}
                  <span
                    className={`mt-[3px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border text-[9px] ${
                      done
                        ? "border-emerald-500 bg-emerald-500 text-background"
                        : current
                          ? "border-blue-400 bg-blue-400/20 ring-2 ring-blue-400/30"
                          : "border-card-border"
                    }`}
                  >
                    {done ? "✓" : current ? <span className="h-1.5 w-1.5 rounded-full bg-blue-400" /> : ""}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={
                        current ? "font-medium text-foreground" : done ? "text-muted" : "text-muted/80"
                      }
                    >
                      {st.name}
                    </span>
                    {current && (
                      <span className="ml-2 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
                        now
                      </span>
                    )}
                    {st.description && (current || !done) && (
                      <span className="block text-[12px] text-muted">{st.description}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {open && (
          <div className="flex flex-wrap items-center gap-1.5">
            {movesUnavailable && (
              <span className="w-full text-[11.5px] text-amber-400">
                Could not check which moves apply — showing every move this procedure allows
                from here.
              </span>
            )}
            {forwardMoves.map((t) => (
              <button
                key={t.transition_id}
                type="button"
                onClick={() => runMove(t)}
                disabled={doTransition.isPending}
                title={t.description || undefined}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50"
              >
                {t.label}
                {(t.requires_note || t.form_id) && (
                  <Icon icon="heroicons-outline:pencil-square" className="text-[11px] opacity-70" />
                )}
              </button>
            ))}
            {forwardMoves.length === 0 && !movesQ.isLoading && closingMoves.length > 0 && (
              <span className="text-[11.5px] text-muted">
                Nothing left but to close it — see below.
              </span>
            )}
          </div>
        )}
      </Section>

      {/* ── LOG ────────────────────────────────────────────────────────── */}
      <Section title="Log">
        <div className="grid">
          <div className="grid grid-cols-[8.5rem_1fr] gap-3 border-b border-card-border/60 py-2 text-[13px]">
            <time className="font-mono text-[11.5px] text-muted">{fmtDateTime(inst.created_at)}</time>
            <span className="text-foreground">
              Raised
              {inst.event_type ? ` · ${inst.event_type}` : ""}
              {camera?.name ? ` on ${camera.name}` : ""}
              <span className="block text-[12px] text-muted">{originOf(inst)}</span>
            </span>
          </div>
          {trail.map((e, i) => (
            <div
              key={`${e.transition_id}-${e.executed_at}-${i}`}
              className="grid grid-cols-[8.5rem_1fr] gap-3 border-b border-card-border/60 py-2 text-[13px] last:border-0"
            >
              <time className="font-mono text-[11.5px] text-muted">{fmtDateTime(e.executed_at)}</time>
              <span className="text-foreground">
                {e.transition_name || `${e.from_state_name} → ${e.to_state_name}`}
                <span className="text-muted">
                  {" — "}
                  {e.executed_by_name || e.executed_by || "somebody"}
                </span>
                {e.notes && (
                  // The reason a required note is worth requiring: it is the only
                  // account of what actually happened.
                  <span className="mt-1 block border-l-2 border-card-border pl-2.5 text-[12.5px] text-foreground/90">
                    {e.notes}
                  </span>
                )}
              </span>
            </div>
          ))}
          {trail.length === 0 && (
            <p className="py-2 text-[12.5px] text-muted">
              Nothing has been done to it yet — it is waiting for somebody.
            </p>
          )}
        </div>
      </Section>

      </div>

      {/* ── CLOSE OUT ──────────────────────────────────────────────────── */}
      <Section title="Close out">
        {isTerminal(inst.status) ? (
          <div className="rounded-xl border border-card-border bg-card px-3.5 py-3">
            <p className="text-[13px] text-foreground">
              Closed {inst.closed_at ? fmtDateTime(inst.closed_at) : ""} as{" "}
              <b>{inst.current_state_name || inst.status}</b>
            </p>
            {inst.outcome && <p className="mt-1 text-[12.5px] text-muted">{inst.outcome}</p>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-card-border px-3.5 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Outcome</span>
            <span className="text-[12.5px] text-muted">
              Not closed yet — closing asks what happened, and that note is what this record is
              for.
            </span>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {closingMoves.map((t) => (
                <button
                  key={t.transition_id}
                  type="button"
                  onClick={() => runMove(t)}
                  disabled={doTransition.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {t.label}
                  {(t.requires_note || t.form_id) && (
                    <Icon icon="heroicons-outline:pencil-square" className="text-[11px] opacity-70" />
                  )}
                </button>
              ))}
              {closingMoves.length === 0 && !movesQ.isLoading && (
                <span className="text-[11.5px] text-muted">
                  This procedure offers no way to close it from here.
                </span>
              )}
            </span>
          </div>
        )}
      </Section>

      {/* ── RAW EVENT ──────────────────────────────────────────────────── */}
      {inst.trigger_data && (
        <Section title="Raw event">
          {rawOpen ? (
            <EventPayloadInspector
              payload={inst.trigger_data}
              eventType={inst.event_type}
              incident={inst}
            />
          ) : (
            <button
              type="button"
              onClick={() => setRawOpen(true)}
              className="justify-self-start rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              Show what the device sent
            </button>
          )}
        </Section>
      )}

      {noteFor && (
        <ReasonModal
          action={{ title: noteFor.label, verb: noteFor.label, run: () => {} }}
          pending={doTransition.isPending}
          onCancel={() => setNoteFor(null)}
          onSubmit={(reason) => doTransition.mutate({ transition_id: noteFor.transition_id, notes: reason })}
        />
      )}

      {formFor && (
        <TransitionFormModal
          transition={formFor}
          states={states}
          formList={formList}
          pending={doTransition.isPending}
          onCancel={() => setFormFor(null)}
          onSubmit={(form_data) =>
            doTransition.mutate({ transition_id: formFor.transition_id, form_data })
          }
        />
      )}

      {reasonAction && (
        <ReasonModal
          action={reasonAction}
          pending={escalateMut.isPending || statusMut.isPending}
          onCancel={() => setReasonAction(null)}
          onSubmit={(reason) => reasonAction.run(reason)}
        />
      )}

      <AssignModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        instanceId={id}
        currentAssigneeId={inst.assigned_to ?? inst.assignment?.assigned_to ?? ""}
        onAssigned={invalidate}
      />
    </article>
  );
}
