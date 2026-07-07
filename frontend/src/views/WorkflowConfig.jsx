"use client";

// Workflow configuration — SOP builder + Triggers, with Forms / Notifications /
// Threat-levels stubbed (phase-2). Ported from neubit_v2's config/workflow tabbed area,
// rethemed to neubit_v3's Vercel tokens + kit components.
//
// PHASE 1 (this file):
//   • SOP tab — SOP CRUD, and per-SOP States + Transitions CRUD (the state machine).
//   • Triggers tab — trigger CRUD (event_type + conditions + target SOP + priority).
// PHASE 2 (stubbed with a clear TODO): Forms, Notification templates/channels, Threat
//   levels — the API modules already expose wfApi.forms / .notifications / .threatLevels.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { workflow as wfApi } from "@/lib/api/workflow";
import { sites as sitesApi } from "@/lib/api/sites";
import SopCanvas from "@/components/sop-builder/SopCanvas";

const PRIORITIES = ["low", "medium", "high", "critical"];
const TRIGGER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "regex"];

// Form field kinds the builder can create (mirrors backend FieldType enum).
const FIELD_TYPES = ["text", "textarea", "number", "email", "phone", "date", "datetime", "select", "radio", "checkbox", "boolean", "file"];
const FIELD_TYPES_WITH_OPTIONS = new Set(["select", "radio"]);
// Notification channels a template can target (mirrors backend channel_type).
const CHANNEL_TYPES = ["email", "webhook", "sms", "whatsapp", "mobile_push"];
// Threat posture levels (mirrors backend ThreatLevelValue).
const THREAT_LEVELS = ["normal", "elevated", "high", "critical"];
const THREAT_COLOR = {
  normal: "bg-green-500/10 text-green-500",
  elevated: "bg-blue-500/10 text-blue-500",
  high: "bg-amber-500/10 text-amber-500",
  critical: "bg-red-500/10 text-red-500",
};

const asItems = (d) => (Array.isArray(d) ? d : d?.items || []);
const titleize = (s) => (s ? String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—");
const idOf = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v != null);

const TABS = [
  { key: "sops", label: "SOPs", icon: "heroicons:rectangle-stack" },
  { key: "triggers", label: "Triggers", icon: "heroicons:bolt" },
  { key: "forms", label: "Forms", icon: "heroicons-outline:clipboard-document-list" },
  { key: "notifications", label: "Notifications", icon: "heroicons-outline:bell-alert" },
  { key: "threat", label: "Threat levels", icon: "heroicons-outline:shield-exclamation" },
];

