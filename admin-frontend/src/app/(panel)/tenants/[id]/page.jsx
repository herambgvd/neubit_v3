"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Skeleton,
  Textarea,
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

function LicenseCard({ tenant, onSaved }) {
  const [plan, setPlan] = useState(tenant.plan || "");
  const [expires, setExpires] = useState(toLocalInput(tenant.license_expires_at));
  const [grace, setGrace] = useState(tenant.grace_days ?? 0);
  const [features, setFeatures] = useState(JSON.stringify(tenant.features || {}, null, 2));
  const [limits, setLimits] = useState(JSON.stringify(tenant.limits || {}, null, 2));

  const save = useMutation({
    mutationFn: () => {
      let f, l;
      try {
        f = features.trim() ? JSON.parse(features) : {};
        l = limits.trim() ? JSON.parse(limits) : {};
      } catch {
        throw new Error("Features and Limits must be valid JSON");
      }
      const body = {
        plan: plan.trim() || null,
        features: f,
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
      <div className="space-y-4">
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
        <Field label="Features (JSON)">
          <Textarea value={features} onChange={(e) => setFeatures(e.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" />
        </Field>
        <Field label='Limits / quotas (JSON, e.g. {"max_users": 50})'>
          <Textarea value={limits} onChange={(e) => setLimits(e.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" />
        </Field>
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

function UsageCard({ usage, loading }) {
  const users = usage?.users ?? 0;
  const max = usage?.limits?.max_users;
  const hasLimit = typeof max === "number" && max >= 0;
  const pct = hasLimit && max > 0 ? Math.min(100, Math.round((users / max) * 100)) : 0;
  return (
    <Card className="p-5">
      <div className="mb-4 text-sm font-semibold text-foreground">Usage</div>
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">Users</span>
            <span className="text-sm font-medium text-foreground">
              {users}
              {hasLimit ? <span className="text-muted"> / {max}</span> : null}
            </span>
          </div>
          {hasLimit ? (
            <div className="h-2 w-full overflow-hidden rounded-full bg-hover">
              <div
                className={"h-full rounded-full " + (pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success")}
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : (
            <p className="text-xs text-muted">No user quota set — unlimited.</p>
          )}
        </div>
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
