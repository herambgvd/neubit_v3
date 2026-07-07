"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  Loader2,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/web/api";

// The operator console origin (where impersonation opens). Same host, gateway :80.
const OPERATOR_ORIGIN =
  (process.env.NEXT_PUBLIC_OPERATOR_URL || "http://localhost").replace(/\/$/, "");

const cardCls = "rounded-2xl border border-white/10 bg-white/[0.03] p-5";
const inputCls =
  "h-10 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20";

function LicensePill({ state }) {
  const map = {
    active: ["border-emerald-400/20 bg-emerald-500/10 text-emerald-300", "Licensed"],
    grace: ["border-amber-400/20 bg-amber-500/10 text-amber-300", "Grace period"],
    expired: ["border-red-400/20 bg-red-500/10 text-red-300", "Expired"],
  };
  const [cls, label] = map[state] || map.active;
  return <span className={"rounded-full border px-2.5 py-0.5 text-xs font-medium " + cls}>{label}</span>;
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
      const url = `${OPERATOR_ORIGIN}/impersonate#access=${encodeURIComponent(data.access_token)}`;
      window.open(url, "_blank", "noopener");
      toast.success(`Opening console as ${data.user_email}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (tenantQ.isLoading) {
    return <div className="h-40 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />;
  }
  if (tenantQ.isError) {
    return (
      <div className="rounded-2xl border border-red-400/20 bg-red-500/5 p-5 text-sm text-red-300">
        {apiError(tenantQ.error, "Tenant not found")}
        <div className="mt-3">
          <Link href="/tenants" className="text-cyan-300 hover:underline">← Back to tenants</Link>
        </div>
      </div>
    );
  }

  const suspended = t.status === "suspended";

  return (
    <div className="space-y-6">
      <Link href="/tenants" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Tenants
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-white">{t.name}</h1>
            <LicensePill state={t.license_state} />
            {suspended && (
              <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                Suspended
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500">{t.slug}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => impersonate.mutate()}
            disabled={impersonate.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-50"
          >
            {impersonate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            Open console
          </button>
          <button
            onClick={() => setStatus.mutate(!suspended)}
            disabled={setStatus.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white disabled:opacity-50"
          >
            {suspended ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {suspended ? "Reactivate" : "Suspend"}
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete tenant "${t.name}" and all its users? This cannot be undone.`))
                remove.mutate();
            }}
            disabled={remove.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-500/5 px-3 py-2 text-sm font-medium text-red-300 transition hover:border-red-400/40 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
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
    <div className={cardCls}>
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <KeyRound className="h-4 w-4 text-cyan-300" /> License &amp; entitlements
      </div>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <L label="Plan / tier">
            <input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="pro" className={inputCls} />
          </L>
          <L label="Grace days (after expiry)">
            <input type="number" min={0} value={grace} onChange={(e) => setGrace(e.target.value)} className={inputCls} />
          </L>
        </div>
        <L label="License expires (blank = perpetual)">
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className={inputCls} />
        </L>
        <L label="Features (JSON)">
          <textarea
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            rows={4}
            spellCheck={false}
            className={inputCls + " h-auto py-2 font-mono text-xs"}
          />
        </L>
        <L label="Limits / quotas (JSON, e.g. {&quot;max_users&quot;: 50})">
          <textarea
            value={limits}
            onChange={(e) => setLimits(e.target.value)}
            rows={4}
            spellCheck={false}
            className={inputCls + " h-auto py-2 font-mono text-xs"}
          />
        </L>
        <div className="flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save license
          </button>
        </div>
      </div>
    </div>
  );
}

function UsageCard({ usage, loading }) {
  const users = usage?.users ?? 0;
  const max = usage?.limits?.max_users;
  const hasLimit = typeof max === "number" && max >= 0;
  const pct = hasLimit && max > 0 ? Math.min(100, Math.round((users / max) * 100)) : 0;
  return (
    <div className={cardCls}>
      <div className="mb-4 text-sm font-semibold text-white">Usage</div>
      {loading ? (
        <div className="h-16 animate-pulse rounded-lg bg-white/5" />
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-400">Users</span>
            <span className="text-sm font-medium text-white">
              {users}
              {hasLimit ? <span className="text-slate-500"> / {max}</span> : null}
            </span>
          </div>
          {hasLimit ? (
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className={
                  "h-full rounded-full " +
                  (pct >= 90 ? "bg-red-400" : pct >= 70 ? "bg-amber-400" : "bg-emerald-400")
                }
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : (
            <p className="text-xs text-slate-500">No user quota set — unlimited.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AdminsCard({ tenantId, admins, loading, onChange }) {
  const [showAdd, setShowAdd] = useState(false);

  const del = useMutation({
    mutationFn: (userId) => adminApi.deleteTenantAdmin(tenantId, userId),
    onSuccess: () => {
      toast.success("User removed");
      onChange();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className={cardCls}>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-semibold text-white">Tenant users</div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
        >
          <UserPlus className="h-3.5 w-3.5" /> Add user
        </button>
      </div>

      {showAdd && <AddAdminForm tenantId={tenantId} onDone={() => { setShowAdd(false); onChange(); }} />}

      {loading ? (
        <div className="h-10 animate-pulse rounded-lg bg-white/5" />
      ) : admins.length === 0 ? (
        <p className="text-sm text-slate-500">No users.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {admins.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2.5">
              <div>
                <div className="text-sm text-white">{u.full_name || u.email}</div>
                <div className="text-xs text-slate-500">{u.email}</div>
              </div>
              <button
                onClick={() => {
                  if (window.confirm(`Remove ${u.email}?`)) del.mutate(u.id);
                }}
                disabled={del.isPending}
                className="rounded-lg border border-red-400/20 bg-red-500/5 p-1.5 text-red-300 transition hover:border-red-400/40 hover:bg-red-500/10 disabled:opacity-50"
                aria-label="Remove user"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
      className="mb-4 grid gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:grid-cols-3"
    >
      <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name (optional)" className={inputCls} />
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@org.com" required className={inputCls} />
      <div className="flex gap-2">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required className={inputCls} />
        <button
          type="submit"
          disabled={create.isPending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </button>
      </div>
    </form>
  );
}

function L({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-slate-400">{label}</label>
      {children}
    </div>
  );
}
