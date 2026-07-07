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
      <h1 className="text-xl font-semibold tracking-tight text-white">Profile</h1>
      <p className="mt-1 text-sm text-slate-400">Your super-admin account.</p>

      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded-lg bg-white/5" />
        ) : isError ? (
          <p className="text-sm text-red-300">{apiError(error, "Could not load profile")}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-lg font-bold text-black">
                {(data?.full_name || data?.email || "?").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div className="text-lg font-semibold text-white">{data?.full_name || "—"}</div>
                <div className="text-sm text-slate-400">{data?.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-200">
              <ShieldCheck className="h-4 w-4" />
              Platform super-admin — full cross-tenant access.
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Role</dt>
                <dd className="text-slate-200">{data?.role?.name || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt>
                <dd className="text-slate-200">{data?.is_active ? "Active" : "Disabled"}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
