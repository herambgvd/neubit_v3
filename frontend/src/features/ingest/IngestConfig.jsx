"use client";

// Ingest configuration — ported from neubit_v2's config/ingest + config/ingest-webhook,
// rethemed to neubit_v3's Vercel tokens + kit components. Two-pane layout matching
// Sites.jsx: LEFT a category list (search + CRUD), RIGHT the selected category's
// webhooks (list + create/edit + detail with the read-only public receiver URL).
//
// Adaptations vs neubit_v2:
//   • CSS-var theme → semantic tokens (foreground/muted/card/hover…).
//   • lib/api/ingest axios module.
//   • The public receiver `/ingest/hooks/{token}` is server-only — we DISPLAY it
//     read-only with a copy button; we never call it from the UI.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, PageHeader, Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "./api";

const AUTH_TYPES = [
  { value: "none", label: "None (open)" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic auth" },
];
const AUTH_PILL = {
  none: "bg-hover text-muted border-card-border",
  api_key: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  basic: "bg-amber-500/10 text-amber-500 border-amber-500/20",
};
const authLabel = (t) => AUTH_TYPES.find((a) => a.value === t)?.label || t || "None";

// Build the public receiver URL shown to integrators (backend serves it).
// NOTE: the receiver is mounted at ROOT (/ingest/hooks/{token}), NOT under the
// /api/v1 prefix — the gateway routes /ingest/hooks straight to the ingest service.
function receiverUrl(token) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/ingest/hooks/${token || ""}`;
}

function copyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Could not copy"),
    );
  }
}

/* ─── Small themed form inputs (shared with the Sites port style) ── */
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
const AREA_CLS =
  "mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted outline-none transition focus:border-muted";

export default function IngestConfigPage() {
  const qc = useQueryClient();
  const catsQ = useQuery({
    queryKey: ["ingest-categories"],
    queryFn: () => ingestApi.categories.list({ limit: 100 }),
  });

  // The list endpoints may return either a bare array or {items,total}.
  const cats = useMemo(() => {
    const d = catsQ.data;
    return Array.isArray(d) ? d : d?.items || [];
  }, [catsQ.data]);

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit (category)
  const [closed, setClosed] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const catId = (c) => c.id ?? c.category_id;

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return cats;
    return cats.filter((c) =>
      [c.name, c.description].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [cats, q]);

  const selected = useMemo(
    () => cats.find((c) => catId(c) === selectedId) || null,
    [cats, selectedId],
  );

  useEffect(() => {
    if (mode === "view" && !closed && !selected && filtered[0]) {
      setSelectedId(catId(filtered[0]));
    }
  }, [filtered, selected, mode, closed]);

  const removeCat = useMutation({
    mutationFn: (id) => ingestApi.categories.remove(id),
    onSuccess: () => {
      toast.success("Category removed");
      qc.invalidateQueries({ queryKey: ["ingest-categories"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div>
      <PageHeader
        title="Ingest"
        subtitle="Receive events from external systems via categorized webhooks."
        actions={
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setMode("create")}>
            Add category
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-4 min-h-[70vh]">
        {/* ── Left: categories ─────────────────────────── */}
        <aside className="rounded-xl border border-card-border bg-card flex flex-col min-h-0">
          <header className="flex items-center justify-between px-4 py-3 border-b border-card-border">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Categories</span>
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                {cats.length}
              </span>
            </div>
          </header>
          <div className="p-3">
            <label className="relative block">
              <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-base" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search categories…"
                className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
              />
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {catsQ.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:squares-2x2" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {q.trim() ? "No categories match" : "No categories yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {q.trim() ? "Try a different keyword." : "Add a category to group webhooks."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((c) => {
                  const isSelected = catId(c) === selectedId && mode !== "create";
                  return (
                    <li key={catId(c)} className="relative">
                      <button
                        onClick={() => {
                          setSelectedId(catId(c));
                          setMode("view");
                          setClosed(false);
                        }}
                        className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
                          isSelected ? "bg-hover" : "hover:bg-hover"
                        }`}
                      >
                        {isSelected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 border border-card-border">
                          <Icon icon="heroicons-outline:squares-2x2" className="text-base" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold text-foreground truncate">{c.name}</span>
                          {c.description && (
                            <span className="block text-xs text-muted truncate">{c.description}</span>
                          )}
                          {typeof c.webhook_count === "number" && (
                            <span className="block text-[10px] text-muted/70">{c.webhook_count} webhook(s)</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right: category detail + webhooks ─────────── */}
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:arrow-down-on-square-stack" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No category selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add category</b>.
              </div>
            </div>
          ) : (
            <CategoryDetail
              category={selected}
              catId={catId(selected)}
              onEdit={() => setMode("edit")}
              onDelete={() =>
                setConfirm({
                  title: "Delete category?",
                  message: `Delete "${selected.name}" and all of its webhooks? This cannot be undone.`,
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    removeCat.mutate(catId(selected));
                    setConfirm(null);
                  },
                })
              }
            />
          )}
        </section>
      </div>

      {(mode === "create" || mode === "edit") && (
        <CategoryFormModal
          key={mode === "edit" ? selectedId : "create"}
          category={mode === "edit" ? selected : null}
          onCancel={() => setMode("view")}
          onSaved={(saved) => {
            qc.invalidateQueries({ queryKey: ["ingest-categories"] });
            const id = saved?.id ?? saved?.category_id;
            if (id) setSelectedId(id);
            setMode("view");
          }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={removeCat.isPending} />
    </div>
  );
}

/* ─── Category detail (header + webhooks panel) ─────────────────── */
function CategoryDetail({ category, catId, onEdit, onDelete }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500 shrink-0">
            <Icon icon="heroicons-outline:squares-2x2" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{category.name}</h2>
            {category.description && <p className="mt-0.5 text-xs text-muted">{category.description}</p>}
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        <WebhooksPanel category={category} catId={catId} />
      </div>
    </div>
  );
}

