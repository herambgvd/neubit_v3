"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronLeft, ChevronRight, Loader2, Plus, Search, Users, X } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/web/api";

const PAGE_SIZE = 20;

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function StatusBadge({ status }) {
  const active = status !== "suspended";
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium " +
        (active
          ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-300"
          : "border-amber-400/20 bg-amber-500/10 text-amber-300")
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + (active ? "bg-emerald-400" : "bg-amber-400")} />
      {active ? "Active" : "Suspended"}
    </span>
  );
}

function LicenseBadge({ state }) {
  const map = {
    active: ["border-white/10 bg-white/[0.04] text-slate-300", "Licensed"],
    grace: ["border-amber-400/20 bg-amber-500/10 text-amber-300", "Grace"],
    expired: ["border-red-400/20 bg-red-500/10 text-red-300", "Expired"],
  };
  const [cls, label] = map[state] || map.active;
  return <span className={"rounded-full border px-2.5 py-0.5 text-xs font-medium " + cls}>{label}</span>;
}

export default function TenantsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["tenants", { q, status, page }],
    queryFn: () => adminApi.listTenants({ page, pageSize: PAGE_SIZE, q, status }),
    placeholderData: keepPreviousData,
  });

  const tenants = data?.items ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? tenants.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["tenants"] });

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Tenants</h1>
          <p className="mt-1 text-sm text-slate-400">Manage every organization on the platform.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
        >
          <Plus className="h-4 w-4" />
          Create tenant
        </button>
      </div>

      {/* Search + status filter */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search name or slug…"
            className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.04] pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
          {[
            ["", "All"],
            ["active", "Active"],
            ["suspended", "Suspended"],
          ].map(([val, label]) => (
            <button
              key={val || "all"}
              onClick={() => {
                setStatus(val);
                setPage(1);
              }}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (status === val ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">License</th>
              <th className="px-5 py-3 font-medium">Plan</th>
              <th className="px-5 py-3 font-medium">Users</th>
              <th className="px-5 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows />}

            {isError && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-sm text-red-300">
                  {apiError(error, "Failed to load tenants")}
                </td>
              </tr>
            )}

            {!isLoading && !isError && tenants.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-cyan-300">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-slate-200">
                      {q || status ? "No matching tenants" : "No tenants yet"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {q || status ? "Try a different search or filter." : "Create your first tenant."}
                    </p>
                  </div>
                </td>
              </tr>
            )}

            {!isLoading &&
              !isError &&
              tenants.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b border-white/5 last:border-0 transition hover:bg-white/[0.03]"
                  onClick={() => (window.location.href = `/tenants/${t.id}`)}
                >
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/tenants/${t.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-white hover:text-cyan-300"
                    >
                      {t.name}
                    </Link>
                    <div className="font-mono text-xs text-slate-500">{t.slug}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-5 py-3.5">
                    <LicenseBadge state={t.license_state} />
                  </td>
                  <td className="px-5 py-3.5 text-slate-300">{t.plan || "—"}</td>
                  <td className="px-5 py-3.5 text-slate-300">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-slate-500" />
                      {t.users ?? 0}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">{fmtDate(t.created_at)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
        <span>
          {total} tenant{total === 1 ? "" : "s"}
          {isFetching ? " · updating…" : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 transition hover:border-white/20 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="tabular-nums">
            Page {page} / {pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 transition hover:border-white/20 disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateTenantModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function SkeletonRows() {
  return Array.from({ length: 5 }).map((_, i) => (
    <tr key={i} className="border-b border-white/5 last:border-0">
      {Array.from({ length: 6 }).map((__, j) => (
        <td key={j} className="px-5 py-4">
          <div className="h-3.5 w-full max-w-[120px] animate-pulse rounded bg-white/10" />
        </td>
      ))}
    </tr>
  ));
}

function CreateTenantModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  const create = useMutation({
    mutationFn: () =>
      adminApi.createTenant({
        name: name.trim(),
        admin_email: adminEmail.trim(),
        admin_password: adminPassword,
      }),
    onSuccess: () => {
      toast.success("Tenant created");
      onCreated();
    },
    onError: (err) => toast.error(apiError(err, "Could not create tenant")),
  });

  function onSubmit(e) {
    e.preventDefault();
    if (create.isPending) return;
    if (!name.trim() || !adminEmail.trim() || !adminPassword) {
      toast.error("All fields are required");
      return;
    }
    create.mutate();
  }

  const inputCls =
    "h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 hover:border-white/20";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-modal-in relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0a0a] p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-white">Create tenant</h2>
            <p className="mt-1 text-xs text-slate-400">Provision an organization and its first admin.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Organization name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corporation" autoFocus required className={inputCls} />
          </Field>
          <Field label="Admin email">
            <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@acme.com" required className={inputCls} />
          </Field>
          <Field label="Admin password">
            <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="••••••••" required className={inputCls} />
          </Field>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled={create.isPending} className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60">
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create tenant
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}
