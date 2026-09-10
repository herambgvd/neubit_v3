"use client";

// HUB MODE — the screen a control room leaves up.
//
// /alarms is the CASE surface: one alarm, its procedure, its record, read at a
// desk. This is the other half of the job — alarms arrive, an operator looks and
// clears, for eight hours. So the chrome goes (no global header, no footer, no
// page padding), the pictures get the screen, and the queue never leaves it.
//
// The shape is the mosaic: the alarm's own camera large, the cameras AROUND it
// beside it, its procedure as a panel, and the queue as a rail with "Next alarm"
// under it. It is what an operator coming from a desktop VMS already knows how to
// read, and the reason it works is that every cell answers a different question
// about the same alarm — what happened, what is happening near it, what to do,
// what is waiting.
//
// Two rules it does not break:
//   * A NEW ALARM NEVER STEALS THE SCREEN. It lands at the top of the rail and
//     the count moves; the operator advances when they are ready. A console that
//     yanks the picture mid-decision teaches people to work somewhere else.
//   * NOTHING IS INVENTED. A camera nobody placed has no neighbours, and the
//     panel says so rather than showing an empty grid.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import LivePlayer from "@/features/vms/components/LivePlayer";
import { nodeLiveSource } from "@/features/vms/hooks/useNodeLiveSource";
import { useCameraSites } from "@/features/vms/hooks/useCameraSites";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import type { EstateCamera } from "@/features/vms/types";
import { workflow as wfApi } from "./api";
import type { InstancePublic, StatePublic } from "./types";
import { EvidencePicture } from "./components/incidents/AlarmEvidence";
import { currentStepIndex, orderedSteps } from "./components/incidents/ProcedureSteps";
import {
  incCameraId,
  incId,
  incTitle,
  isOpen,
  isSlaBreaching,
  prioWeight,
  sev,
  slaFor,
} from "./components/incidents/lib";
import { useIncidentStream } from "./hooks/useIncidentStream";

/** The rail's order, and therefore what "next" means: the most urgent first —
 *  overdue, then by priority, then by how long it has been waiting. An operator
 *  clearing a queue top-down should be clearing the right things first. */
export function hubOrder(rows: InstancePublic[]): InstancePublic[] {
  return [...rows].sort((a, b) => {
    const late = (i: InstancePublic) => (isSlaBreaching(i) ? 0 : 1);
    return (
      late(a) - late(b) ||
      prioWeight(b.priority) - prioWeight(a.priority) ||
      String(a.created_at || "").localeCompare(String(b.created_at || ""))
    );
  });
}

