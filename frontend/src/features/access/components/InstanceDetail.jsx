"use client";

// Right-pane detail for one instance. Ported from neubit_v2's instance-detail.jsx:
// header (site name, instance name, copy-able base URL, health badge) + an info grid
// (auth / last-connected / last-sync / reconciler cron) + last-error banner, then the
// tab bar (Events / Cardholders / Cards / Access Groups / Scheduled / Hardware / Sync)
// hosting each tab. Rethemed to v3 tokens; uses the shared TabBar.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { TabBar } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtDateTime } from "@/lib/format";
import { gates } from "../api";
import HealthBadge from "./HealthBadge";
import EventsFeed from "./EventsFeed";
import CardholdersTab from "./CardholdersTab";
import CardsTab from "./CardsTab";
import AccessGroupsTab from "./AccessGroupsTab";
import ScheduledTab from "./ScheduledTab";
import HardwareTab from "./HardwareTab";
import SyncTab from "./SyncTab";

const TABS = [
  { key: "events", label: "Events", icon: "heroicons-outline:signal" },
  { key: "cardholders", label: "Cardholders", icon: "heroicons-outline:users" },
  { key: "cards", label: "Cards", icon: "heroicons-outline:credit-card" },
  { key: "access_groups", label: "Access Groups", icon: "heroicons-outline:key" },
  { key: "scheduled", label: "Scheduled Access", icon: "heroicons-outline:calendar-days" },
  { key: "hardware", label: "Hardware", icon: "heroicons-outline:cpu-chip" },
  { key: "sync", label: "Sync History", icon: "heroicons-outline:clock" },
];

export default function InstanceDetail({ instanceId, sites }) {
  const [activeTab, setActiveTab] = useState("events");
  const [copied, setCopied] = useState(false);

  const q = useQuery({
    queryKey: ["ac-instance", instanceId],
    queryFn: () => gates.instances.get(instanceId),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });

  const doorsQ = useQuery({
    queryKey: ["ac-doors", instanceId],
    queryFn: () => gates.doors.list({ instance_id: instanceId, limit: 500 }),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
  const doorIndex = asItems(doorsQ.data);

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 p-5 text-xs text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading instance…
      </div>
    );
  }
  if (q.isError || !q.data) {
    return <div className="p-5 text-xs text-muted">{apiError(q.error, "Could not load instance.")}</div>;
  }

  const instance = q.data;
  const siteName = sites?.find((s) => s.site_id === instance.site_id)?.name || "Unassigned site";

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* Header */}
      <div className="border-b border-card-border px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <Icon icon="heroicons-outline:server" className="text-lg" />
            </div>
            <div className="min-w-0">
              <p className="mb-0.5 truncate text-[11px] text-muted">{siteName}</p>
              <h1 className="truncate text-base font-semibold text-foreground">{instance.name}</h1>
              <button
                type="button"
                onClick={() => handleCopy(instance.base_url)}
                title="Copy base URL"
                className="inline-flex items-center gap-1 text-[11px] text-muted transition hover:text-foreground"
              >
                {instance.base_url}
                <Icon icon={copied ? "heroicons-outline:check" : "heroicons-outline:clipboard"} className="text-xs" />
              </button>
            </div>
          </div>
          <HealthBadge status={instance.status} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] md:grid-cols-4">
          <InfoCell label="Auth" value={(instance.auth_type || "").toUpperCase()} />
          <InfoCell label="Last connected" value={instance.last_connected_at ? fmtDateTime(instance.last_connected_at) : "—"} />
          <InfoCell label="Last sync" value={instance.last_sync_at ? fmtDateTime(instance.last_sync_at) : "—"} />
          <InfoCell label="Reconciler cron" value={instance.reconciler_cron || "—"} />
        </div>

        {instance.last_error && (
          <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-500">
            {instance.last_error}
          </div>
        )}
      </div>

      {/* Tabs */}
      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} className="px-4" />

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "events" ? (
          <EventsFeed instanceId={instance.id} doorIndex={doorIndex} />
        ) : activeTab === "cardholders" ? (
          <CardholdersTab instanceId={instance.id} />
        ) : activeTab === "cards" ? (
          <CardsTab instanceId={instance.id} />
        ) : activeTab === "access_groups" ? (
          <AccessGroupsTab instanceId={instance.id} />
        ) : activeTab === "scheduled" ? (
          <ScheduledTab instanceId={instance.id} />
        ) : activeTab === "hardware" ? (
          <HardwareTab instanceId={instance.id} />
        ) : activeTab === "sync" ? (
          <SyncTab instanceId={instance.id} />
        ) : null}
      </div>
    </section>
  );
}

function InfoCell({ label, value }) {
  return (
    <div>
      <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted/70">{label}</div>
      <div className="truncate text-muted">{value}</div>
    </div>
  );
}
