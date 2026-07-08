"use client";

// Workflow — INCIDENT DETAIL (page entry; a route wrapper re-exports this default).
// Thin orchestrator: owns the instance/SOP queries + status/escalate/transition
// the allowed transitions from the current state, and wires the meta/state-machine/
// timeline/manage components + the transition-form and reason modals.
//
// Allowed transitions are derived client-side from the SOP's transition list (keep
// those whose from_state == the current state). Near-real-time via TanStack Query
// `refetchInterval` (~10s); SSE/WS comes later via the core realtime-bridge.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { titleize, asItems } from "@/lib/format";
import { workflow as wfApi } from "./api";
import IncidentMeta from "./components/detail/IncidentMeta";
import StateMachine, { stateId, stateName } from "./components/detail/StateMachine";
import IncidentTimeline from "./components/detail/IncidentTimeline";
import EventPayloadInspector from "./components/detail/EventPayloadInspector";
import IncidentActionBar from "./components/detail/IncidentActionBar";
import ManagePanel from "./components/detail/ManagePanel";
import AssignModal from "./components/detail/AssignModal";
import TransitionFormModal from "./components/detail/TransitionFormModal";
import ReasonModal from "./components/detail/ReasonModal";

export default function WorkflowDetailPage() {
  const params = useParams();
  const id = params?.id;
  const qc = useQueryClient();

  // Poll the instance for near-real-time updates. Swap for SSE/WS later.
  const instQ = useQuery({
    queryKey: ["wf-instance", id],
    queryFn: () => wfApi.instances.get(id),
    enabled: !!id,
    refetchInterval: 10000,
  });
  const inst = instQ.data;

  const sopId = inst?.sop_id ?? inst?.sop?.id;

  // SOP definition: states + transitions to render the state machine + allowed moves.
  const statesQ = useQuery({
    queryKey: ["wf-states", sopId],
    queryFn: () => wfApi.states.list(sopId, { limit: 200 }),
    enabled: !!sopId,
  });
  const transitionsQ = useQuery({
    queryKey: ["wf-transitions", sopId],
    queryFn: () => wfApi.transitions.list(sopId, { limit: 200 }),
    enabled: !!sopId,
  });
  const forms = useQuery({
    queryKey: ["wf-forms"],
    queryFn: () => wfApi.forms.list({ limit: 200 }),
  });

  const states = asItems(statesQ.data);
  const transitions = asItems(transitionsQ.data);
  const formList = asItems(forms.data);

  const currentStateId = inst?.current_state_id ?? inst?.current_state ?? inst?.state;
  const currentStateName =
    inst?.current_state_name ||
    stateName(states.find((s) => stateId(s) === currentStateId)) ||
    titleize(inst?.current_state || inst?.state);

  // Transitions leaving the current state.
  const allowed = useMemo(() => {
    return transitions.filter((t) => {
      const from = t.from_state_id ?? t.from_state;
      return from === currentStateId || stateName(states.find((s) => stateId(s) === from)) === currentStateName;
    });
  }, [transitions, states, currentStateId, currentStateName]);

  const [transitionModal, setTransitionModal] = useState(null); // the chosen transition
  const [reasonAction, setReasonAction] = useState(null); // { title, verb, run(reason) }
  const [assignOpen, setAssignOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wf-instance", id] });

  const doTransition = useMutation({
    mutationFn: (body) => wfApi.instances.transition(id, body),
    onSuccess: () => {
      toast.success("Transition applied");
      invalidate();
      setTransitionModal(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const escalateMut = useMutation({
    mutationFn: (reason) => wfApi.instances.escalate(id, reason),
    onSuccess: () => { toast.success("Incident escalated"); invalidate(); setReasonAction(null); },
    onError: (e) => toast.error(apiError(e)),
  });
  const statusMut = useMutation({
    mutationFn: ({ status, reason }) => wfApi.instances.setStatus(id, status, reason),
    onSuccess: () => { toast.success("Status updated"); invalidate(); setReasonAction(null); },
    onError: (e) => toast.error(apiError(e)),
  });
  const actionPending = escalateMut.isPending || statusMut.isPending;

  function runStatus(a) {
    if (a.reason) {
      setReasonAction({ title: `${a.label} incident`, verb: a.label, run: (reason) => statusMut.mutate({ status: a.status, reason }) });
    } else {
      statusMut.mutate({ status: a.status });
    }
  }
  function runEscalate() {
    setReasonAction({ title: "Escalate incident", verb: "Escalate", run: (reason) => escalateMut.mutate(reason) });
  }

  function runTransition(t) {
    const formRef = t.form_id ?? t.form_config?.form_id;
    const hasForm = !!(t.form_config?.fields?.length || formRef);
    if (hasForm) {
      setTransitionModal(t);
    } else {
      doTransition.mutate({ transition_id: t.transition_id ?? t.id });
    }
  }

  if (instQ.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (instQ.isError || !inst) {
    return (
      <div className="py-20 text-center">
        <Icon icon="heroicons-outline:exclamation-triangle" className="text-4xl text-muted mb-3 opacity-60" />
        <p className="text-foreground font-medium">Incident not found</p>
        <Link href="/events" className="mt-3 inline-block text-sm text-blue-500 hover:underline">
          Back to incidents
        </Link>
      </div>
    );
  }

  const title =
    inst.title || inst.reference || inst.name || `Incident ${String(id).slice(0, 8)}`;
  const history = asItems(inst.history || inst.timeline || inst.events);
  const eventPayload = inst.trigger_data ?? inst.event ?? inst.event_data ?? null;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link href="/events" className="text-muted hover:text-foreground">
              <Icon icon="heroicons-outline:arrow-left" className="text-lg" />
            </Link>
            {title}
          </span>
        }
        subtitle={
          <span>
            SOP:{" "}
            {inst.sop_name ? (
              <Link href="/workflow-config" className="text-blue-500 hover:underline">
                {inst.sop_name}
              </Link>
            ) : (
              "—"
            )}{" "}
            · {String(id)}
          </span>
        }
        actions={
          <Button
            variant="secondary"
            icon="heroicons-outline:arrow-path"
            onClick={() => instQ.refetch()}
          >
            Refresh
          </Button>
        }
      />

      <IncidentActionBar
        instance={inst}
        actionPending={actionPending}
        onStatusAction={runStatus}
        onEscalate={runEscalate}
        onAssign={() => setAssignOpen(true)}
      />

      <IncidentMeta instance={inst} currentStateName={currentStateName} />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_20rem] gap-4">
        {/* Left: state machine + timeline */}
        <div className="space-y-4">
          <StateMachine states={states} transitions={transitions} currentStateId={currentStateId} currentStateName={currentStateName} />
          <IncidentTimeline history={history} />
          {eventPayload && <EventPayloadInspector payload={eventPayload} eventType={inst.event_type} />}
        </div>

        {/* Right: current state + allowed transitions */}
        <ManagePanel
          currentStateName={currentStateName}
          states={states}
          allowed={allowed}
          transitionPending={doTransition.isPending}
          sopLoading={statesQ.isLoading || transitionsQ.isLoading}
          onRunTransition={runTransition}
        />
      </div>

      {transitionModal && (
        <TransitionFormModal
          transition={transitionModal}
          states={states}
          formList={formList}
          pending={doTransition.isPending}
          onCancel={() => setTransitionModal(null)}
          onSubmit={(form_data) => {
            doTransition.mutate({ transition_id: transitionModal.transition_id ?? transitionModal.id, form_data });
          }}
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
        currentAssigneeId={inst.assigned_to ?? inst.assignee_id ?? inst.assignment?.assigned_to ?? ""}
        onAssigned={invalidate}
      />
    </div>
  );
}
