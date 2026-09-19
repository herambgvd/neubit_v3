"use client";

// GATE 6 · ACTS — the worklist, and the one place BI hands something to a person.
//
// WHY THIS IS NOT A SETUP PAGE. Setup is where a building is DESCRIBED, once:
// its units, its buildings, its plant. This is what an operator does with what
// the building is saying today — a sensor that stopped, a metric that refused, an
// alert the gateway raised. Different job, different cadence, different person.
//
// WHAT IS LISTED, AND WHAT IS DELIBERATELY NOT. A metric's `ok` is not a pass
// mark — the registry has no threshold — so a computed value never appears here
// as though something were wrong. See `findings.ts` for the rule.
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsolePage,
  ConsolePanel,
  PanelHeader,
  PanelList,
  ActionButton,
  LoadingBlock,
} from "@/components/console";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { workflow } from "@/features/workflow/api";

import { bi } from "./api";
import { MODULE, PERM_READ } from "./constants";
import GateStrip from "./components/GateStrip";
import Reason from "./components/Reason";
import RaiseWork, { PERM_RAISE } from "./components/RaiseWork";
import {
  actionable,
  alertFindings,
  keysOf,
  splitByWork,
  type AlertLike,
  type Finding,
} from "./findings";

const FINDING_HOURS = 24;
const PERM_WORK_READ = "workflow.instance.read";

const KIND_WORD: Record<Finding["kind"], string> = {
  data_fault: "a bound sensor is not answering",
  equipment_metric: "the number could not be produced",
  alert: "raised by the gateway",
};

export default function Work() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading…" />}>
      <WorkInner />
    </Suspense>
  );
}

function WorkInner() {
  const { can, hasModule } = useAuth();
  const siteId = useSearchParams().get("site") || "";
  const mayBi = can(PERM_READ) && hasModule(MODULE);
  const mayWorkRead = can(PERM_WORK_READ) || can(PERM_RAISE);
  const mayRaise = can(PERM_RAISE);
  const [raising, setRaising] = useState<Finding | null>(null);

  // Equipment findings belong to ONE building — the endpoint is per site. Alerts
  // are the gateway's and are estate-wide; the list says so rather than implying
  // they are this building's.
  const findingsQ = useQuery<any>({
    queryKey: ["bi-findings", siteId],
    queryFn: () => bi.findings({ site_id: siteId, hours: FINDING_HOURS }),
    enabled: mayBi && !!siteId,
  });
  const alertsQ = useQuery<any>({
    queryKey: ["bi-alerts", FINDING_HOURS],
    queryFn: () => bi.alerts({ hours: FINDING_HOURS, limit: 50 }),
    enabled: mayBi,
  });

  const found = useMemo(
    () =>
      actionable([
        ...((findingsQ.data?.findings ?? []) as Finding[]),
        ...alertFindings((alertsQ.data?.items ?? []) as AlertLike[]),
      ]),
    [findingsQ.data, alertsQ.data],
  );

  const openWorkQ = useQuery<any>({
    queryKey: ["bi-open-work", found.map((f) => f.source_key).join(",")],
    queryFn: () => workflow.instances.openBySource(keysOf(found)),
    enabled: mayWorkRead && found.length > 0,
  });
  const split = splitByWork(found, found.length === 0 ? {} : openWorkQ.data?.with_work);

  if (!mayBi) {
    return (
      <ConsolePage>
        <ConsolePanel>
          <PanelHeader icon="heroicons:bolt" title="Work" />
          <p className="p-4 text-sm text-nb-muted">Reading findings needs bi.read.</p>
        </ConsolePanel>
      </ConsolePage>
    );
  }

  const err = findingsQ.error || alertsQ.error;

  return (
    <ConsolePage>
      <GateStrip subject={{ kind: "site", siteId: siteId || undefined, label: findingsQ.data?.site_name || "this building" }} />
      <ConsolePanel>
        <PanelHeader
          icon="heroicons:bolt"
          title="Findings that could raise work"
          count={split ? split.withoutWork.length : undefined}
          actions={
            <span className="font-mono text-[11px] text-nb-muted" title={`Read over the last ${FINDING_HOURS} hours. An alert older than that is outside the store's alert window and is not listed.`}>
              last {FINDING_HOURS} h
            </span>
          }
        />
        <PanelList
          loading={findingsQ.isLoading || alertsQ.isLoading}
          error={err ? apiError(err, "Could not read the findings") : null}
          empty={found.length === 0}
          emptyText={
            siteId
              ? `Nothing to act on in the last ${FINDING_HOURS} hours.`
              : "Pick a building to see its equipment findings. Alerts are estate-wide and appear either way."
          }
        >
          {!mayWorkRead ? (
            <p className="px-4 py-3 text-sm text-nb-muted">
              Whether these already have work open needs workflow.instance.read.
            </p>
          ) : null}

          {split?.withoutWork.map((f) => (
            <div key={f.source_key} className="flex items-start gap-3 border-b border-nb-line px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {f.equipment_tag ? `${f.equipment_tag} · ` : ""}
                  {f.title}
                </div>
                <div className="mt-0.5 text-[11px] text-nb-muted">
                  {KIND_WORD[f.kind]}
                  {f.kind === "equipment_metric" ? ` · ${f.status}` : ""}
                </div>
                {f.summary ? <Reason text={f.summary} className="mt-1" /> : null}
              </div>
              {mayRaise ? (
                <ActionButton onClick={() => setRaising(f)}>Raise work</ActionButton>
              ) : (
                <span className="whitespace-nowrap text-[11px] text-nb-muted">needs workflow.instance.create</span>
              )}
            </div>
          ))}

          {split && split.withWork.length > 0 ? (
            <div className="border-t border-nb-line px-4 py-3">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-nb-muted">
                already being worked on
              </div>
              <ul className="grid gap-2">
                {split.withWork.map(({ finding, work }) => (
                  <li key={finding.source_key} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {finding.equipment_tag ? `${finding.equipment_tag} · ` : ""}
                      {finding.title}
                    </span>
                    <Link
                      className="flex items-center gap-1 whitespace-nowrap text-[12px] text-nb-accent hover:underline"
                      href={`/workflow/incidents?instance=${work.instance_id}`}
                    >
                      {work.current_state_name || work.status}
                      <Icon icon="heroicons:arrow-up-right" className="text-[12px]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </PanelList>
        {split && split.withoutWork.length === 0 && found.length > 0 ? (
          <div className="px-4 py-3 text-sm text-nb-muted">
            Every finding here already has work open.
          </div>
        ) : null}
      </ConsolePanel>

      {raising ? (
        <RaiseWork finding={raising} open onClose={() => setRaising(null)} />
      ) : null}
    </ConsolePage>
  );
}
