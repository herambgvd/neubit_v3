"use client";

// Health — what is running, and what it is saying.
//
// This page used to be three dependency probes (database / redis / storage) and
// the host's CPU and RAM. That answers "can core reach its database", which is
// not the question an operator opens a health page with: they want the ESTATE —
// every service, whether it is up, and its log tail when it is not behaving.
//
// The inventory and the logs come from the ops-agent sidecar, the one component
// that holds the docker socket; core forwards (GET /system/services). Read-only:
// restart stays on the super-admin infra API, which audits it, and appears here
// only for a super-admin.
//
// Layout is master/detail like the rest of the console — the estate on the left,
// one service's live tail on the right — with the dependency probes and host
// meters as a compact strip above, so the whole thing sits on one screen instead
// of scrolling past what matters.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionButton,
  ConsoleGrid,
  ConsolePanel,
  EmptyPane,
  PanelHeader,
  PanelList,
} from "@/components/console";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ServiceOut, SystemHealthOut } from "../types";
import HostStrip from "./components/HostStrip";
import ServiceListItem from "./components/ServiceListItem";
import ServiceLogs from "./components/ServiceLogs";
import { needsAttention, serviceState, uptime } from "./serviceFormat";

export default function HealthPage() {
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canReadLogs = can("system.logs");
  const isSuper = !!user?.is_superadmin;

  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const health = useQuery({
    queryKey: ["system-health"],
    queryFn: () => api.get<SystemHealthOut>("/system/health").then((r) => r.data),
    refetchInterval: 15000,
  });

  // 5s, not the log pane's 3s: the agent samples docker stats per container to
  // answer this, so a tighter poll spends real CPU on the host being watched.
  const services = useQuery({
    queryKey: ["system-services"],
    queryFn: () => api.get<ServiceOut[]>("/system/services").then((r) => r.data),
    refetchInterval: 5000,
  });

  const restart = useMutation({
    mutationFn: (container: string) => api.post(`/admin/infra/containers/${container}/restart`),
    onSuccess: () => {
      toast.success("Restart requested");
      qc.invalidateQueries({ queryKey: ["system-services"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const items = useMemo(() => services.data || [], [services.data]);
  const open = useMemo(
    () => items.find((s) => s.container === selected) || items[0] || null,
    [items, selected],
  );
  const down = items.filter(needsAttention).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <HostStrip health={health.data} loading={health.isLoading} />

      <ConsoleGrid>
        {/* LEFT — the estate */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:server-stack"
            title="Services"
            count={items.length}
            actions={
              down > 0 ? (
                <span className="flex items-center gap-1.5 text-[11px] text-nb-crit" title="Needs attention">
                  <span className="h-1.5 w-1.5 rounded-full bg-nb-crit shadow-[0_0_5px_#f87171]" />{down}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[11px] text-nb-good" title="All services up">
                  <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
                  OK
                </span>
              )
            }
          />
          <PanelList
            loading={services.isLoading}
            // An unreachable ops-agent must never read as an empty estate — that
            // would say "nothing is running" about a healthy deployment.
            error={
              services.isError
                ? apiError(services.error, "Couldn't reach the service inventory")
                : undefined
            }
            empty={items.length === 0}
            emptyText="No services reported"
          >
            {items.map((s) => (
              <ServiceListItem
                key={s.container}
                service={s}
                selected={open?.container === s.container}
                onSelect={() => setSelected(s.container)}
              />
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — that service's live tail */}
        <ConsolePanel>
          {open ? (
            <>
              <div className="flex items-center gap-3 border-b border-nb-line px-4 py-3">
                <span className={`h-2 w-2 shrink-0 rounded-full ${serviceState(open).dot}`} />
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-nb-ink">{open.name}</div>
                  <div className="truncate font-mono text-[10.5px] text-nb-faint">
                    {open.container} · up {uptime(open.created_at)}
                  </div>
                </div>
                <span
                  className={`ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-[1px] ${serviceState(open).tone}`}
                >
                  {serviceState(open).label}
                </span>
                {isSuper && (
                  <ActionButton
                    icon="heroicons-outline:arrow-path"
                    disabled={restart.isPending}
                    onClick={() =>
                      setConfirm({
                        title: "Restart service?",
                        message: `Restart ${open.name}? Anything it is serving right now will be interrupted.`,
                        confirmLabel: "Restart",
                        onConfirm: () => {
                          restart.mutate(open.container);
                          setConfirm(null);
                        },
                      })
                    }
                  >
                    Restart
                  </ActionButton>
                )}
              </div>
              {/* Keyed on the container: the log pane accumulates lines, and one
                  service's output must never appear under another's name. */}
              <ServiceLogs key={open.container} service={open} allowed={canReadLogs} />
            </>
          ) : (
            <EmptyPane
              icon="heroicons-outline:command-line"
              title={services.isError ? "Service inventory unavailable" : "No service selected"}
              subtitle={
                services.isError
                  ? "The ops-agent is not answering, so this deployment cannot be inspected from here."
                  : "Pick a service to read its live log tail."
              }
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={restart.isPending} />
    </div>
  );
}
