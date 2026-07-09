"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellRing,
  CheckCheck,
  CircleAlert,
  Clock,
  CreditCard,
  Info,
  KeyRound,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";

const SEVERITY = {
  critical: { tone: "danger", Icon: CircleAlert, chip: "bg-danger/15 text-danger" },
  warning: { tone: "warning", Icon: AlertTriangle, chip: "bg-warning/15 text-warning" },
  info: { tone: "accent", Icon: Info, chip: "bg-accent/15 text-accent" },
};

const CATEGORY_ICON = {
  license: KeyRound,
  quota: Users,
  invoice: CreditCard,
  subscription: CreditCard,
  tenant: Users,
};

function timeAgo(iso) {
  if (!iso) return "";
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
  return `${Math.round(d / 30)}mo ago`;
}

export default function AlertsPage() {
  const qc = useQueryClient();
  const alertsQ = useQuery({
    queryKey: ["alerts"],
    queryFn: () => adminApi.listAlerts(),
    refetchInterval: 60_000,
  });
  const data = alertsQ.data;
  const items = data?.items || [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["alerts"] });

  const readAll = useMutation({
    mutationFn: () => adminApi.markAllAlertsRead(),
    onSuccess: () => { toast.success("All alerts marked read"); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const readOne = useMutation({
    mutationFn: (key) => adminApi.markAlertRead(key),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });
  const dismiss = useMutation({
    mutationFn: (key) => adminApi.dismissAlert(key),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Alerts"
          description="Actionable platform signals — expiring licenses, quota breaches, overdue invoices."
        />
        {data?.unread > 0 && (
          <Button variant="outline" loading={readAll.isPending} onClick={() => readAll.mutate()}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        )}
      </div>

      {alertsQ.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={BellRing}
            title="All clear"
            description="No active alerts. Expiring licenses, quota breaches and overdue invoices will surface here."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {items.map((a) => {
            const sev = SEVERITY[a.severity] || SEVERITY.info;
            const CatIcon = CATEGORY_ICON[a.category] || sev.Icon;
            return (
              <Card
                key={a.key}
                className={"flex items-start gap-3 p-4 transition " + (a.read ? "opacity-70" : "")}
              >
                <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " + sev.chip}>
                  <CatIcon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{a.title}</span>
                    <Badge tone={sev.tone}>{a.severity}</Badge>
                    {!a.read && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Unread" />}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{a.message}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    {a.link && (
                      <Link
                        href={a.link}
                        onClick={() => !a.read && readOne.mutate(a.key)}
                        className="font-medium text-accent hover:underline"
                      >
                        View
                      </Link>
                    )}
                    {!a.read && (
                      <button
                        onClick={() => readOne.mutate(a.key)}
                        className="text-muted transition hover:text-foreground"
                      >
                        Mark read
                      </button>
                    )}
                    {a.ts && (
                      <span className="inline-flex items-center gap-1 text-muted">
                        <Clock className="h-3 w-3" /> {timeAgo(a.ts)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => dismiss.mutate(a.key)}
                  aria-label="Dismiss"
                  className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