/* ─── Webhooks panel ────────────────────────────────────────────── */
function WebhooksPanel({ category, catId }) {
  const qc = useQueryClient();
  const key = ["ingest-webhooks", catId];
  const hooksQ = useQuery({
    queryKey: key,
    queryFn: () => ingestApi.webhooks.list({ category_id: catId, limit: 100 }),
  });
  const hooks = useMemo(() => {
    const d = hooksQ.data;
    return Array.isArray(d) ? d : d?.items || [];
  }, [hooksQ.data]);

  const hookId = (h) => h.id ?? h.webhook_id;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null); // webhook whose receiver URL is shown
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => ingestApi.webhooks.remove(id),
    onSuccess: () => {
      toast.success("Webhook removed");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Webhooks</h3>
          <p className="text-xs text-muted">
            {hooks.length} webhook(s) in <span className="font-medium">{category.name}</span>.
          </p>
        </div>
        {!creating && !editing && (
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setCreating(true)} className="!px-3 !py-1.5 text-xs">
            Add webhook
          </Button>
        )}
      </div>

      {(creating || editing) && (
        <WebhookForm
          categoryId={catId}
          webhook={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: key });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {!creating && !editing &&
        (hooksQ.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="!h-4 !w-4" /> Loading webhooks…
          </div>
        ) : hooks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-6 py-10 text-center text-sm text-muted">
            No webhooks yet. Click <b>Add webhook</b> to create one.
          </div>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border bg-card">
            {hooks.map((h) => (
              <li key={hookId(h)} className="px-4 py-3 hover:bg-hover">
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 border border-card-border">
                    <Icon icon="heroicons-outline:bolt" className="text-base" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{h.name}</span>
                      <span className={`text-[10px] rounded-full border px-1.5 py-0.5 font-medium ${AUTH_PILL[h.auth_type] || AUTH_PILL.none}`}>
                        {authLabel(h.auth_type)}
                      </span>
                      <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${h.is_active !== false ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"}`}>
                        {h.is_active !== false ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {h.token && (
                      <div className="mt-1 flex items-center gap-2">
                        <code className="text-[11px] font-mono text-muted truncate max-w-full">{receiverUrl(h.token)}</code>
                        <button
                          onClick={() => copyToClipboard(receiverUrl(h.token))}
                          title="Copy receiver URL"
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground shrink-0"
                        >
                          <Icon icon="heroicons-outline:clipboard-document" className="text-sm" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setDetail(h)} title="Details" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-blue-500">
                      <Icon icon="heroicons-outline:eye" className="text-sm" />
                    </button>
                    <button onClick={() => setEditing(h)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                      <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                    </button>
                    <button
                      onClick={() =>
                        setConfirm({
                          title: "Delete webhook?",
                          message: `Delete webhook "${h.name}"?`,
                          confirmLabel: "Delete",
                          onConfirm: () => {
                            remove.mutate(hookId(h));
                            setConfirm(null);
                          },
                        })
                      }
                      title="Delete"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                    >
                      <Icon icon="heroicons-outline:trash" className="text-sm" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {detail && (
        <WebhookDetailModal
          webhook={detail}
          onClose={() => setDetail(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: key })}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

/* ─── Webhook detail — Overview / Test / Events tabs ────────────── */
const OUTCOME_PILL = {
  ok: "bg-green-500/10 text-green-500",
  failed: "bg-red-500/10 text-red-500",
  skipped: "bg-hover text-muted",
};
const DETAIL_TABS = [
  { key: "overview", label: "Overview", icon: "heroicons-outline:information-circle" },
  { key: "test", label: "Test", icon: "heroicons-outline:beaker" },
  { key: "events", label: "Recent events", icon: "heroicons-outline:queue-list" },
];

function WebhookDetailModal({ webhook, onClose, onChanged }) {
  const [tab, setTab] = useState("overview");
  const [token, setToken] = useState(webhook.token); // updates live after a rotate
  const [confirm, setConfirm] = useState(null);
  const hookId = webhook.id ?? webhook.webhook_id;

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rotate = useMutation({
    mutationFn: () => ingestApi.webhooks.rotateSecret(hookId, false),
    onSuccess: (res) => {
      toast.success("Receiver token rotated");
      if (res?.token) setToken(res.token);
      onChanged?.();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const url = receiverUrl(token);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl bg-card border border-card-border shadow-2xl animate-modal-in flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4 shrink-0">
          <h3 className="text-base font-semibold text-foreground">{webhook.name}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        <nav className="flex items-stretch gap-0.5 border-b border-card-border px-3 shrink-0">
          {DETAIL_TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${active ? "text-foreground border-foreground" : "text-muted border-transparent hover:text-foreground"}`}
              >
                <Icon icon={t.icon} className="text-base" />
                {t.label}
              </button>
            );
          })}
        </nav>

        <div className="px-6 py-5 overflow-y-auto">
          {tab === "overview" && (
            <div className="space-y-5">
              <div>
                <FLabel>Public receiver URL</FLabel>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground break-all">{url}</code>
                  <button onClick={() => copyToClipboard(url)} className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-2 text-xs text-foreground hover:bg-hover shrink-0">
                    <Icon icon="heroicons-outline:clipboard-document" className="text-sm" /> Copy
                  </button>
                  <button
                    onClick={() => setConfirm({
                      title: "Rotate receiver token?",
                      message: "The current URL will stop working immediately. Any integrations must be updated to the new URL.",
                      confirmLabel: "Rotate",
                      onConfirm: () => { rotate.mutate(); setConfirm(null); },
                    })}
                    disabled={rotate.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-500 hover:bg-amber-500/20 shrink-0 disabled:opacity-50"
                  >
                    <Icon icon="heroicons-outline:arrow-path" className="text-sm" /> Rotate
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-muted/70">Point your external system at this URL to POST events.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><FLabel>Auth type</FLabel><p className="mt-1 text-sm text-foreground">{authLabel(webhook.auth_type)}</p></div>
                <div><FLabel>Status</FLabel><p className="mt-1 text-sm text-foreground">{webhook.is_active !== false ? "Active" : "Inactive"}</p></div>
              </div>
              <div>
                <FLabel>Transform (field map)</FLabel>
                <pre className="mt-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                  {webhook.transform && Object.keys(webhook.transform).length ? JSON.stringify(webhook.transform, null, 2) : "—"}
                </pre>
              </div>
              <div>
                <FLabel>Schema (JSON)</FLabel>
                <pre className="mt-1 rounded-lg border border-field bg-hover/40 px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all max-h-52 overflow-auto">
                  {webhook.payload_schema && Object.keys(webhook.payload_schema).length ? JSON.stringify(webhook.payload_schema, null, 2) : "—"}
                </pre>
              </div>
            </div>
          )}

          {tab === "test" && <WebhookTestPanel hookId={hookId} />}
          {tab === "events" && <WebhookEventsPanel hookId={hookId} />}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={rotate.isPending} />
    </div>
  );
}

/* ─── Test panel — dry-run validate + transform (no publish/log) ── */
function WebhookTestPanel({ hookId }) {
  const [sample, setSample] = useState('{\n  "event": {\n    "name": "Door forced",\n    "severity": "high"\n  }\n}');
  const [jsonErr, setJsonErr] = useState("");

  const run = useMutation({
    mutationFn: (payload) => ingestApi.webhooks.test(hookId, payload),
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    let payload;
    try { payload = JSON.parse(sample); }
    catch { setJsonErr("Sample must be valid JSON"); return; }
    setJsonErr("");
    run.mutate(payload);
  }

  const res = run.data;
  return (
    <div className="space-y-4">
      <div>
        <FLabel>Sample payload (JSON)</FLabel>
        <textarea
          rows={7}
          value={sample}
          onChange={(e) => { setSample(e.target.value); if (jsonErr) setJsonErr(""); }}
          className={`${AREA_CLS} ${jsonErr ? "!border-red-500" : ""}`}
        />
        {jsonErr && <p className="mt-1 text-xs text-red-500">{jsonErr}</p>}
        <p className="mt-1 text-[11px] text-muted/70">Runs schema validation + JMESPath transform. Nothing is published or logged.</p>
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={run.isPending} icon="heroicons-outline:play" className="!px-3 !py-1.5 text-xs">
          {run.isPending ? "Running…" : "Run test"}
        </Button>
      </div>

      {res && (
        <div className="space-y-3 rounded-lg border border-card-border bg-hover/30 p-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Schema</span>
            <span className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${res.schema_valid ? OUTCOME_PILL.ok : OUTCOME_PILL.failed}`}>
              {res.schema_valid ? "Valid" : "Invalid"}
            </span>
            {res.would_publish_subject && (
              <span className="ml-auto text-[11px] font-mono text-muted truncate">→ {res.would_publish_subject}</span>
            )}
          </div>
          {Array.isArray(res.schema_errors) && res.schema_errors.length > 0 && (
            <ul className="text-xs text-red-500 list-disc list-inside space-y-0.5">
              {res.schema_errors.map((er, i) => <li key={i}>{typeof er === "string" ? er : JSON.stringify(er)}</li>)}
            </ul>
          )}
          {Array.isArray(res.transform_errors) && res.transform_errors.length > 0 && (
            <ul className="text-xs text-red-500 list-disc list-inside space-y-0.5">
              {res.transform_errors.map((er, i) => <li key={i}>{typeof er === "string" ? er : JSON.stringify(er)}</li>)}
            </ul>
          )}
          <div>
            <FLabel>Transformed output</FLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all max-h-52 overflow-auto">
              {res.transformed !== undefined && res.transformed !== null ? JSON.stringify(res.transformed, null, 2) : "—"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Recent events panel — inbound audit log for this webhook ───── */
function WebhookEventsPanel({ hookId }) {
  const qc = useQueryClient();
  const key = ["ingest-event-logs", hookId];
  const q = useQuery({ queryKey: key, queryFn: () => ingestApi.eventLogs.list({ webhook_id: hookId, limit: 30 }) });
  const rows = useMemo(() => { const d = q.data; return Array.isArray(d) ? d : d?.items || []; }, [q.data]);
  const [expanded, setExpanded] = useState(null);

  const replay = useMutation({
    mutationFn: (id) => ingestApi.eventLogs.replay(id),
    onSuccess: () => { toast.success("Event replayed"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast.error(apiError(e)),
  });

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted"><Spinner className="!h-4 !w-4" /> Loading events…</div>;
  if (rows.length === 0) return <p className="text-sm text-muted py-6 text-center">No inbound events recorded yet.</p>;

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

  return (
    <ul className="rounded-lg border border-card-border divide-y divide-card-border">
      {rows.map((r) => {
        const open = expanded === r.id;
        return (
          <li key={r.id} className="text-sm">
            <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-hover">
              <button onClick={() => setExpanded(open ? null : r.id)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="text-muted text-sm shrink-0" />
                <span className="text-xs text-muted font-mono shrink-0">{fmt(r.received_at)}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${OUTCOME_PILL[r.auth_outcome] || OUTCOME_PILL.skipped}`}>auth {r.auth_outcome}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${OUTCOME_PILL[r.schema_outcome] || OUTCOME_PILL.skipped}`}>schema {r.schema_outcome}</span>
                {r.published ? (
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-green-500/10 text-green-500">published</span>
                ) : (
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-hover text-muted">not published</span>
                )}
                {r.is_replay && <span className="text-[10px] rounded-full px-1.5 py-0.5 font-medium bg-blue-500/10 text-blue-500">replay</span>}
              </button>
              <button onClick={() => replay.mutate(r.id)} disabled={replay.isPending} title="Replay" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-blue-500 shrink-0 disabled:opacity-50">
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            </div>
            {open && <EventLogDetail id={r.id} error={r.error} />}
          </li>
        );
      })}
    </ul>
  );
}

function EventLogDetail({ id, error }) {
  const q = useQuery({ queryKey: ["ingest-event-log", id], queryFn: () => ingestApi.eventLogs.get(id) });
  const d = q.data;
  return (
    <div className="px-4 py-3 bg-hover/30 border-t border-card-border space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted"><Spinner className="!h-3.5 !w-3.5" /> Loading…</div>
      ) : (
        <>
          <div>
            <FLabel>Raw payload</FLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {d?.raw_payload ? JSON.stringify(d.raw_payload, null, 2) : "—"}{d?.raw_truncated ? "\n… (truncated)" : ""}
            </pre>
          </div>
          <div>
            <FLabel>Transformed</FLabel>
            <pre className="mt-1 rounded-lg border border-field bg-card px-3 py-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {d?.transformed_payload ? JSON.stringify(d.transformed_payload, null, 2) : "—"}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Category create / edit modal ──────────────────────────────── */
function CategoryFormModal({ category, onCancel, onSaved }) {
  const isEdit = !!category;
  const [name, setName] = useState(category?.name || "");
  const [description, setDescription] = useState(category?.description || "");
  const [errors, setErrors] = useState({});

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onCancel?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const saving = useMutation({
    mutationFn: (body) => {
      const id = category?.id ?? category?.category_id;
      return isEdit ? ingestApi.categories.update(id, body) : ingestApi.categories.create(body);
    },
    onSuccess: (saved) => {
      toast.success(isEdit ? "Category updated" : "Category created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    saving.mutate({ name: name.trim(), description: description.trim() || null });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-xl bg-card border border-card-border shadow-2xl animate-modal-in">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">{isEdit ? `Edit ${category?.name}` : "Create category"}</h3>
          <button onClick={onCancel} className="text-muted hover:text-foreground transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <form noValidate onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <FLabel required>Name</FLabel>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors({});
              }}
              placeholder="e.g. Access Control"
              className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
            />
            {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
          </div>
          <div>
            <FLabel>Description</FLabel>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className={AREA_CLS.replace("font-mono ", "")}
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="success" disabled={saving.isPending}>
              {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Webhook create / edit form ────────────────────────────────── */
function WebhookForm({ categoryId, webhook, onCancel, onSaved }) {
  const isEdit = !!webhook;
  const [name, setName] = useState(webhook?.name || "");
  const [authType, setAuthType] = useState(webhook?.auth_type || "none");
  const [transform, setTransform] = useState(
    webhook?.transform && Object.keys(webhook.transform).length ? JSON.stringify(webhook.transform, null, 2) : "",
  );
  const [schema, setSchema] = useState(
    webhook?.payload_schema && Object.keys(webhook.payload_schema).length
      ? JSON.stringify(webhook.payload_schema, null, 2)
      : "",
  );
  const [isActive, setIsActive] = useState(webhook?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => {
      const id = webhook?.id ?? webhook?.webhook_id;
      return isEdit ? ingestApi.webhooks.update(id, body) : ingestApi.webhooks.create(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Webhook updated" : "Webhook created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    // Both fields are JSON objects on the backend (payload_schema: dict, transform: {key: JMESPath}).
    let parsedSchema = {};
    if (schema.trim()) {
      try { parsedSchema = JSON.parse(schema); }
      catch { next.schema = "Schema must be valid JSON"; }
    }
    let parsedTransform = {};
    if (transform.trim()) {
      try { parsedTransform = JSON.parse(transform); }
      catch { next.transform = "Transform must be a valid JSON object"; }
    }
    if (parsedTransform && (typeof parsedTransform !== "object" || Array.isArray(parsedTransform))) {
      next.transform = "Transform must be a JSON object of { field: expression }";
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      auth_type: authType,
      transform: parsedTransform,
      payload_schema: parsedSchema,
      is_active: isActive,
    };
    if (!isEdit) body.category_id = categoryId;
    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit webhook · ${webhook.name}` : "Add webhook"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FLabel required>Name</FLabel>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="Enter webhook name"
            className={`${FIELD_CLS} ${errors.name ? "!border-red-500" : ""}`}
          />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <FLabel>Auth type</FLabel>
          <select value={authType} onChange={(e) => setAuthType(e.target.value)} className={FIELD_CLS}>
            {AUTH_TYPES.map((a) => (
              <option key={a.value} value={a.value} className="bg-card">{a.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <FLabel>Transform (field map)</FLabel>
        <textarea
          rows={3}
          value={transform}
          onChange={(e) => {
            setTransform(e.target.value);
            if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
          }}
          placeholder={'{\n  "title": "event.name",\n  "priority": "event.severity"\n}'}
          className={`${AREA_CLS} ${errors.transform ? "!border-red-500" : ""}`}
        />
        {errors.transform && <p className="mt-1 text-xs text-red-500">{errors.transform}</p>}
        <p className="mt-1 text-[11px] text-muted/70">
          Optional JSON object mapping each output field to a JMESPath expression over the incoming payload.
        </p>
      </div>

      <div>
        <FLabel>Schema (JSON)</FLabel>
        <textarea
          rows={5}
          value={schema}
          onChange={(e) => {
            setSchema(e.target.value);
            if (errors.schema) setErrors((p) => ({ ...p, schema: undefined }));
          }}
          placeholder='{ "type": "object", "properties": { ... } }'
          className={`${AREA_CLS} ${errors.schema ? "!border-red-500" : ""}`}
        />
        {errors.schema && <p className="mt-1 text-xs text-red-500">{errors.schema}</p>}
        <p className="mt-1 text-[11px] text-muted/70">Optional JSON Schema to validate the transformed payload.</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}
