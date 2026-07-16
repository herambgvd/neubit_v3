"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, CheckCircle2, PauseCircle, Plus, Users } from "lucide-react";

import { adminApi, apiError } from "@/lib/api";
import { Badge, Card, PageHeader, Skeleton, StatCard } from "@/components/ui";
import { buttonVariants } from "@/components/ui/button";
import { AreaTrend, BarList, ChartCard, DonutChart } from "@/components/charts";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

// Cumulative tenant count at the end of each of the last `months` months.
function growthSeries(tenants, months = 6) {
  const now = new Date();
  const out = [];
  for (let k = months - 1; k >= 0; k--) {
    const start = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const value = tenants.filter((t) => {
      const c = new Date(t.created_at);
      return !Number.isNaN(c.getTime()) && c < end;
    }).length;
    out.push({ label: start.toLocaleDateString(undefined, { month: "short" }), value });
  }
  return out;
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

  const growth = useMemo(() => growthSeries(tenants, 6), [tenants]);
  const license = useMemo(
    () => [
      { label: "Licensed", value: tenants.filter((t) => t.license_state === "active").length, color: "var(--success)" },
      { label: "Grace period", value: tenants.filter((t) => t.license_state === "grace").length, color: "var(--warning)" },
      { label: "Expired", value: tenants.filter((t) => t.license_state === "expired").length, color: "var(--danger)" },
    ],
    [tenants]
  );
  const plans = useMemo(() => {
    const counts = {};
    tenants.forEach((t) => {
      const p = t.plan || "Unassigned";
      counts[p] = (counts[p] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [tenants]);
  const topTenants = useMemo(
    () =>
      [...tenants]
        .sort((a, b) => (b.users ?? 0) - (a.users ?? 0))
        .slice(0, 5)
        .map((t) => ({ label: t.name, value: t.users ?? 0 })),
    [tenants]
  );

  return (
    <div>
      <PageHeader
        title="Platform overview"
        description="Tenants, users, and license health at a glance."
        actions={
          <Link href="/tenants" className={buttonVariants()}>
            <Plus className="h-4 w-4" />
            New tenant
          </Link>
        }
      />

      {isError ? (
        <Card className="border-danger/20 bg-danger/5 p-5 text-sm text-danger">
          {apiError(error, "Failed to load platform data")}
        </Card>
      ) : isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-2xl" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Link href="/tenants">
              <StatCard label="Tenants" value={total} icon={Building2} className="transition hover:border-muted" />
            </Link>
            <StatCard label="Active" value={active} icon={CheckCircle2} tone="success" />
            <StatCard label="Suspended" value={suspended} icon={PauseCircle} tone="warning" />
            <StatCard label="Total users" value={users} icon={Users} />
          </div>

          {/* Analytics */}
          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <ChartCard
              title="Tenant growth"
              subtitle="Cumulative tenants over the last 6 months"
              className="lg:col-span-2"
            >
              <AreaTrend data={growth} />
            </ChartCard>

            <ChartCard title="License health" subtitle="Distribution across tenants">
              <DonutChart data={license} centerLabel="Tenants" />
            </ChartCard>

            <ChartCard title="Top tenants by users" subtitle="Highest seat usage" className="lg:col-span-2">
              <BarList data={topTenants} emptyLabel="No tenants yet" />
            </ChartCard>

            <ChartCard title="Plans" subtitle="Tenants by plan">
              <BarList data={plans} emptyLabel="No plans assigned" />
            </ChartCard>
          </div>

          <Card className="mt-6 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="h-4 w-4 text-warning" />
              License attention
            </div>
            {licenseTrouble.length === 0 ? (
              <p className="mt-3 text-sm text-muted">All tenant licenses are healthy. 🎉</p>
            ) : (
              <ul className="mt-3 divide-y divide-card-border">
                {licenseTrouble.map((t) => (
                  <li key={t.id} className="flex items-center justify-between py-2.5">
                    <Link href={`/tenants/${t.id}`} className="text-sm text-foreground transition hover:text-accent">
                      {t.name}
                    </Link>
                    <Badge tone={t.license_state === "expired" ? "danger" : "warning"}>
                      {t.license_state === "expired" ? "Expired" : "In grace period"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