function Cell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-lg border border-card-border bg-card ${className}`}>
      {children}
    </div>
  );
}

/** A neighbouring camera, live and small. */
function NeighbourCell({ camera }: { camera: EstateCamera }) {
  const source = nodeLiveSource(camera);
  const offline = String(camera.status).toLowerCase() !== "online";
  return (
    <Cell>
      <div className="absolute inset-0 bg-black">
        {source && !offline ? (
          <LivePlayer
            cameraId={camera.id}
            cameraName={camera.name}
            nodeId={(camera as { node_id?: string }).node_id ?? null}
            source={source}
            profile="sub"
            autoPlay
            muted
            minimal
            fit="cover"
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-muted">
            {offline ? "Not streaming" : "No live source"}
          </div>
        )}
      </div>
      <span className="pointer-events-none absolute bottom-1.5 left-2 z-10 text-[10.5px] text-white/85 drop-shadow">
        {camera.name}
      </span>
    </Cell>
  );
}

export default function AlarmHub() {
  const qc = useQueryClient();
  const [cursor, setCursor] = useState(0);

  const listQ = useQuery({
    queryKey: ["wf-instances", "hub"],
    queryFn: () => wfApi.instances.list({ status: "", limit: 100 }),
    refetchInterval: 30_000,
  });
  const open = useMemo(
    () => hubOrder(asItems(listQ.data).filter((it) => isOpen(it.status))),
    [listQ.data],
  );

  // Live arrivals refresh the rail. They do NOT move the cursor: an alarm landing
  // while somebody is deciding must not take the screen out from under them.
  const [connected, setConnected] = useState(false);
  useIncidentStream(
    () => {
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
    },
    { onStatus: setConnected },
  );

  const at = Math.min(cursor, Math.max(0, open.length - 1));
  const current = open[at] ?? null;

  const { cameras } = useEstateCameras();
  const { siteOf, camerasAt } = useCameraSites();
  const camera = useMemo<EstateCamera | null>(() => {
    const camId = current ? incCameraId(current) : null;
    if (!camId) return null;
    return cameras.find((c) => c.id === camId || (c as { real_id?: string }).real_id === camId) ?? null;
  }, [current, cameras]);

  const site = current?.site_id || siteOf(current ? incCameraId(current) : null);
  const neighbours = useMemo(
    () => camerasAt(site).filter((c) => c.id !== camera?.id).slice(0, 2),
    [camerasAt, site, camera],
  );

  const statesQ = useQuery({
    queryKey: ["wf-states", current?.sop_id],
    queryFn: () => wfApi.states.list(current!.sop_id),
    enabled: !!current?.sop_id,
    staleTime: 60_000,
  });
  const steps = orderedSteps(asItems(statesQ.data) as StatePublic[]);
  const stepAt = currentStepIndex(steps, current);

  const take = useMutation({
    mutationFn: (id: string) => wfApi.instances.setStatus(id, "active", null),
    onSuccess: () => {
      toast.success("Alarm taken");
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const next = () => setCursor((c) => (open.length ? (c + 1) % open.length : 0));
  const prev = () => setCursor((c) => (open.length ? (c - 1 + open.length) % open.length : 0));

  // The keyboard is the point of a hub: the loop is look, take, next, and it
  // should never need the mouse. Ignored while typing, so a search box somebody
  // adds later does not fire the queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n" || k === "j") { e.preventDefault(); next(); }
      else if (k === "k") { e.preventDefault(); prev(); }
      else if (k === "a" && current && current.status === "pending") {
        e.preventDefault();
        take.mutate(incId(current));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const critical = open.filter((i) => i.priority === "critical").length;
  const overdue = open.filter((i) => isSlaBreaching(i)).length;
  const s = current ? sev(current.priority) : null;
  const sla = current ? slaFor(current) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ── HUB BAR — thinner than the console's, because this screen is looked
             at rather than navigated. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-card-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[12px] font-semibold tracking-wide text-red-300">
          <Icon icon="heroicons-solid:bell-alert" className="text-sm" /> HUB
        </span>
        <span className="font-mono text-[12px] text-muted">
          {open.length} open · {critical} critical · {overdue} overdue
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
          {connected ? "Live" : "Reconnecting…"}
        </span>

        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          <kbd className="rounded border border-card-border px-1 font-mono">N</kbd> next
          <kbd className="rounded border border-card-border px-1 font-mono">A</kbd> take
        </span>
        <Link
          href="/alarms"
          className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:arrow-left-on-rectangle" className="text-xs" /> Exit hub
        </Link>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* ── THE MOSAIC ─────────────────────────────────────────────────── */}
        {current ? (
          <div className="grid min-h-0 gap-1.5 p-1.5 lg:grid-cols-3 lg:grid-rows-2">
            <Cell className="lg:col-span-2 lg:row-span-2">
              <div className="absolute inset-0 bg-black">
                <EvidencePicture incident={current} camera={camera} kind="recording" />
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2">
                <span className={`h-4 w-[3px] rounded-full ${s!.band}`} aria-hidden />
                <span className="truncate text-[13px] font-semibold text-white">
                  {incTitle(current)}
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s!.soft} ${s!.text}`}>
                  {s!.label}
                </span>
                {sla && (
                  <span
                    className={`font-mono text-[11px] ${
                      sla.tone === "breach" ? "text-red-300" : sla.tone === "warn" ? "text-amber-300" : "text-emerald-300"
                    }`}
                  >
                    {sla.label}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] text-white/70">
                  {at + 1} / {open.length}
                </span>
              </div>
            </Cell>

            {neighbours[0] ? (
              <NeighbourCell camera={neighbours[0]} />
            ) : (
              <Cell className="grid place-items-center p-3 text-center">
                <p className="text-[11.5px] text-muted">
                  {site
                    ? "No other camera is placed at this site."
                    : "This camera is not placed on a floor plan, so the hub cannot show its neighbours."}
                </p>
              </Cell>
            )}

            {neighbours[1] ? (
              <NeighbourCell camera={neighbours[1]} />
            ) : (
              <Cell className="grid place-items-center p-3">
                <span className="text-[11.5px] text-muted">—</span>
              </Cell>
            )}

            {/* THE PROCEDURE, as the panel of the mosaic. Its moves live on the
                case page: a hub is for looking and taking, and a transition that
                asks for a note is a desk job. */}
            <Cell className="lg:col-span-2">
              <div className="grid h-full min-h-0 gap-2 p-3">
                <span className="flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                    Procedure
                  </span>
                  <span className="truncate text-[11.5px] text-muted">{current.sop_name || "—"}</span>
                  <span className="ml-auto flex gap-1.5">
                    {current.status === "pending" && (
                      <button
                        type="button"
                        onClick={() => take.mutate(incId(current))}
                        disabled={take.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        <Icon icon="heroicons-outline:check" className="text-[11px]" /> Take it
                      </button>
                    )}
                    <Link
                      href={`/alarms/${encodeURIComponent(incId(current))}`}
                      className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-200 transition hover:bg-blue-500/20"
                    >
                      <Icon icon="heroicons-outline:folder-open" className="text-[11px]" /> Open case
                    </Link>
                  </span>
                </span>
                <ol className="grid min-h-0 content-start gap-1 overflow-y-auto">
                  {steps.map((st, i) => {
                    const done = stepAt >= 0 && i < stepAt;
                    const now = stepAt === i;
                    return (
                      <li key={st.state_id} className="flex items-center gap-2 text-[12px]">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            done ? "bg-emerald-500" : now ? "bg-blue-400" : "bg-card-border"
                          }`}
                        />
                        <span className={now ? "text-foreground" : "text-muted"}>{st.name}</span>
                      </li>
                    );
                  })}
                  {steps.length === 0 && (
                    <li className="text-[11.5px] text-muted">
                      This procedure has no steps defined.
                    </li>
                  )}
                </ol>
              </div>
            </Cell>
          </div>
        ) : (
          <div className="grid min-h-0 place-items-center p-8 text-center">
            <div>
              <Icon icon="heroicons-outline:shield-check" className="text-4xl text-muted opacity-40" />
              <p className="mt-2 text-[13px] text-foreground">Nothing open</p>
              <p className="mt-1 text-[11.5px] text-muted">
                An alarm arrives when a rule matches an event, or when somebody escalates one.
              </p>
            </div>
          </div>
        )}

        {/* ── THE QUEUE ──────────────────────────────────────────────────── */}
        <aside className="flex min-h-0 flex-col border-t border-card-border lg:border-l lg:border-t-0">
          <div className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Queue</span>
            <span className="ml-auto font-mono text-[11px] text-muted">{open.length}</span>
          </div>
          <ul aria-label="Queue" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {open.map((it, i) => {
              const si = sev(it.priority);
              const isla = slaFor(it);
              return (
                <li key={incId(it)}>
                  <button
                    type="button"
                    onClick={() => setCursor(i)}
                    aria-pressed={i === at}
                    className={`flex w-full gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                      i === at
                        ? "border-red-500/40 bg-red-500/10"
                        : "border-transparent hover:border-card-border hover:bg-hover/60"
                    }`}
                  >
                    <span className={`w-[3px] shrink-0 rounded-full ${si.band}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-foreground">{incTitle(it)}</span>
                      <span className="block font-mono text-[10.5px] text-muted">
                        {isla ? isla.label.replace(/^SLA /, "") : "no limit"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="shrink-0 border-t border-card-border p-2">
            <button
              type="button"
              onClick={next}
              disabled={open.length < 2}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-red-500/50 bg-red-500/15 px-3 py-2 text-[12px] font-semibold text-red-200 transition hover:bg-red-500/25 disabled:opacity-40"
            >
              Next alarm <Icon icon="heroicons-mini:arrow-right" className="text-xs" />
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
