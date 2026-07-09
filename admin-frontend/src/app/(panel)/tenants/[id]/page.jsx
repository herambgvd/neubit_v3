"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Blocks,
  Clock,
  ExternalLink,
  Gauge,
  KeyRound,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  UserCog,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";

// The operator console origin (where impersonation opens). Same host, gateway :80.
const OPERATOR_ORIGIN =
  (process.env.NEXT_PUBLIC_OPERATOR_URL || "http://localhost").replace(/\/$/, "");

function LicensePill({ state }) {
  const map = {
    active: ["success", "Licensed"],
    grace: ["warning", "Grace period"],
    expired: ["danger", "Expired"],
  };
  const [tone, label] = map[state] || map.active;
  return <Badge tone={tone}>{label}</Badge>;
}

// yyyy-MM-ddTHH:mm for <input type="datetime-local"> (local tz) from an ISO string.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TenantDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirmImpersonate, setConfirmImpersonate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tenantQ = useQuery({ queryKey: ["tenant", id], queryFn: () => adminApi.getTenant(id) });
  const usageQ = useQuery({ queryKey: ["tenant", id, "usage"], queryFn: () => adminApi.tenantUsage(id) });
  const adminsQ = useQuery({ queryKey: ["tenant", id, "admins"], queryFn: () => adminApi.listTenantAdmins(id) });

  const t = tenantQ.data;
  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["tenant", id] });
    qc.invalidateQueries({ queryKey: ["tenants"] });
  };

  const setStatus = useMutation({
    mutationFn: (suspend) => (suspend ? adminApi.suspendTenant(id) : adminApi.reactivateTenant(id)),
    onSuccess: (_r, suspend) => {
      refetchAll();
      toast.success(suspend ? "Tenant suspended" : "Tenant reactivated");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: () => adminApi.deleteTenant(id),
    onSuccess: () => {
      toast.success("Tenant deleted");
      qc.invalidateQueries({ queryKey: ["tenants"] });
      router.replace("/tenants");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const impersonate = useMutation({
    mutationFn: () => adminApi.impersonate(id),
    onSuccess: (data) => {
      setConfirmImpersonate(false);
      const url = `${OPERATOR_ORIGIN}/impersonate#access=${encodeURIComponent(data.access_token)}`;
      window.open(url, "_blank", "noopener");
      toast.success(`Opening console as ${data.user_email}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (tenantQ.isLoading) {
    return <Skeleton className="h-40 rounded-2xl" />;
  }
  if (tenantQ.isError) {
    return (
      <Card className="border-danger/20 bg-danger/5 p-5 text-sm text-danger">
        {apiError(tenantQ.error, "Tenant not found")}
        <div className="mt-3">
          <Link href="/tenants" className="text-accent hover:underline">
            ← Back to tenants
          </Link>
        </div>
      </Card>
    );
  }

  const suspended = t.status === "suspended";

  return (
    <div className="space-y-6">
      <Link href="/tenants" className="inline-flex items-center gap-2 text-sm text-muted transition hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Tenants
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t.name}</h1>
            <LicensePill state={t.license_state} />
            {suspended && <Badge tone="warning">Suspended</Badge>}
          </div>
          <div className="mt-1 font-mono text-xs text-muted">{t.slug}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="accent" onClick={() => setConfirmImpersonate(true)}>
            <ExternalLink className="h-4 w-4" />
            Open console
          </Button>
          <Button variant="outline" loading={setStatus.isPending} onClick={() => setStatus.mutate(!suspended)}>
            {suspended ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {suspended ? "Reactivate" : "Suspend"}
          </Button>
          <Button variant="danger-outline" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">
            <span className="inline-flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Activity
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <LicenseCard tenant={t} onSaved={refetchAll} />
            <UsageCard usage={usageQ.data} loading={usageQ.isLoading} />
          </div>

          <AdminsCard
            tenantId={id}
            admins={adminsQ.data || []}
            loading={adminsQ.isLoading}
            onChange={() => {
              qc.invalidateQueries({ queryKey: ["tenant", id, "admins"] });
              qc.invalidateQueries({ queryKey: ["tenant", id, "usage"] });
              qc.invalidateQueries({ queryKey: ["tenant", id] });
            }}
          />
        </TabsContent>

        <TabsContent value="activity">
          <ActivityCard tenantId={id} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmImpersonate}
        onOpenChange={setConfirmImpersonate}
        title={`Open ${t.name}'s console?`}
        description="You will sign in to the operator console as a tenant admin. This impersonation is recorded in the audit log."
        confirmLabel="Open console"
        variant="accent"
        loading={impersonate.isPending}
        onConfirm={() => impersonate.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${t.name}?`}
        description="This permanently removes the tenant and all its users. This cannot be undone."
        confirmLabel="Delete tenant"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

// A tidy human label for a snake/kebab limit key, e.g. "max_users" → "Max users".
function humanizeKey(key) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function LicenseCard({ tenant, onSaved }) {
  const [plan, setPlan] = useState(tenant.plan || "");
  const [expires, setExpires] = useState(toLocalInput(tenant.license_expires_at));
  const [grace, setGrace] = useState(tenant.grace_days ?? 0);
  // Structured entitlement state (replaces the old raw-JSON textareas).
  const [features, setFeatures] = useState(() => ({ ...(tenant.features || {}) }));
  const [limits, setLimits] = useState(() =>
    Object.entries(tenant.limits || {}).map(([key, value]) => ({ key, value: String(value ?? "") }))
  );

  // The platform module catalog drives the feature toggles: one switch per module.
  const modulesQ = useQuery({ queryKey: ["modules"], queryFn: () => adminApi.listModules() });
  const catalog = useMemo(() => {
    const rows = modulesQ.data?.items ?? modulesQ.data;
    return Array.isArray(rows) ? rows : [];
  }, [modulesQ.data]);

  // Any feature flags on the tenant that aren't in the catalog (legacy / custom
  // keys) still get a toggle so nothing is silently hidden or dropped on save.
  const extraFeatureKeys = useMemo(() => {
    const known = new Set(catalog.map((m) => m.key));
    return Object.keys(features).filter((k) => !known.has(k));
  }, [catalog, features]);

  const toggleFeature = (key, on) => setFeatures((f) => ({ ...f, [key]: on }));

  const setLimitRow = (i, patch) =>
    setLimits((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addLimitRow = () => setLimits((rows) => [...rows, { key: "", value: "" }]);
  const removeLimitRow = (i) => setLimits((rows) => rows.filter((_, j) => j !== i));

  const save = useMutation({
    mutationFn: () => {
      // Fold the structured limit rows back into a { key: number } object,
      // skipping blank keys and coercing values to finite numbers.
      const l = {};
      for (const { key, value } of limits) {
        const k = key.trim();
        if (!k) continue;
        const n = Number(value);
        if (value === "" || Number.isNaN(n)) {
          throw new Error(`Quota "${k}" must be a number`);
        }
        l[k] = n;
      }
      const body = {
        plan: plan.trim() || null,
        features,
        limits: l,
        grace_days: Number(grace) || 0,
        license_expires_at: expires ? new Date(expires).toISOString() : null,
      };
      return adminApi.setLicense(tenant.id, body);
    },
    onSuccess: () => {
      toast.success("License updated");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e, e.message || "Could not save license")),
  });

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <KeyRound className="h-4 w-4 text-accent" /> License &amp; entitlements
      </div>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plan / tier">
            <Input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="pro" />
          </Field>
          <Field label="Grace days (after expiry)">
            <Input type="number" min={0} value={grace} onChange={(e) => setGrace(e.target.value)} />
          </Field>
        </div>
        <Field label="License expires (blank = perpetual)">
          <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>

        {/* Modules / feature entitlements — one toggle per catalog module. */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
            <Blocks className="h-3.5 w-3.5" /> Modules
          </div>
          {modulesQ.isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : catalog.length === 0 && extraFeatureKeys.length === 0 ? (
            <p className="text-xs text-muted">No modules in the catalog yet.</p>
          ) : (
            <div className="divide-y divide-card-border rounded-lg border border-card-border">
              {catalog.map((m) => (
                <FeatureRow
                  key={m.key}
                  title={m.name || m.key}
                  subtitle={m.description || m.category}
                  checked={!!features[m.key]}
                  onChange={(on) => toggleFeature(m.key, on)}
                />
              ))}
              {extraFeatureKeys.map((k) => (
                <FeatureRow
                  key={k}
                  title={humanizeKey(k)}
                  subtitle="Custom flag (not in catalog)"
                  checked={!!features[k]}
                  onChange={(on) => toggleFeature(k, on)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Quota limits — structured key/number rows (replaces raw JSON). */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <Gauge className="h-3.5 w-3.5" /> Quotas / limits
            </div>
            <Button variant="ghost" size="sm" onClick={addLimitRow}>
              <Plus className="h-3.5 w-3.5" /> Add quota
            </Button>
          </div>
          {limits.length === 0 ? (
            <p className="text-xs text-muted">No quotas set — this tenant is unlimited.</p>
          ) : (
            <div className="space-y-2">
              {limits.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) => setLimitRow(i, { key: e.target.value })}
                    placeholder="max_users"
                    className="flex-1 font-mono text-xs"
                  />
                  <Input
                    type="number"
                    min={0}
                    value={row.value}
                    onChange={(e) => setLimitRow(i, { value: e.target.value })}
                    placeholder="50"
                    className="w-28"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeLimitRow(i)}
                    aria-label="Remove quota"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {!save.isPending && <Save className="h-4 w-4" />}
            Save license
          </Button>
        </div>
      </div>
    </Card>
  );
}

function FeatureRow({ title, subtitle, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm text-foreground">{title}</div>
        {subtitle ? <div className="truncate text-xs text-muted">{subtitle}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function UsageCard({ usage, loading }) {
  const users = usage?.users ?? 0;
  const limits = usage?.limits || {};
  const maxUsers = limits.max_users;
  const hasUserLimit = typeof maxUsers === "number" && maxUsers >= 0;
  const pct = hasUserLimit && maxUsers > 0 ? Math.min(100, Math.round((users / maxUsers) * 100)) : 0;
  // Every configured quota other than users — the control plane doesn't track live
  // counts for these (they live in tenant operational data), so we show the cap.
  const otherLimits = Object.entries(limits).filter(([k]) => k !== "max_users");

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Gauge className="h-4 w-4 text-accent" /> Usage &amp; quotas
      </div>
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : (
        <div className="space-y-5">
          {/* Users — the one resource the control plane counts live. */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">Users</span>
              <span className="text-sm font-medium text-foreground">
                {users}
                {hasUserLimit ? <span className="text-muted"> / {maxUsers}</span> : null}
              </span>
            </div>
            {hasUserLimit ? (
              <>
                <div className="h-2 w-full overflow-hidden rounded-full bg-hover">
                  <div
                    className={"h-full rounded-full transition-all " + (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-right text-xs text-muted">{pct}% used</div>
              </>
            ) : (
              <p className="text-xs text-muted">No user quota set — unlimited.</p>
            )}
          </div>

          {/* Other configured quotas — shown as caps (no live count available). */}
          {otherLimits.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-muted">Configured caps</div>
              <div className="divide-y divide-card-border rounded-lg border border-card-border">
                {otherLimits.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-muted">{humanizeKey(k)}</span>
                    <span className="font-medium text-foreground">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// --- Activity timeline (tenant-scoped audit) ---------------------------------
const ACTION_META = {
  "tenant.create": { label: "Tenant created", tone: "success", Icon: Plus },
  "tenant.update": { label: "Tenant updated", tone: "default", Icon: Pencil },
  "tenant.license": { label: "License updated", tone: "accent", Icon: KeyRound },
  "tenant.suspend": { label: "Tenant suspended", tone: "warning", Icon: Pause },
  "tenant.reactivate": { label: "Tenant reactivated", tone: "success", Icon: Play },
  "tenant.delete": { label: "Tenant deleted", tone: "danger", Icon: Trash2 },
  "tenant.impersonate": { label: "Console impersonation", tone: "accent", Icon: ExternalLink },
  "tenant.admin.create": { label: "User added", tone: "success", Icon: UserPlus },
  "tenant.admin.delete": { label: "User removed", tone: "danger", Icon: Trash2 },
  "user.set_active": { label: "User status changed", tone: "default", Icon: UserCog },
};

const TONE_CHIP = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent/15 text-accent",
  default: "bg-hover text-muted",
};

function metaFor(action) {
  return (
    ACTION_META[action] || {
      label: humanizeKey(action).replace(/\./g, " "),
      tone: "default",
      Icon: Activity,
    }
  );
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function ActivityCard({ tenantId }) {
  const q = useInfiniteQuery({
    queryKey: ["tenant", tenantId, "audit"],
    queryFn: ({ pageParam }) => adminApi.listAudit({ tenantId, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pages ? last.page + 1 : undefined),
  });

  const events = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages?.[0]?.total ?? 0;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4 text-accent" /> Activity timeline
        </div>
        {total > 0 && <span className="text-xs text-muted">{total} events</span>}
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : q.isError ? (
        <p className="text-sm text-danger">{apiError(q.error, "Could not load activity")}</p>
      ) : events.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No activity yet"
          description="Admin actions on this tenant — license changes, suspensions, user edits — will show up here."
        />
      ) : (
        <>
          <ol className="relative space-y-1 pl-2">
            {events.map((e, i) => {
              const { label, tone, Icon } = metaFor(e.action);
              const last = i === events.length - 1;
              return (
                <li key={e.id} className="relative flex gap-3 pb-4">
                  {/* Connector line */}
                  {!last && <span className="absolute left-[15px] top-8 bottom-0 w-px bg-card-border" />}
                  <span
                    className={"relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full " + (TONE_CHIP[tone] || TONE_CHIP.default)}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-sm font-medium text-foreground">{label}</span>
                      <span
                        className="inline-flex items-center gap-1 text-xs text-muted"
                        title={new Date(e.ts).toLocaleString()}
                      >
                        <Clock className="h-3 w-3" /> {timeAgo(e.ts)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      <span className="font-mono">{e.action}</span>
                      {e.actor_email ? <> · by {e.actor_email}</> : null}
                      {e.target_type ? (
                        <> · {e.target_type}
                          {e.target_id ? <span className="font-mono"> {String(e.target_id).slice(0, 8)}</span> : null}
                        </>
                      ) : null}
                    </div>
                    {e.meta && Object.keys(e.meta).length > 0 && (
                      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border border-card-border bg-hover p-2 font-mono text-[11px] text-muted">
                        {JSON.stringify(e.meta)}
                      </pre>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {q.hasNextPage && (
            <div className="mt-2 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                loading={q.isFetchingNextPage}
                onClick={() => q.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function AdminsCard({ tenantId, admins, loading, onChange }) {
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState(null);

  const del = useMutation({
    mutationFn: (userId) => adminApi.deleteTenantAdmin(tenantId, userId),
    onSuccess: () => {
      toast.success("User removed");
      setRemoving(null);
      onChange();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-semibold text-foreground">Tenant users</div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)}>
          <UserPlus className="h-3.5 w-3.5" /> Add user
        </Button>
      </div>

      {showAdd && <AddAdminForm tenantId={tenantId} onDone={() => { setShowAdd(false); onChange(); }} />}

      {loading ? (
        <Skeleton className="h-10 rounded-lg" />
      ) : admins.length === 0 ? (
        <p className="text-sm text-muted">No users.</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {admins.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2.5">
              <div>
                <div className="text-sm text-foreground">{u.full_name || u.email}</div>
                <div className="text-xs text-muted">{u.email}</div>
              </div>
              <Button
                variant="danger-outline"
                size="icon"
                onClick={() => setRemoving(u)}
                aria-label="Remove user"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove user?"
        description={removing ? `${removing.email} will lose access to this tenant.` : ""}
        confirmLabel="Remove"
        loading={del.isPending}
        onConfirm={() => removing && del.mutate(removing.id)}
      />
    </Card>
  );
}

function AddAdminForm({ tenantId, onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");

  const create = useMutation({
    mutationFn: () =>
      adminApi.createTenantAdmin(tenantId, {
        email: email.trim(),
        password,
        full_name: fullName.trim() || null,
      }),
    onSuccess: () => {
      toast.success("User added");
      onDone();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!email.trim() || !password) return toast.error("Email and password required");
        create.mutate();
      }}
      className="mb-4 grid gap-3 rounded-xl border border-card-border bg-card p-4 sm:grid-cols-3"
    >
      <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name (optional)" />
      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@org.com" required />
      <div className="flex gap-2">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required />
        <Button type="submit" size="icon" loading={create.isPending} aria-label="Add user">
          {!create.isPending && <Plus className="h-4 w-4" />}
        </Button>
      </div>
    </form>
  );
}
