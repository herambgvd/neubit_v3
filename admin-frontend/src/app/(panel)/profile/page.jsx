"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { adminApi, apiError } from "@/lib/api";
import { Card, PageHeader, Skeleton } from "@/components/ui";

export default function ProfilePage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["me"],
    queryFn: adminApi.me,
  });

  return (
    <div className="max-w-lg">
      <PageHeader title="Profile" description="Your super-admin account." />

      <Card className="p-6">
        {isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : isError ? (
          <p className="text-sm text-danger">{apiError(error, "Could not load profile")}</p>
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
            <div className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-accent">
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
      </Card>
    </div>
  );
}
