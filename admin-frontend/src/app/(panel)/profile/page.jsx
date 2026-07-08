"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { adminApi, apiError } from "@/lib/api";

export default function ProfilePage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["me"],
    queryFn: adminApi.me,
  });

  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Profile</h1>
      <p className="mt-1 text-sm text-muted">Your super-admin account.</p>

      <div className="mt-6 rounded-2xl border border-card-border bg-card p-6">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded-lg bg-hover" />
        ) : isError ? (
          <p className="text-sm text-red-600 dark:text-red-300">{apiError(error, "Could not load profile")}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-lg font-bold text-background">
                {(data?.full_name || data?.email || "?").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">{data?.full_name || "—"}</div>
                <div className="text-sm text-muted">{data?.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-700 dark:text-cyan-200">
              <ShieldCheck className="h-4 w-4" />
              Platform super-admin — full cross-tenant access.
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Role</dt>
                <dd className="text-foreground">{data?.role?.name || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
                <dd className="text-foreground">{data?.is_active ? "Active" : "Disabled"}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
