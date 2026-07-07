"use client";

// Workflow — INCIDENT DETAIL. Ported from neubit_v2's incident detail, rethemed to
// neubit_v3's Vercel tokens + kit components. Shows the SOP state machine (states +
// transitions), the current state, the allowed transitions as buttons that PATCH the
// transition (prompting form_data when the chosen transition carries a form), and the
// timeline / history.
//
// Allowed transitions are derived client-side: from the SOP's transition list, keep the
// ones whose `from_state` == the instance's current state. Executing one calls
// PATCH /workflow/instances/{id}/transition with { to_state, form_data? } per the
// backend contract.
//
// Near-real-time: TanStack Query `refetchInterval` (~10s). True realtime (SSE/WS) comes
// later via the core realtime-bridge.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Badge, Button, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "@/lib/api/workflow";
import { STATUS_COLOR, PRIORITY_COLOR, titleize } from "@/views/Workflow";

const asItems = (d) => (Array.isArray(d) ? d : d?.items || []);

// Normalise id accessors across possible backend field names.
const stateId = (s) => s?.id ?? s?.state_id;
const stateName = (s) => s?.name ?? s?.state_name;

function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

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
    queryFn: () => wfApi.states.list({ sop_id: sopId, limit: 200 }),
    enabled: !!sopId,
  });
  const transitionsQ = useQuery({
    queryKey: ["wf-transitions", sopId],
    queryFn: () => wfApi.transitions.list({ sop_id: sopId, limit: 200 }),
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

  const doTransition = useMutation({
    mutationFn: (body) => wfApi.instances.transition(id, body),
    onSuccess: () => {
      toast.success("Transition applied");
      qc.invalidateQueries({ queryKey: ["wf-instance", id] });
      setTransitionModal(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

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
        <Link href="/workflow" className="mt-3 inline-block text-sm text-blue-500 hover:underline">
          Back to incidents
        </Link>
      </div>
    );
  }

  const title =
    inst.title || inst.reference || inst.name || `Incident ${String(id).slice(0, 8)}`;
  const history = asItems(inst.history || inst.timeline || inst.events);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link href="/workflow" className="text-muted hover:text-foreground">
              <Icon icon="heroicons-outline:arrow-left" className="text-lg" />
            </Link>
            {title}
          </span>
        }
        subtitle={`SOP: ${inst.sop_name || "—"} · ${String(id)}`}
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

      {/* Meta badges */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color={STATUS_COLOR[inst.status] || "neutral"}>{titleize(inst.status)}</Badge>
        <Badge color={PRIORITY_COLOR[inst.priority] || "neutral"}>{titleize(inst.priority)} priority</Badge>
        <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
          <Icon icon="heroicons-outline:map-pin" className="text-sm" />
          {inst.site_name || "No site"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-hover border border-card-border px-2.5 py-0.5 text-xs text-muted">
          <Icon icon="heroicons-outline:user" className="text-sm" />
          {inst.assignee_name || inst.assignee?.full_name || inst.assignee?.email || "Unassigned"}
        </span>
        <span className="ml-auto text-xs text-muted">Created {fmtWhen(inst.created_at)}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_20rem] gap-4">
        {/* Left: state machine + timeline */}
        <div className="space-y-4">
          <StateMachine states={states} transitions={transitions} currentStateId={currentStateId} currentStateName={currentStateName} />

          {/* Timeline / history */}
          <div className="rounded-xl border border-card-border bg-card">
            <header className="px-5 py-4 border-b border-card-border">
              <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
            </header>
            <div className="px-5 py-4">
              {history.length === 0 ? (
                <p className="text-sm text-muted">No history entries yet.</p>
              ) : (
                <ol className="relative border-l border-card-border ml-2 space-y-4">
                  {history.map((h, i) => (
                    <li key={h.id ?? i} className="ml-4">
                      <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-blue-500 border-2 border-card" />
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">
                          {h.action || h.event || h.type || "Update"}
                        </span>
                        {(h.to_state_name || h.to_state) && (
                          <Badge color="blue">→ {titleize(h.to_state_name || h.to_state)}</Badge>
                        )}
                      </div>
                      {(h.notes || h.note || h.message) && (
                        <p className="mt-0.5 text-xs text-muted">{h.notes || h.note || h.message}</p>
                      )}
                      <p className="mt-0.5 text-[11px] text-muted/70">
                        {h.actor_name || h.actor?.full_name || h.user || ""} {fmtWhen(h.created_at || h.at || h.timestamp)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>

        {/* Right: current state + allowed transitions */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-card-border bg-card p-5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Current state</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{currentStateName || "—"}</div>
          </div>

          <div className="rounded-xl border border-card-border bg-card">
            <header className="px-5 py-4 border-b border-card-border">
              <h3 className="text-sm font-semibold text-foreground">Actions</h3>
              <p className="text-xs text-muted mt-0.5">Available transitions from the current state.</p>
            </header>
            <div className="px-5 py-4 space-y-2">
              {statesQ.isLoading || transitionsQ.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="!h-4 !w-4" /> Loading…
                </div>
              ) : allowed.length === 0 ? (
                <p className="text-sm text-muted">No transitions available (terminal state or SOP not loaded).</p>
              ) : (
                allowed.map((t) => {
                  const to = t.to_state_name || stateName(states.find((s) => stateId(s) === (t.to_state_id ?? t.to_state))) || t.to_state;
                  const formRef = t.form_id ?? t.form_config?.form_id;
                  const hasForm = !!(t.form_config?.fields?.length || formRef);
                  return (
                    <button
                      key={t.id ?? t.transition_id ?? t.name}
                      onClick={() => runTransition(t)}
                      disabled={doTransition.isPending}
                      className="w-full flex items-center justify-between gap-2 rounded-lg border border-card-border bg-transparent px-3 py-2.5 text-sm text-foreground hover:bg-hover transition disabled:opacity-50"
                    >
                      <span className="flex flex-col text-left">
                        <span className="font-medium">{t.name || `→ ${titleize(to)}`}</span>
                        <span className="text-xs text-muted">to {titleize(to)}</span>
                      </span>
                      {hasForm && <Icon icon="heroicons-outline:document-text" className="text-base text-muted shrink-0" title="Requires a form" />}
                      <Icon icon="heroicons-outline:arrow-right" className="text-base text-muted shrink-0" />
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </aside>
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
    </div>
  );
}

/* ─── State machine diagram (simple flow) ───────────────────────── */
function StateMachine({ states, transitions, currentStateId, currentStateName }) {
  const isCurrent = (s) =>
    stateId(s) === currentStateId || stateName(s) === currentStateName;

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="px-5 py-4 border-b border-card-border">
        <h3 className="text-sm font-semibold text-foreground">State machine</h3>
        <p className="text-xs text-muted mt-0.5">
          {states.length} state(s) · {transitions.length} transition(s)
        </p>
      </header>
      <div className="px-5 py-5">
        {states.length === 0 ? (
          <p className="text-sm text-muted">SOP definition not available.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {states.map((s, i) => {
              const cur = isCurrent(s);
              return (
                <span key={stateId(s) ?? i} className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                      cur
                        ? "border-blue-500 bg-blue-500/10 text-blue-500"
                        : s.is_terminal
                          ? "border-card-border bg-hover text-muted"
                          : "border-card-border bg-transparent text-foreground"
                    }`}
                  >
                    {s.is_entry_point && <Icon icon="heroicons-outline:play" className="text-xs" />}
                    {stateName(s)}
                    {s.is_terminal && <Icon icon="heroicons-outline:flag" className="text-xs" />}
                    {cur && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
                  </span>
                  {i < states.length - 1 && (
                    <Icon icon="heroicons-outline:chevron-right" className="text-muted text-base shrink-0" />
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Transition form modal (collects form_data) ────────────────── */
function TransitionFormModal({ transition, states, formList, pending, onCancel, onSubmit }) {
  // Resolve the field list: inline form_config, or a referenced form definition.
  const formRef = transition.form_id ?? transition.form_config?.form_id;
  const referenced = formList.find((f) => (f.id ?? f.form_id) === formRef);
  const fields =
    transition.form_config?.fields || referenced?.fields || [];

  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});

  function setField(key, v) {
    setValues((p) => ({ ...p, [key]: v }));
    if (errors[key]) setErrors((p) => ({ ...p, [key]: undefined }));
  }

  function submit(e) {
    e.preventDefault();
    const next = {};
    for (const f of fields) {
      if (f.required && (values[f.key] === undefined || values[f.key] === "" || values[f.key] === null)) {
        next[f.key] = `${f.label || f.key} is required`;
      }
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    onSubmit(values);
  }

  const toName =
    transition.to_state_name ||
    stateName(states.find((s) => stateId(s) === (transition.to_state_id ?? transition.to_state))) ||
    transition.to_state;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-xl bg-card border border-card-border shadow-2xl animate-modal-in flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{transition.name || "Apply transition"}</h3>
            <p className="text-xs text-muted mt-0.5">Move to {titleize(toName)}</p>
          </div>
          <button onClick={onCancel} className="text-muted hover:text-foreground transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 px-6 py-5 space-y-4 overflow-y-auto">
            {fields.length === 0 ? (
              <p className="text-sm text-muted">Confirm to apply this transition.</p>
            ) : (
              fields.map((f) => (
                <FormFieldInput
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  error={errors[f.key]}
                  onChange={(v) => setField(f.key, v)}
                />
              ))
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Applying…" : "Apply transition"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Dynamic form field (text/textarea/number/boolean/select) ──── */
function FormFieldInput({ field, value, error, onChange }) {
  const label = (
    <label className="text-xs font-medium uppercase tracking-wide text-muted">
      {field.label || field.key}
      {field.required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
  const cls = `mt-1 h-10 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted`;
  const options = Array.isArray(field.options)
    ? field.options.map((o) => (typeof o === "object" ? o : { value: o, label: o }))
    : [];

  return (
    <div>
      {label}
      {field.type === "textarea" ? (
        <textarea
          rows={3}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || ""}
          className={`mt-1 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted`}
        />
      ) : field.type === "boolean" ? (
        <label className="mt-1 flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.placeholder || "Yes"}
        </label>
      ) : field.type === "select" || field.type === "multiselect" ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        >
          <option value="" className="bg-card">Select…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-card">{o.label}</option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || ""}
          className={cls}
        />
      )}
      {field.help_text && <p className="mt-1 text-[11px] text-muted/70">{field.help_text}</p>}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
