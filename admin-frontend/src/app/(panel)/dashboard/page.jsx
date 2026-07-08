"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  PauseCircle,
  Plus,
  Users,
} from "lucide-react";

import { adminApi, apiError } from "@/lib/api";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

function Stat({ icon: Icon, label, value, tone = "slate", href }) {
  const toneMap = {
    slate: "text-foreground",
    emerald: "text-emerald-600 dark:text-emerald-300",
    amber: "text-amber-600 dark:text-amber-300",
    cyan: "text-cyan-600 dark:text-cyan-300",
    red: "text-red-600 dark:text-red-300",
  };
  const body = (
    <div className="rounded-2xl border border-card-border bg-card p-5 transition hover:border-muted">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <Icon className={"h-4 w-4 " + toneMap[tone]} />
        {label}
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">{value}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["tenants", "dashboard"],
    queryFn: () => adminApi.listTenants({ page: 1, pageSize: 100 }),
  });

  const tenants = normalize(data);
  const total = data?.total ?? tenants.length;
  const active = tenants.filter((t) => t.status !== "suspended").length;
  const suspended = tenants.filter((t) => t.status === "suspended").length;
  const users = tenants.reduce((n, t) => n + (t.users ?? 0), 0);
  const licenseTrouble = tenants.filter(
    (t) => t.license_state === "expired" || t.license_state === "grace"
  );

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Platform overview</h1>
          <p className="mt-1 text-sm text-muted">Tenants, users, and license health at a glance.</p>
        </div>
        <Link
          href="/tenants"
          className="inline-flex items-center gap-2 rounded-lg bg-foreground px-3.5 py-2 text-sm font-semibold text-background transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New tenant
        </Link>
      </div>

      {isError ? (
        <div className="rounded-2xl border border-red-400/20 bg-red-500/5 p-5 text-sm text-red-600 dark:text-red-300">
          {apiError(error, "Failed to load platform data")}
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-card-border bg-card" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat icon={Building2} label="Tenants" value={total} tone="cyan" href="/tenants" />
            <Stat icon={CheckCircle2} label="Active" value={active} tone="emerald" />
            <Stat icon={PauseCircle} label="Suspended" value={suspended} tone="amber" />
            <Stat icon={Users} label="Total users" value={users} tone="slate" />
          </div>

          <div className="mt-6 rounded-2xl border border-card-border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300" />
              License attention
            </div>
            {licenseTrouble.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                All tenant licenses are healthy. 🎉
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-card-border">
                {licenseTrouble.map((t) => (
                  <li key={t.id} className="flex items-center justify-between py-2.5">
                    <Link href={`/tenants/${t.id}`} className="text-sm text-foreground hover:text-cyan-600 dark:hover:text-cyan-300">
                      {t.name}
                    </Link>
                    <span
                      className={
                        "rounded-full border px-2.5 py-0.5 text-xs font-medium " +
                        (t.license_state === "expired"
                          ? "border-red-400/20 bg-red-500/10 text-red-600 dark:text-red-300"
                          : "border-amber-400/20 bg-amber-500/10 text-amber-600 dark:text-amber-300")
                      }
                    >
                      {t.license_state === "expired" ? "Expired" : "In grace period"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
