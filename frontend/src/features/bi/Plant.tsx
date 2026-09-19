"use client";

// Building Intelligence → L3 PLANT. One building's plant, drawn.
//
//   L1 BUILDING   /bi/portfolio          the estate: gates, questions, domains
//   L2 DOMAIN     /bi/<domain>?site=     one domain, estate-wide or one building
//   L3 PLANT      /bi/plant?site=        one building's systems → equipment
//
// THE ROUTE. `?site=` rather than `/bi/plant/<id>`: the building is the same
// query parameter L2 is scoped with, so the console strip carries it between a
// building's domains and its plant with no second convention, and the route is
// one static page like every other BI console. Without `?site=` the page is a
// list of buildings to pick from — a plant is always ONE building's.
//
// THE COLOUR IS DATA READINESS, NEVER HEALTH. Every glyph is coloured by whether
// its slots name exactly one point that reported in the window (see
// `plant/readiness.ts`). ΔT, band occupancy and kW/TR are printed on the glyph
// as text, and a metric over an input that is not reporting says "not known" —
// a chiller nobody can read is not healthy and not faulted.
//
// THE EMPTY STATE IS THE FIRST THING ANYONE SEES. The registry is empty on this
// deployment, so the page's first job is to send an operator to Setup →
// Equipment for THIS building, where the plant is described or imported.
//
// GATES. `bi.read` + `analytics` to read — nothing is requested without them.
// "Edit plant" follows the designer's own gate (it opens with `bi.read`);
// "Import I/O schedule" needs `bi.manage`, because the import writes.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  EstateHeader,
  LoadingBlock,
  PaneAction,
  PanelHeader,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { BiPlant } from "@/lib/types";

import GateStrip from "./components/GateStrip";
import { bi } from "./api";
import { MODULE, PERM_MANAGE, PERM_READ } from "./constants";
import EquipmentDetail from "./plant/EquipmentDetail";
import PlantSchematic from "./plant/PlantSchematic";
import { readinessOrder, readinessStyle } from "./plant/readiness";
import { plantHref } from "./plant/routes";
import { infraDesignerHref, infraImportHref } from "./setup/routes";
import { useBuildings } from "./setup/useBuildings";

/** "Reporting" is judged over this window — the endpoint's default, a dozen
 *  polls at this estate's five-minute cadence. */
const HOURS = 1;

const is404 = (e: unknown): boolean => (e as { response?: { status?: number } })?.response?.status === 404;

export default function Plant() {
  return (
    <Suspense fallback={null}>
      <PlantInner />
    </Suspense>
  );
}

