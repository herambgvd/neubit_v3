"use client";

// Building Intelligence → SETUP. The checklist every Setup page hangs off.
//
// The gates of the pipeline ARE the to-do list: a commissioning engineer opens
// this and sees what to do, in what order, and how much is left. One row per
// task — its state, a one-line count, and the page that changes that count.
// The words and the arithmetic are features/bi/setup/checklist.ts; this file
// only asks the questions and lays the answers out.
import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { EstateHeader } from "@/components/console";
import { useAuth } from "@/lib/auth";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import sitesApi from "@/lib/api/sites";

import { bi } from "../api";
import { metrics } from "../metricsApi";
import { MODULE, PERM_READ, PERM_SITES_READ } from "../constants";
import { deriveChecklist, type ChecklistRow, type ChecklistState } from "./checklist";
import { useBuildings } from "./useBuildings";

const STATE_STYLE: Record<ChecklistState, { icon: string; cls: string }> = {
  done: { icon: "heroicons:check-circle", cls: "border-[rgba(52,211,153,.45)] text-nb-good" },
  partly: { icon: "heroicons:exclamation-circle", cls: "border-nb-warn/45 text-nb-warn" },
  todo: { icon: "heroicons-outline:minus-circle", cls: "border-nb-line text-nb-muted" },
  unknown: { icon: "heroicons:question-mark-circle", cls: "border-nb-line text-nb-faint" },
};

/** Per-building reads, keyed by site id; a read that has not answered is absent. */
function bySite<T>(ids: string[], results: { data?: T }[], pick: (d: T) => unknown) {
  const out: Record<string, any> = {};
  ids.forEach((id, i) => {
    const d = results[i]?.data;
    out[id] = d === undefined ? undefined : pick(d);
  });
  return out;
}

export default function SetupChecklist() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayReadSites = can(PERM_SITES_READ);

  // The same keys the gate strip asks under, so both share one answer.
  const ghostsQ = useQuery<any>({
    queryKey: ["bi-ghosts", "", ""],
    queryFn: () => bi.ghosts(undefined),
    enabled: mayRead,
  });
  const patternsQ = useQuery<any>({
    queryKey: ["bi-unit-patterns", null, null],
    queryFn: () => bi.unitPatterns({ category: undefined, site_id: undefined }),
    enabled: mayRead,
  });
  const unplacedQ = useQuery<any>({
    queryKey: ["bi-devices", "setup", "unplaced"],
    queryFn: () => bi.devices({ placement: "unplaced", limit: 1 }),
    enabled: mayRead,
  });
  const placedQ = useQuery<any>({
    queryKey: ["bi-devices", "setup", "placed"],
    queryFn: () => bi.devices({ placement: "placed", limit: 1 }),
    enabled: mayRead,
  });
  const rolesQ = useQuery<any>({
    queryKey: ["bi-metric-roles", "setup-counts"],
    queryFn: () => metrics.roles({ confirmed: "confirmed", limit: 1 }),
    enabled: mayRead,
  });
  const orphansQ = useQuery<any>({
    queryKey: ["bi-role-orphans", ""],
    queryFn: () => bi.roleOrphans(undefined),
    enabled: mayRead,
  });

  const { q: buildingsQ, items: buildings } = useBuildings(mayRead);
  const ids = buildings.map((b) => b.site_id);
  const trees = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["infra-tree", id],
      queryFn: () => siteInfrastructure.tree(id),
      enabled: mayRead,
    })),
  });
  // Slabs and factors are on the site record — `sites.read`, not BI's key.
  // Without it they are not asked for, and print as "—".
  const slabs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["site-tariff-slabs", id],
      queryFn: () => sitesApi.getTariffSlabs(id),
      enabled: mayRead && mayReadSites,
    })),
  });
  const factors = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["site-emission-factors", id],
      queryFn: () => sitesApi.getEmissionFactors(id),
      enabled: mayRead && mayReadSites,
    })),
  });

  if (!mayRead) {
    return (
      <div className="space-y-3">
        <EstateHeader crumbs={[{ label: "Setup" }]} />
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </div>
    );
  }

  const rows = deriveChecklist({
    ghosts: ghostsQ.data,
    patterns: patternsQ.data,
    unplaced: unplacedQ.data,
    placed: placedQ.data,
    buildings: buildingsQ.data ? buildings : undefined,
    trees: bySite(ids, trees, (d) => d),
    roles: rolesQ.data,
    orphans: orphansQ.data,
    slabs: bySite(ids, slabs, (d: any) => d.total ?? (d.items ?? []).length),
    factors: bySite(ids, factors, (d: any) => d.total ?? (d.items ?? []).length),
  });
  const done = rows.filter((r) => r.state === "done").length;

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <EstateHeader
        crumbs={[{ label: "Setup" }]}
        desc="the pipeline's gates, in order · open a task to work it"
        right={
          <span className="font-mono">
            {done} of {rows.length} done
          </span>
        }
      />
      <ol aria-label="Setup checklist" className="space-y-1.5">
        {rows.map((r, i) => (
          <ChecklistItem key={r.task.id} row={r} n={i + 1} />
        ))}
      </ol>
    </div>
  );
}

function ChecklistItem({ row, n }: Readonly<{ row: ChecklistRow; n: number }>) {
  const st = STATE_STYLE[row.state];
  return (
    <li
      aria-label={row.task.label}
      className="flex items-center gap-3 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.45)] px-3 py-2"
    >
      <span className="w-4 flex-none text-right font-mono text-[11px] text-nb-faint">{n}</span>
      <Icon icon={row.task.icon} className="flex-none text-[16px] text-nb-blueb" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-nb-ink">{row.task.label}</span>
          {row.task.gate && (
            <span className="font-mono text-[10px] text-nb-faint">gate {row.task.gate}</span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-nb-soft" title={row.why}>
          {row.count}
        </div>
      </div>
      <span
        data-state={row.state}
        className={`flex flex-none items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${st.cls}`}
      >
        <Icon icon={st.icon} className="text-[12px]" />
        {row.stateLabel}
      </span>
      <Link
        href={row.href}
        className="flex-none rounded-[6px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
      >
        Open →
      </Link>
    </li>
  );
}
