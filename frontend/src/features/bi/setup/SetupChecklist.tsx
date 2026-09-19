"use client";

// Building Intelligence → SETUP. The checklist every Setup page hangs off.
//
// The gates of the pipeline ARE the to-do list, and they are a PATH, not a
// menu: gate 2 answered on gate 1's ghosts is work thrown away. So the screen
// opens ONE step — the first that is not done — with the question that gate
// asks, why it is worth answering and what answering it frees; the rest stay
// one quiet line each. `ChecklistSteps.tsx` draws them.
//
// The words and the arithmetic are features/bi/setup/checklist.ts and
// setup/routes.ts; this file only asks the reads and lays the answers out.
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
import { deriveChecklist, openStep } from "./checklist";
import { OpenStep, QuietStep } from "./ChecklistSteps";
import { useBuildings } from "./useBuildings";

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
  const open = openStep(rows);

  return (
    <div className="space-y-3">
      <EstateHeader
        crumbs={[{ label: "Setup" }]}
        desc="six things this estate has to tell the platform, in the order they depend on each other"
        right={
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-nb-soft">
              {done} of {rows.length} answered
            </span>
            <div
              className="h-[5px] w-[120px] overflow-hidden rounded-full bg-[rgba(140,165,220,.16)]"
              role="img"
              aria-label={`${done} of ${rows.length} answered`}
            >
              <div
                className="h-[5px] rounded-full bg-nb-good"
                style={{ width: `${Math.round((done / rows.length) * 100)}%` }}
              />
            </div>
          </div>
        }
      />

      {/* Every gate answered: say so once, rather than opening a step with
          nothing left in it. */}
      {open === -1 && (
        <p className="rounded-[12px] border border-[rgba(52,211,153,.35)] bg-[rgba(52,211,153,.07)] px-4 py-3 text-[12.5px] text-nb-good">
          Every gate is answered. Nothing on this screen is waiting on you — a metric that still
          refuses is short of a SIGNAL, not of a setting, and says which on the screen that reads it.
        </p>
      )}

      <ol aria-label="Setup checklist" className="space-y-0">
        {rows.map((r, i) =>
          i === open ? (
            <OpenStep key={r.task.id} row={r} n={i + 1} />
          ) : (
            <QuietStep key={r.task.id} row={r} n={i + 1} last={i === rows.length - 1} />
          ),
        )}
      </ol>

    </div>
  );
}