/* Shared themed inputs */
function FLabel({ children, required }) {
  return (
    <label className="text-xs font-medium uppercase tracking-wide text-muted">
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
}
const FIELD_CLS =
  "mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";

export default function WorkflowConfigPage() {
  const [tab, setTab] = useState("sops");

  return (
    <div>
      <PageHeader
        title="Workflow configuration"
        subtitle="Define SOPs, their state machines, and the triggers that raise incidents."
        actions={
          <Link
            href="/workflow"
            className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
          >
            <Icon icon="heroicons-outline:arrow-left" className="text-base" />
            Incidents
          </Link>
        }
      />

      <nav className="mb-4 flex items-stretch gap-0.5 border-b border-card-border overflow-x-auto">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
                active ? "text-foreground border-foreground" : "text-muted border-transparent hover:text-foreground"
              }`}
            >
              <Icon icon={t.icon} className="text-base" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "sops" && <SopsTab />}
      {tab === "triggers" && <TriggersTab />}
      {tab === "forms" && <FormsTab />}
      {tab === "notifications" && <NotificationTemplatesTab />}
      {tab === "threat" && <ThreatLevelsTab />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   SOPs tab — master (SOP list) / detail (metadata + states + transitions)
   ══════════════════════════════════════════════════════════════════ */
function SopsTab() {
  const qc = useQueryClient();
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sops = asItems(sopsQ.data);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [confirm, setConfirm] = useState(null);

  const sopId = (s) => idOf(s, "id", "sop_id");
  const selected = useMemo(() => sops.find((s) => sopId(s) === selectedId) || null, [sops, selectedId]);

  useEffect(() => {
    if (mode === "view" && !selected && sops[0]) setSelectedId(sopId(sops[0]));
  }, [sops, selected, mode]);

  const remove = useMutation({
    mutationFn: (id) => wfApi.sops.remove(id),
    onSuccess: () => {
      toast.success("SOP removed");
      qc.invalidateQueries({ queryKey: ["wf-sops"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-4 min-h-[60vh]">
      <aside className="rounded-xl border border-card-border bg-card flex flex-col min-h-0">
        <header className="flex items-center justify-between px-4 py-3 border-b border-card-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">SOPs ({sops.length})</span>
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setMode("create")} className="!px-2.5 !py-1 text-xs">
            New
          </Button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {sopsQ.isLoading ? (
            <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading…</div>
          ) : sops.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted">No SOPs yet. Click <b>New</b>.</div>
          ) : (
            <ul className="divide-y divide-card-border">
              {sops.map((s) => {
                const isSel = sopId(s) === selectedId && mode !== "create";
                return (
                  <li key={sopId(s)} className="relative">
                    <button
                      onClick={() => { setSelectedId(sopId(s)); setMode("view"); }}
                      className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${isSel ? "bg-hover" : "hover:bg-hover"}`}
                    >
                      {isSel && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0">
                        <Icon icon="heroicons:rectangle-stack" className="text-base" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-foreground truncate">{s.name}</span>
                        <span className="block text-[11px] text-muted">
                          {typeof s.version === "number" ? `v${s.version} · ` : ""}
                          {titleize(s.default_priority || "medium")}
                          {s.is_active === false ? " · Inactive" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
        {mode === "create" || mode === "edit" ? (
          <SopForm
            sop={mode === "edit" ? selected : null}
            onCancel={() => setMode("view")}
            onSaved={(saved) => {
              qc.invalidateQueries({ queryKey: ["wf-sops"] });
              const id = idOf(saved, "id", "sop_id");
              if (id) setSelectedId(id);
              setMode("view");
            }}
          />
        ) : !selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
            <Icon icon="heroicons:rectangle-stack" className="text-3xl text-muted opacity-60" />
            <div className="mt-3 text-sm font-semibold text-foreground">No SOP selected</div>
          </div>
        ) : (
          <SopDetail
            sop={selected}
            sopId={sopId(selected)}
            onEdit={() => setMode("edit")}
            onDelete={() =>
              setConfirm({
                title: "Delete SOP?",
                message: `Delete "${selected.name}" and its states/transitions?`,
                confirmLabel: "Delete",
                onConfirm: () => { remove.mutate(sopId(selected)); setConfirm(null); },
              })
            }
          />
        )}
      </section>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function SopDetail({ sop, sopId, onEdit, onDelete }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">{sop.name}</h2>
          {sop.description && <p className="mt-0.5 text-xs text-muted">{sop.description}</p>}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted flex-wrap">
            {typeof sop.version === "number" && <span>v{sop.version}</span>}
            <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 capitalize">{titleize(sop.default_priority || "medium")}</span>
            {sop.sla_hours != null && <span>SLA {sop.sla_hours}h</span>}
            <span className={`rounded-full px-2 py-0.5 ${sop.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>
              {sop.is_active === false ? "Inactive" : "Active"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20">
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <SopCanvas key={sopId} sopId={sopId} />
      </div>
    </div>
  );
}

function SopForm({ sop, onCancel, onSaved }) {
  const isEdit = !!sop;
  const [name, setName] = useState(sop?.name || "");
  const [description, setDescription] = useState(sop?.description || "");
  const [priority, setPriority] = useState(sop?.default_priority || "medium");
  const [slaHours, setSlaHours] = useState(sop?.sla_hours ?? "");
  const [isActive, setIsActive] = useState(sop?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.sops.update(idOf(sop, "id", "sop_id"), body) : wfApi.sops.create(body)),
    onSuccess: (saved) => { toast.success(isEdit ? "SOP updated" : "SOP created"); onSaved(saved); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setErrors({ name: "Name is required" }); return; }
    saving.mutate({
      name: name.trim(),
      description: description.trim() || null,
      default_priority: priority,
      sla_hours: slaHours === "" ? null : Number(slaHours),
      is_active: isActive,
    });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col flex-1 min-h-0">
      <header className="px-6 py-5 border-b border-card-border">
        <h2 className="text-lg font-semibold text-foreground">{isEdit ? `Edit ${sop.name}` : "Create SOP"}</h2>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <FLabel required>Name</FLabel>
          <input value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors({}); }} placeholder="e.g. Fire alarm response" className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`} />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <FLabel>Default priority</FLabel>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={FIELD_CLS}>
            {PRIORITIES.map((p) => <option key={p} value={p} className="bg-card">{titleize(p)}</option>)}
          </select>
        </div>
        <div>
          <FLabel>SLA (hours)</FLabel>
          <input type="number" min={0} value={slaHours} onChange={(e) => setSlaHours(e.target.value)} placeholder="Optional" className={FIELD_CLS} />
        </div>
        <div className="md:col-span-2">
          <FLabel>Description</FLabel>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted" />
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="success" disabled={saving.isPending}>{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create SOP"}</Button>
      </div>
    </form>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Triggers tab — event_type + conditions + target SOP + priority
   ══════════════════════════════════════════════════════════════════ */
function TriggersTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-triggers"], queryFn: () => wfApi.triggers.list({ limit: 200 }) });
  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const triggers = asItems(q.data);
  const sops = asItems(sopsQ.data);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const sopName = (sid) => sops.find((s) => idOf(s, "id", "sop_id") === sid)?.name || "—";

  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? wfApi.triggers.update(id, body) : wfApi.triggers.create(body)),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); setForm(null); },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (id) => wfApi.triggers.remove(id),
    onSuccess: () => { toast.success("Trigger removed"); qc.invalidateQueries({ queryKey: ["wf-triggers"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Triggers</h3>
          <p className="text-xs text-muted">Match an event → raise an incident from a target SOP.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">Add trigger</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <TriggerForm
            trigger={idOf(form, "id", "trigger_id") ? form : null}
            sops={sops}
            pending={save.isPending}
            onCancel={() => setForm(null)}
            onSubmit={(body) => save.mutate({ id: idOf(form, "id", "trigger_id"), body })}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : triggers.length === 0 && !form ? (
          <p className="text-sm text-muted">No triggers yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {triggers.map((t) => (
              <li key={idOf(t, "id", "trigger_id")} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-500 shrink-0"><Icon icon="heroicons:bolt" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{t.name}</span>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${t.enabled === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{t.enabled === false ? "Disabled" : "Enabled"}</span>
                  </span>
                  <span className="block text-[11px] text-muted font-mono truncate">
                    {t.event_source ? `${t.event_source}:` : ""}{t.event_type} → {sopName(t.sop_id)}
                    {t.conditions?.length ? ` · ${t.conditions.length} condition(s)` : ""}
                  </span>
                </span>
                <button onClick={() => setForm(t)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete trigger?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(idOf(t, "id", "trigger_id")); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function TriggerForm({ trigger, sops, pending, onCancel, onSubmit }) {
  const isEdit = !!trigger;
  const [name, setName] = useState(trigger?.name || "");
  const [eventSource, setEventSource] = useState(trigger?.event_source || "");
  const [eventType, setEventType] = useState(trigger?.event_type || "");
  const [sopId, setSopId] = useState(trigger?.sop_id || "");
  const [priority, setPriority] = useState(trigger?.priority || "");
  const [enabled, setEnabled] = useState(trigger?.enabled !== false);
  const [conditions, setConditions] = useState(
    Array.isArray(trigger?.conditions) && trigger.conditions.length
      ? trigger.conditions.map((c) => ({ path: c.path || "", op: c.op || "eq", value: c.value ?? "" }))
      : [],
  );
  const [errors, setErrors] = useState({});

  function updateCond(i, patch) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!eventType.trim()) next.eventType = "Event type is required";
    if (!sopId) next.sopId = "Target SOP is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    const cleanConds = conditions
      .filter((c) => c.path.trim())
      .map((c) => ({ path: c.path.trim(), op: c.op, value: c.value === "" ? null : c.value }));
    onSubmit({
      name: name.trim(),
      event_source: eventSource.trim() || null,
      event_type: eventType.trim(),
      sop_id: sopId,
      priority: priority || null,
      enabled,
      conditions: cleanConds,
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${trigger.name}` : "Add trigger"}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <FLabel required>Name</FLabel>
          <input value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }} className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`} placeholder="e.g. Fire alarm → Fire SOP" />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <FLabel>Event source</FLabel>
          <input value={eventSource} onChange={(e) => setEventSource(e.target.value)} className={FIELD_CLS} placeholder="e.g. ingest, camera" />
        </div>
        <div>
          <FLabel required>Event type</FLabel>
          <input value={eventType} onChange={(e) => { setEventType(e.target.value); if (errors.eventType) setErrors((p) => ({ ...p, eventType: undefined })); }} className={`${FIELD_CLS} ${errors.eventType ? "!border-red-500" : ""}`} placeholder="e.g. fire.alarm or *" />
          {errors.eventType && <p className="mt-1 text-xs text-red-500">{errors.eventType}</p>}
        </div>
        <div>
          <FLabel required>Target SOP</FLabel>
          <select value={sopId} onChange={(e) => { setSopId(e.target.value); if (errors.sopId) setErrors((p) => ({ ...p, sopId: undefined })); }} className={`${FIELD_CLS} ${errors.sopId ? "!border-red-500" : ""}`}>
            <option value="" className="bg-card">Select a SOP…</option>
            {sops.map((s) => <option key={idOf(s, "id", "sop_id")} value={idOf(s, "id", "sop_id")} className="bg-card">{s.name}</option>)}
          </select>
          {errors.sopId && <p className="mt-1 text-xs text-red-500">{errors.sopId}</p>}
        </div>
        <div>
          <FLabel>Priority override</FLabel>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={FIELD_CLS}>
            <option value="" className="bg-card">Use SOP default</option>
            {PRIORITIES.map((p) => <option key={p} value={p} className="bg-card">{titleize(p)}</option>)}
          </select>
        </div>
      </div>

      {/* Conditions (AND) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <FLabel>Conditions (all must match)</FLabel>
          <button type="button" onClick={() => setConditions((cs) => [...cs, { path: "", op: "eq", value: "" }])} className="text-xs text-blue-500 hover:underline">+ Add condition</button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-[11px] text-muted/70">No conditions — the trigger fires on any matching event type.</p>
        ) : (
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={c.path} onChange={(e) => updateCond(i, { path: e.target.value })} placeholder="payload.path" className="h-9 flex-1 rounded-lg border border-field bg-transparent px-2.5 text-sm font-mono text-foreground outline-none focus:border-muted" />
                <select value={c.op} onChange={(e) => updateCond(i, { op: e.target.value })} className="h-9 rounded-lg border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted">
                  {TRIGGER_OPS.map((o) => <option key={o} value={o} className="bg-card">{o}</option>)}
                </select>
                <input value={c.value} onChange={(e) => updateCond(i, { value: e.target.value })} placeholder="value" className="h-9 w-28 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
                <button type="button" onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={pending} className="!px-3 !py-1.5 text-xs">{pending ? "Saving…" : isEdit ? "Save changes" : "Create trigger"}</Button>
      </div>
    </form>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Forms tab — dynamic forms attached to transitions (fields + validation)
   ══════════════════════════════════════════════════════════════════ */
function FormsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 200 }) });
  const forms = asItems(q.data);
  const [form, setForm] = useState(null); // {} for new, form obj for edit
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => wfApi.forms.remove(id),
    onSuccess: () => { toast.success("Form removed"); qc.invalidateQueries({ queryKey: ["wf-forms"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Forms</h3>
          <p className="text-xs text-muted">Structured data operators fill when advancing an incident through a transition.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">New form</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <FormBuilder
            form={form.form_id ? form : null}
            onCancel={() => setForm(null)}
            onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-forms"] }); setForm(null); }}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : forms.length === 0 && !form ? (
          <p className="text-sm text-muted">No forms yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {forms.map((f) => (
              <li key={f.form_id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 shrink-0"><Icon icon="heroicons-outline:clipboard-document-list" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{f.name}</span>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${f.is_active === false ? "bg-hover text-muted" : "bg-green-500/10 text-green-500"}`}>{f.is_active === false ? "Inactive" : "Active"}</span>
                  </span>
                  <span className="block text-[11px] text-muted">{(f.fields?.length || 0)} field(s){f.description ? ` · ${f.description}` : ""}</span>
                </span>
                <button onClick={() => setForm(f)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete form?", message: `Delete "${f.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(f.form_id); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function FormBuilder({ form, onCancel, onSaved }) {
  const isEdit = !!form;
  const [name, setName] = useState(form?.name || "");
  const [description, setDescription] = useState(form?.description || "");
  const [isActive, setIsActive] = useState(form?.is_active !== false);
  const [fields, setFields] = useState(
    Array.isArray(form?.fields) && form.fields.length
      ? form.fields.map((f) => ({
          label: f.label || "",
          type: f.type || "text",
          required: !!(f.validation?.required),
          options: (f.options || []).map((o) => o.label ?? o.value ?? "").join(", "),
          placeholder: f.placeholder || "",
        }))
      : [{ label: "", type: "text", required: false, options: "", placeholder: "" }],
  );
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.forms.update(form.form_id, body) : wfApi.forms.create(body)),
    onSuccess: () => { toast.success(isEdit ? "Form updated" : "Form created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateField = (i, patch) => setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, { label: "", type: "text", required: false, options: "", placeholder: "" }]);
  const removeField = (i) => setFields((fs) => fs.filter((_, idx) => idx !== i));

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    const clean = fields.filter((f) => f.label.trim());
    if (clean.length === 0) next.fields = "Add at least one field";
    if (Object.keys(next).length) { setErrors(next); return; }
    const payloadFields = clean.map((f, i) => {
      const opts = FIELD_TYPES_WITH_OPTIONS.has(f.type)
        ? f.options.split(",").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
        : [];
      return {
        id: `f_${i}`,
        label: f.label.trim(),
        type: f.type,
        placeholder: f.placeholder.trim() || null,
        options: opts,
        validation: { required: !!f.required },
        order: i,
      };
    });
    saving.mutate({ name: name.trim(), description: description.trim() || null, fields: payloadFields, is_active: isActive });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${form.name}` : "New form"}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FLabel required>Name</FLabel>
          <input value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }} className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`} placeholder="e.g. Fire response checklist" />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <FLabel>Description</FLabel>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD_CLS} placeholder="Optional" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <FLabel>Fields</FLabel>
          <button type="button" onClick={addField} className="text-xs text-blue-500 hover:underline">+ Add field</button>
        </div>
        {errors.fields && <p className="mb-2 text-xs text-red-500">{errors.fields}</p>}
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="rounded-lg border border-card-border bg-card p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Field label" className="h-9 flex-1 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
                <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value })} className="h-9 rounded-lg border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted">
                  {FIELD_TYPES.map((t) => <option key={t} value={t} className="bg-card">{titleize(t)}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer whitespace-nowrap"><input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required</label>
                <button type="button" onClick={() => removeField(i)} className="h-9 w-9 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
              </div>
              {FIELD_TYPES_WITH_OPTIONS.has(f.type) && (
                <input value={f.options} onChange={(e) => updateField(i, { options: e.target.value })} placeholder="Options (comma-separated), e.g. Low, Medium, High" className="h-9 w-full rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
              )}
            </div>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create form"}</Button>
      </div>
    </form>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Notification templates tab — subject/body with {{variable}} rendering
   ══════════════════════════════════════════════════════════════════ */
const TEMPLATE_VARS = ["instance_name", "sop_name", "from_state", "to_state", "priority", "site_id", "event_type"];

function NotificationTemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-templates"], queryFn: () => wfApi.notifications.templates.list({ limit: 200 }) });
  const templates = asItems(q.data);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => wfApi.notifications.templates.remove(id),
    onSuccess: () => { toast.success("Template removed"); qc.invalidateQueries({ queryKey: ["wf-templates"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center justify-between px-5 py-4 border-b border-card-border">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Notification templates</h3>
          <p className="text-xs text-muted">Reusable subject/body messages rendered with incident variables.</p>
        </div>
        {!form && <Button variant="success" icon="heroicons-outline:plus" onClick={() => setForm({})} className="!px-3 !py-1.5 text-xs">New template</Button>}
      </header>
      <div className="px-5 py-4 space-y-3">
        {form && (
          <TemplateForm
            template={form.template_id ? form : null}
            onCancel={() => setForm(null)}
            onSaved={() => { qc.invalidateQueries({ queryKey: ["wf-templates"] }); setForm(null); }}
          />
        )}
        {q.isLoading ? (
          <div className="text-sm text-muted flex items-center gap-2"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : templates.length === 0 && !form ? (
          <p className="text-sm text-muted">No templates yet.</p>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border">
            {templates.map((t) => (
              <li key={t.template_id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-hover">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-purple-500/10 text-purple-500 shrink-0"><Icon icon="heroicons-outline:bell-alert" className="text-base" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{t.name}</span>
                    <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted uppercase">{t.channel_type}</span>
                    {t.is_active === false && <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted">Inactive</span>}
                  </span>
                  <span className="block text-[11px] text-muted truncate">{t.subject || t.body?.slice(0, 80)}</span>
                </span>
                <button onClick={() => setForm(t)} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"><Icon icon="heroicons-outline:pencil-square" className="text-sm" /></button>
                <button onClick={() => setConfirm({ title: "Delete template?", message: `Delete "${t.name}"?`, confirmLabel: "Delete", onConfirm: () => { remove.mutate(t.template_id); setConfirm(null); } })} className="h-7 w-7 inline-flex items-center justify-center rounded text-red-500 hover:bg-red-500/10"><Icon icon="heroicons-outline:trash" className="text-sm" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function TemplateForm({ template, onCancel, onSaved }) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name || "");
  const [channelType, setChannelType] = useState(template?.channel_type || "email");
  const [subject, setSubject] = useState(template?.subject || "");
  const [body, setBody] = useState(template?.body || "");
  const [isActive, setIsActive] = useState(template?.is_active !== false);
  const [errors, setErrors] = useState({});
  const showSubject = channelType === "email";

  const saving = useMutation({
    mutationFn: (payload) => (isEdit ? wfApi.notifications.templates.update(template.template_id, payload) : wfApi.notifications.templates.create(payload)),
    onSuccess: () => { toast.success(isEdit ? "Template updated" : "Template created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!body.trim()) next.body = "Body is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    saving.mutate({
      name: name.trim(),
      channel_type: channelType,
      subject: showSubject ? (subject.trim() || null) : null,
      body: body,
      is_active: isActive,
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${template.name}` : "New template"}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FLabel required>Name</FLabel>
          <input value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }} className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`} placeholder="e.g. Fire escalation email" />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <FLabel>Channel</FLabel>
          <select value={channelType} onChange={(e) => setChannelType(e.target.value)} className={FIELD_CLS}>
            {CHANNEL_TYPES.map((c) => <option key={c} value={c} className="bg-card">{titleize(c)}</option>)}
          </select>
        </div>
      </div>
      {showSubject && (
        <div>
          <FLabel>Subject</FLabel>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={FIELD_CLS} placeholder="e.g. [{{priority}}] {{instance_name}}" />
        </div>
      )}
      <div>
        <FLabel required>Body</FLabel>
        <textarea rows={5} value={body} onChange={(e) => { setBody(e.target.value); if (errors.body) setErrors((p) => ({ ...p, body: undefined })); }} className={`mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted outline-none focus:border-muted ${errors.body ? "!border-red-500" : ""}`} placeholder="Incident {{instance_name}} moved {{from_state}} → {{to_state}}." />
        {errors.body && <p className="mt-1 text-xs text-red-500">{errors.body}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="text-[11px] text-muted">Variables:</span>
          {TEMPLATE_VARS.map((v) => (
            <button key={v} type="button" onClick={() => setBody((b) => `${b}{{${v}}}`)} className="text-[11px] font-mono rounded bg-card border border-card-border px-1.5 py-0.5 text-muted hover:text-foreground hover:bg-hover">{`{{${v}}}`}</button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create template"}</Button>
      </div>
    </form>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Threat levels tab — per-site (or deployment-wide) posture register
   ══════════════════════════════════════════════════════════════════ */
function ThreatLevelsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-threat-levels"], queryFn: () => wfApi.threatLevels.list() });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const levels = asItems(q.data);
  const sites = asItems(sitesQ.data);
  const siteName = (sid) => sites.find((s) => s.site_id === sid)?.name || sid || "Deployment-wide";

  const [siteId, setSiteId] = useState("");
  const [level, setLevel] = useState("normal");
  const [reason, setReason] = useState("");

  const set = useMutation({
    mutationFn: (body) => wfApi.threatLevels.set(body),
    onSuccess: () => { toast.success("Threat level set"); qc.invalidateQueries({ queryKey: ["wf-threat-levels"] }); setReason(""); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    set.mutate({ site_id: siteId || null, level, reason: reason.trim() || null });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-4">
      <form onSubmit={submit} className="rounded-xl border border-card-border bg-card p-5 space-y-4 h-fit">
        <h3 className="text-sm font-semibold text-foreground">Set threat level</h3>
        <div>
          <FLabel>Scope</FLabel>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={FIELD_CLS}>
            <option value="" className="bg-card">Deployment-wide</option>
            {sites.map((s) => <option key={s.site_id} value={s.site_id} className="bg-card">{s.name}</option>)}
          </select>
        </div>
        <div>
          <FLabel>Level</FLabel>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {THREAT_LEVELS.map((lv) => (
              <button key={lv} type="button" onClick={() => setLevel(lv)} className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition ${level === lv ? `${THREAT_COLOR[lv]} border-transparent` : "border-card-border text-muted hover:bg-hover"}`}>{lv}</button>
            ))}
          </div>
        </div>
        <div>
          <FLabel>Reason</FLabel>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted" placeholder="Optional context for the change" />
        </div>
        <Button type="submit" variant="success" disabled={set.isPending} className="w-full">{set.isPending ? "Setting…" : "Set threat level"}</Button>
      </form>

      <div className="rounded-xl border border-card-border bg-card overflow-hidden">
        <header className="px-5 py-4 border-b border-card-border">
          <h3 className="text-sm font-semibold text-foreground">Current posture</h3>
        </header>
        {q.isLoading ? (
          <div className="px-5 py-8 flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : levels.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted">No threat levels set. Everything is at normal posture.</div>
        ) : (
          <ul className="divide-y divide-card-border">
            {levels.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3">
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${THREAT_COLOR[r.level] || "bg-hover text-muted"}`}>{r.level}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-foreground">{siteName(r.site_id)}</span>
                  {r.reason && <span className="block text-[11px] text-muted">{r.reason}</span>}
                  <span className="block text-[11px] text-muted/70">{r.set_by ? `by ${r.set_by} · ` : ""}{r.set_at ? new Date(r.set_at).toLocaleString() : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