function PlantInner() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const mayManage = mayRead && can(PERM_MANAGE);
  const siteId = useSearchParams().get("site");
  const [picked, setPicked] = useState<string | null>(null);

  const plantQ = useQuery<BiPlant>({
    queryKey: ["bi-plant", siteId, HOURS],
    queryFn: () => bi.plant(siteId!, { hours: HOURS }),
    enabled: mayRead && !!siteId,
    refetchInterval: 60_000,
  });
  const notInStore = is404(plantQ.error);
  // The building's name when the plant does not carry it, and the picker's rows.
  const needBuildings = mayRead && (!siteId || notInStore || (plantQ.isSuccess && !plantQ.data.site_name));
  const { q: buildingsQ, items: buildings } = useBuildings(needBuildings);

  if (!mayRead) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Building", href: "/bi/portfolio" }, { label: "Plant" }]} />
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  if (!siteId) {
    return (
      <ConsolePage>
        <EstateHeader
          crumbs={[{ label: "Building", href: "/bi/portfolio" }, { label: "Plant" }]}
          desc="A plant is one building's — pick the building."
        />
        <ConsolePanel className="max-w-xl">
          <PanelHeader icon="heroicons-outline:building-office-2" title="Buildings" count={buildingsQ.data ? buildings.length : "—"} />
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
            {buildingsQ.isLoading && <LoadingBlock label="Loading buildings…" />}
            {buildingsQ.error && <p className="text-[11.5px] text-nb-crit">{apiError(buildingsQ.error, "Could not load the buildings")}</p>}
            {buildingsQ.isSuccess && !buildings.length && (
              <p className="text-[11.5px] text-nb-faint">No building in Configurations → Sites yet.</p>
            )}
            {buildings.map((b) => (
              <Link
                key={b.site_id}
                href={plantHref(b.site_id)}
                className="block rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-3 py-2 text-[12.5px] text-nb-ink transition hover:border-nb-blue/60"
              >
                {b.site_name || b.site_id}
              </Link>
            ))}
          </div>
        </ConsolePanel>
      </ConsolePage>
    );
  }

  const plant = plantQ.data;
  const siteName =
    plant?.site_name || buildings.find((b) => b.site_id === siteId)?.site_name || (plantQ.isLoading ? "…" : siteId);
  const empty = !!plant && !plant.systems.length && !plant.unassigned_equipment.length;
  const all = plant ? [...plant.systems.flatMap((s) => s.equipment), ...plant.unassigned_equipment] : [];
  const selected = all.find((e) => e.equipment_id === picked) ?? null;

  return (
    <ConsolePage>
      <EstateHeader
        crumbs={[{ label: "Building", href: "/bi/portfolio" }, { label: siteName }, { label: "Plant" }]}
        desc={
          <span title="Each piece of equipment is coloured by DATA READINESS — whether its slots name one point that reported in the window — not by how the machine is running. Metrics are printed on it; a metric over an input that is not reporting is not a verdict.">
            coloured by data readiness · last {HOURS} h
          </span>
        }
        right={
          <>
            {plantQ.isFetching && <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" />}
            <PaneAction icon="heroicons-outline:pencil-square" href={infraDesignerHref(siteId)} title="Setup → Equipment, on this building">
              Edit plant
            </PaneAction>
            {mayManage && (
              <PaneAction icon="heroicons-outline:arrow-up-tray" href={infraImportHref(siteId)} title="Describe the plant from an I/O schedule (.xlsx)">
                Import I/O schedule
              </PaneAction>
            )}
          </>
        }
      />

      <GateStrip className="mb-3 shrink-0" subject={{ kind: "site", siteId, label: siteName }} />

      {plantQ.isLoading ? (
        <LoadingBlock label="Reading the plant…" />
      ) : plantQ.error && !notInStore ? (
        <p className="text-[12px] text-nb-crit">{apiError(plantQ.error, "Could not read the plant")}</p>
      ) : empty || notInStore ? (
        <ConsolePanel className="flex-1 items-center justify-center px-4 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
            <Icon icon="heroicons-outline:cpu-chip" className="text-xl" />
          </span>
          <h2 className="mt-3 text-sm font-semibold text-nb-ink">No plant described for this building</h2>
          <p className="mt-0.5 text-xs text-nb-faint">
            {notInStore
              ? "Building Intelligence has no record of this building yet."
              : "Systems, equipment and the point behind each slot are described in Setup → Equipment."}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3" data-empty-actions>
            <Link
              href={infraDesignerHref(siteId)}
              className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)] px-3 py-1.5 text-[12px] text-nb-blueb transition hover:border-nb-blue"
            >
              Describe it in Setup → Equipment <Icon icon="heroicons:arrow-up-right" className="text-[12px]" />
            </Link>
            {mayManage && (
              <Link href={infraImportHref(siteId)} className="text-[12px] text-nb-blueb hover:underline">
                or import an I/O schedule
              </Link>
            )}
          </div>
        </ConsolePanel>
      ) : plant ? (
        <ConsoleGrid cols="xl:grid-cols-[1fr_340px]">
          <ConsolePanel>
            <Legend plant={plant} siteId={siteId} />
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              <PlantSchematic plant={plant} selectedId={selected?.equipment_id ?? null} onSelect={setPicked} />
            </div>
          </ConsolePanel>
          <ConsolePanel>
            {selected ? (
              <EquipmentDetail key={selected.equipment_id} eq={selected} plant={plant} siteId={siteId} />
            ) : (
              <EmptyPane icon="heroicons-outline:cursor-arrow-rays" title="Pick a piece of equipment" subtitle="Its slots and metrics open here" />
            )}
          </ConsolePanel>
        </ConsoleGrid>
      ) : null}
    </ConsolePage>
  );
}

/** The five states with this building's slot counts. A count that Setup →
 *  Equipment changes is a link there; silent is fixed at the device, and says so. */
function Legend({ plant, siteId }: Readonly<{ plant: BiPlant; siteId: string }>) {
  return (
    <div className="nav-scroll flex items-center gap-1.5 overflow-x-auto border-b border-nb-line/60 px-3 py-2" aria-label="Readiness legend">
      <span className="mr-1 shrink-0 text-[10px] uppercase tracking-[1.2px] text-nb-faint">slots</span>
      {readinessOrder(plant).map((state) => {
        const s = readinessStyle(state);
        const n = plant.totals?.[state] ?? 0;
        const body = (
          <>
            <svg width="16" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="15" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash} />
            </svg>
            <span>{s.label}</span>
            <span className="font-mono text-nb-ink">{n}</span>
          </>
        );
        const cls = "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-nb-line px-2 py-0.5 text-[10.5px] text-nb-soft";
        return s.fixInDesigner && n > 0 ? (
          <Link
            key={state}
            href={infraDesignerHref(siteId)}
            title={`${n} slot(s) ${s.label.toLowerCase()}. ${s.title}`}
            className={`${cls} transition hover:border-nb-blue/60`}
            data-state={state}
          >
            {body}
          </Link>
        ) : (
          <span key={state} title={`${n} slot(s) ${s.label.toLowerCase()}. ${s.title}`} className={cls} data-state={state}>
            {body}
          </span>
        );
      })}
    </div>
  );
}
