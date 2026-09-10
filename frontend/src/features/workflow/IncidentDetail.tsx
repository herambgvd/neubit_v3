"use client";

// ONE ALARM, IN FULL — the case file behind a row on /alarms.
//
// The queue screen answers "what is happening and what do I do next". This page
// answers the questions that outlive the shift: what exactly happened, what was
// done about it, by whom, on what evidence, and what the device actually said.
// It is where somebody reconstructs an incident a week later, and where the PDF
// an investigation asks for comes from.
//
// So it carries everything the queue screen deliberately leaves out — the whole
// state machine as a diagram rather than a list, the complete trail with its
// notes, and the raw event envelope — while keeping the same language: the
// picture is the biggest thing, the clock is a shape, and nothing on the page is
// invented.
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
import type {
  FormPublic,
  InstanceStatus,
  StatePublic,
  TransitionPublic,
} from "./types";
import { EvidencePicture, type EvidenceKind } from "./components/incidents/AlarmEvidence";
import AlarmFacts from "./components/incidents/AlarmFacts";
import AlarmTrail from "./components/incidents/AlarmTrail";
import SlaRing from "./components/incidents/SlaRing";
import { incCameraId, incEventTime, incTitle, isOpen, isTerminal, sev } from "./components/incidents/lib";
import StateMachine from "./components/detail/StateMachine";
import EventPayloadInspector from "./components/detail/EventPayloadInspector";
import AssignModal from "./components/detail/AssignModal";
import TransitionFormModal from "./components/detail/TransitionFormModal";
import ReasonModal from "./components/detail/ReasonModal";
import type { ReasonAction } from "./components/detail/ReasonModal";

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
  // The moves THIS alarm can make, from the server rather than derived here: a
  // transition can carry conditions, and a button the backend would refuse is
  // worse than no button.
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
  // WHAT THIS ALARM CAN DO NEXT, from the server — a transition can carry
  // conditions, and a button the backend would refuse is worse than no button.
  //
  // But a pane with NO moves is worse still: when that call fails, fall back to
  // the structurally-legal ones (the SOP's transitions out of this state). The
  // operator can still act, the server still guards, and the footer says which of
  // the two answers it is showing.
  const movesUnavailable = movesQ.isError;
  const moves = useMemo<TransitionPublic[]>(() => {
    if (!movesUnavailable) return movesQ.data || [];
    const here = inst?.current_state;
    return transitions.filter((t) => !here || t.from_state_id === here);
  }, [movesUnavailable, movesQ.data, transitions, inst?.current_state]);
  const formList = useMemo<FormPublic[]>(() => (formsQ.data ? asItems(formsQ.data) : []), [formsQ.data]);

  // The camera as the ESTATE knows it — the alarm carries the node-side id the
  // recorder reported, and without the owning recorder there is no session to mint.
  const { cameras } = useEstateCameras();
  const camera = useMemo<EstateCamera | null>(() => {
    const camId = inst ? incCameraId(inst) : null;
    if (!camId) return null;
    return (
      cameras.find((c) => c.id === camId || (c as { real_id?: string }).real_id === camId) ?? null
    );
  }, [inst, cameras]);

  const [evidence, setEvidence] = useState<EvidenceKind>("recording");
  const [evidenceChosen, setEvidenceChosen] = useState(false);
  const pickEvidence = (kind: EvidenceKind) => {
    setEvidence(kind);
    setEvidenceChosen(true);
  };

  const [assignOpen, setAssignOpen] = useState(false);
  const [formFor, setFormFor] = useState<TransitionPublic | null>(null);
  const [noteFor, setNoteFor] = useState<TransitionPublic | null>(null);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wf-instance", id] });
    qc.invalidateQueries({ queryKey: ["wf-available-transitions", id] });
    qc.invalidateQueries({ queryKey: ["wf-instances"] });
    qc.invalidateQueries({ queryKey: ["wf-stats"] });
  };

  const doTransition = useMutation({
    mutationFn: (body: { transition_id: string; notes?: string | null; form_data?: Record<string, unknown> | null }) =>
      wfApi.instances.transition(id, body),
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
  const open = isOpen(inst.status);
  const cameraId = incCameraId(inst);
  const eventTime = incEventTime(inst);
  const hasPicture = !!camera;

  return (
    <div className="mx-auto grid max-w-[110rem] gap-3 pb-8">
      {/* ── THE HEADER LINE ────────────────────────────────────────────────
          Everything that identifies the alarm, and the moves that are not part of
          the procedure. No masthead card: this page is the case, not a form. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alarms"
          title="Back to the queue"
          aria-label="Back to the queue"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-left" className="text-sm" />
        </Link>
        <span className={`h-5 w-[3px] shrink-0 rounded-full ${s.band}`} aria-hidden />
        <h1 className="min-w-0 truncate text-[17px] font-semibold text-foreground">{incTitle(inst)}</h1>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.soft} ${s.text}`}>
          {s.label}
        </span>
        <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-foreground">
          {inst.current_state_name || inst.status}
        </span>
        <span className="font-mono text-[11px] text-muted">raised {fmtDateTime(inst.created_at)}</span>

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
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground disabled:opacity-50"
          >
            <Icon
              icon={pdfPending ? "svg-spinners:180-ring" : "heroicons-outline:document-arrow-down"}
              className="text-xs"
            />
            PDF
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

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* ── THE EVIDENCE AND THE PROCEDURE ─────────────────────────────── */}
        <div className="grid content-start gap-3">
          <section className="overflow-hidden rounded-xl border border-card-border bg-card">
            <div className={`relative aspect-video w-full ${hasPicture ? "bg-black" : ""}`}>
              <EvidencePicture
                incident={inst}
                camera={camera}
                kind={evidence}
                onFootage={(present) => {
                  if (!present && !evidenceChosen) setEvidence("live");
                }}
              />
              {hasPicture && (
                <div className="absolute right-2 top-2 z-10 inline-flex overflow-hidden rounded-lg border border-card-border bg-[rgba(8,15,34,.82)] backdrop-blur-xs">
                  {(["recording", "live"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => pickEvidence(k)}
                      aria-pressed={evidence === k}
                      className={`px-2.5 py-1 text-[11px] font-medium transition ${
                        evidence === k ? "bg-blue-500/20 text-blue-100" : "text-muted hover:text-foreground"
                      }`}
                    >
                      {k === "recording" ? "Recording" : "Live"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-card-border px-3 py-2 text-[11.5px] text-muted">
              <Icon icon="heroicons-outline:video-camera" className="text-xs" />
              {camera?.name || (cameraId ? cameraId : "No camera behind this alarm")}
              {eventTime && (
                <span className="font-mono">
                  · event at {fmtDateTime(eventTime)}
                </span>
              )}
              {cameraId && eventTime && (
                <Link
                  href={`/playback?camera=${encodeURIComponent(cameraId)}&t=${encodeURIComponent(eventTime)}`}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11px] transition hover:bg-hover hover:text-foreground"
                >
                  <Icon icon="heroicons-outline:film" className="text-xs" /> Whole timeline
                </Link>
              )}
            </div>
          </section>

          {/* THE PROCEDURE, as the graph it is. The queue screen shows the steps
              as a list because that is all the room there is; here there is room
              for the real shape, including the branches a list cannot draw. */}
          <section className="overflow-hidden rounded-xl border border-card-border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b border-card-border px-3 py-2">
              <Icon icon="heroicons-outline:map" className="text-sm text-blue-500" />
              <span className="text-[12px] font-semibold text-foreground">Procedure</span>
              <span className="truncate text-[11.5px] text-muted">{inst.sop_name || "—"}</span>
              {inst.sop_version ? (
                <span className="rounded-full border border-card-border px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  v{inst.sop_version}
                </span>
              ) : null}
            </header>

            <div className="overflow-x-auto p-3">
              <StateMachine
                states={states}
                transitions={transitions}
                currentStateId={inst.current_state ?? undefined}
                currentStateName={inst.current_state_name ?? undefined}
              />
            </div>

            <footer className="flex flex-wrap items-center gap-1.5 border-t border-card-border px-3 py-2">
              {isTerminal(inst.status) ? (
                <span className="text-[11.5px] text-muted">
                  Closed {inst.closed_at ? fmtDateTime(inst.closed_at) : ""}
                  {inst.outcome ? ` · ${inst.outcome}` : ""}
                </span>
              ) : moves.length === 0 ? (
                <span className="text-[11.5px] text-muted">
                  {movesQ.isLoading
                    ? "Reading the moves this procedure allows…"
                    : "This procedure offers no move from here."}
                </span>
              ) : (
                <>
                {movesUnavailable && (
                  // Said out loud: these are the procedure's moves, not a checked
                  // list of what this alarm may do right now.
                  <span className="w-full text-[11px] text-amber-400">
                    Could not check which moves apply — showing every move this procedure
                    allows from here.
                  </span>
                )}
                {moves.map((t) => (
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
                </>
              )}
            </footer>
          </section>

          {/* WHAT THE DEVICE ACTUALLY SAID. Last, and collapsible, because it is
              the thing you go looking for rather than the thing you read first. */}
          {inst.trigger_data && (
            <EventPayloadInspector payload={inst.trigger_data} eventType={inst.event_type} incident={inst} />
          )}
        </div>

        {/* ── THE RECORD ─────────────────────────────────────────────────── */}
        <div className="grid content-start gap-3">
          <div className="h-[13rem]">
            <SlaRing incident={inst} />
          </div>
          <div className="min-h-[12rem]">
            <AlarmFacts incident={inst} cameraName={camera?.name ?? null} />
          </div>
          <div className="min-h-[16rem]">
            <AlarmTrail incident={inst} />
          </div>
        </div>
      </div>

      {noteFor && (
        <ReasonModal
          action={{ title: noteFor.label, verb: noteFor.label, run: () => {} }}
          pending={doTransition.isPending}
          onCancel={() => setNoteFor(null)}
          onSubmit={(reason) =>
            doTransition.mutate({ transition_id: noteFor.transition_id, notes: reason })
          }
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
    </div>
  );
}
