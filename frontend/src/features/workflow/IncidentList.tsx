"use client";

// ALARMS (route /alarms) — the work half of the console.
//
// Events is the LEDGER: what the recorders reported, high volume, look and move
// on. This is the WORK: the things a person must do, each running a procedure,
// with an owner, a deadline and an outcome. It is reached from an event by
// escalating one, or raised by a rule the correlation engine matched.
//
// A QUEUE RAIL AND A BENTO, not a second copy of the events table. Events is
// scanned; an alarm is WORKED, and the two want different screens:
//
//   * THE RAIL, down the left, is the whole queue — thin rows carrying what it
//     is, how long is left and who has it. It never leaves the screen, so
//     switching between alarms costs a click and comparing them costs nothing.
//     (A strip of four cards was the first draft; it is useless the moment three
//     alarms fire together.)
//   * THE BENTO, on the right, is ONE alarm: its footage playing from the moment
//     it was raised from, the clock as a shape rather than a number, the
//     procedure's own steps with the moves that procedure allows, and what the
//     camera shows now.
//   * The section names itself in the TOP BAR with the counts beside it — a row
//     of chrome on the page is a row of evidence lost. The page never scrolls.
//
// It replaces a board of rich cards which, besides being sparse, carried a real
// defect: the whole card was a link and the camera strip inside it held another
// one, which is invalid HTML and threw a hydration error on every render.
//
// Realtime: useIncidentStream (core SSE bridge) drives list/stat refresh, the
// live badge, and the NEW mark on just-arrived rows; a slow poll is the net.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { HeaderSlot } from "@/components/shell/HeaderSlot";
import { apiError } from "@/lib/api";
import { asItems, titleize } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import type { SitePublic } from "@/lib/types";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import type { EstateCamera } from "@/features/vms/types";
import { workflow as wfApi } from "./api";
import { INCIDENT_SOURCES, INCIDENT_STATUSES, PRIORITIES } from "./constants";
import type { InstancePublic, NameMap, SopPublic } from "./types";
import IncidentBulkBar from "./components/incidents/IncidentBulkBar";
import type { BulkAction } from "./components/incidents/IncidentBulkBar";
import ViewToggle from "./components/incidents/ViewToggle";
import type { IncidentView } from "./components/incidents/ViewToggle";
import AlarmRail from "./components/incidents/AlarmRail";
import AlarmNow from "./components/incidents/AlarmNow";
import AlarmEvidenceCard, { type EvidenceKind } from "./components/incidents/AlarmEvidence";
import SlaRing from "./components/incidents/SlaRing";
import ProcedureSteps from "./components/incidents/ProcedureSteps";
import IncidentMap from "./components/incidents/IncidentMap";
import AssignModal from "./components/detail/AssignModal";
import { useIncidentStream } from "./hooks/useIncidentStream";
import {
  incAssignedId,
  incAssigneeName,
  incCameraId,
  incId,
  isOpen,
  isSlaBreaching,
  NEW_WINDOW_MS,
} from "./components/incidents/lib";

// Re-export domain constants from their canonical home for any legacy consumers.
export { STATUS_COLOR, PRIORITY_COLOR, INCIDENT_STATUSES, PRIORITIES } from "./constants";

const rowId = (it: InstancePublic): string => incId(it);

// Small debounce so the search input doesn't refire the query on every keystroke.
function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export default function WorkflowPage() {
  const qc = useQueryClient();
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput, 300);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [siteId, setSiteId] = useState("");
  const [sopId, setSopId] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(0);
  // A fixed page: the rail is a track, not a table an operator resizes. Fifty is
  // what fits a shift's queue without the pager becoming the main control.
  const pageSize = 50;
  const [view, setView] = useState<IncidentView>("board");

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, status, priority, siteId, sopId, source]);

  const sopsQ = useQuery({ queryKey: ["wf-sops"], queryFn: () => wfApi.sops.list({ limit: 200 }) });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const sops = useMemo<SopPublic[]>(() => (sopsQ.data ? asItems(sopsQ.data) : []), [sopsQ.data]);
  const sitesList = useMemo<SitePublic[]>(() => (sitesQ.data ? asItems(sitesQ.data) : []), [sitesQ.data]);

  const instancesQ = useQuery({
    queryKey: ["wf-instances", { q, status, priority, siteId, sopId, source, page, pageSize }],
    queryFn: () =>
      wfApi.instances.list({
        q: q || undefined,
        status: status || undefined,
        priority: priority || undefined,
        site_id: siteId || undefined,
        sop_id: sopId || undefined,
        source: source || undefined,
        skip: page * pageSize,
        limit: pageSize,
      }),
    refetchInterval: 60000,
  });

  const instances = useMemo<InstancePublic[]>(
    () => (instancesQ.data ? asItems(instancesQ.data) : []),
    [instancesQ.data],
  );
  const total = instancesQ.data?.total ?? instances.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // NEW tracking: ids first seen via SSE (or freshly-created) are marked for a
  // short window. We stamp each id with its first-seen time and prune on read.
  const [newSeen, setNewSeen] = useState(() => new Map<string, number>());
  const stampNew = (id: string) =>
    setNewSeen((m) => {
      const n = new Map<string, number>(m);
      n.set(String(id), Date.now());
      return n;
    });

  const [connected, setConnected] = useState(false);
  useIncidentStream(
    (evt) => {
      const id = evt.data?.instance_id ?? evt.data?.id;
      if (id) stampNew(String(id));
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      qc.invalidateQueries({ queryKey: ["wf-stats"] });
    },
    { onStatus: setConnected },
  );

  // The clock the "new" mark is measured against. Held in state and advanced by
  // the interval below rather than read during render: reading Date.now() while
  // rendering makes the render impure, and the value has to move on a timer
  // anyway for the mark to expire.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (newSeen.size === 0) return undefined;
    const t = setInterval(() => {
      setNow(Date.now());
      setNewSeen((m) => {
        const cutoff = Date.now();
        let changed = false;
        const n = new Map<string, number>();
        for (const [k, v] of m) {
          if (cutoff - v < NEW_WINDOW_MS) n.set(k, v);
          else changed = true;
        }
        return changed ? n : m;
      });
    }, 15000);
    return () => clearInterval(t);
  }, [newSeen.size]);

  const newIds = useMemo(() => {
    const s = new Set<string>();
    for (const [k, v] of newSeen) if (now - v < NEW_WINDOW_MS) s.add(k);
    for (const it of instances) {
      const c = it.created_at ? new Date(it.created_at).getTime() : 0;
      if (c && now - c < NEW_WINDOW_MS) s.add(String(rowId(it)));
    }
    return s;
  }, [newSeen, instances, now]);

  // Stats strip (defensive: if the /stats endpoint isn't live, retry:false hides it).
  const statsQ = useQuery({
    queryKey: ["wf-stats"],
    queryFn: () => wfApi.instances.stats(),
    retry: false,
    refetchInterval: 60000,
  });
  const byStatus = statsQ.data?.by_status || null;
  const byPriority = statsQ.data?.by_priority || null;

  // SCOPE, SAID HONESTLY. "Active" and "Critical" come from /stats, which counts
  // the whole deployment. Breaching and Unassigned are not in /stats, so they can
  // only be counted from the rows actually loaded — and a number that looks
  // estate-wide but counts twenty-five rows is worse than no number. The chips
  // say which is which in their titles.
  const criticalOpen = useMemo(() => {
    const fromPage = instances.filter((it) => it.priority === "critical" && isOpen(it.status)).length;
    const statNum = Number(byPriority?.critical);
    return Number.isFinite(statNum) && !status && !priority ? Math.max(statNum, fromPage) : fromPage;
  }, [instances, byPriority, status, priority]);

  const activeCount = useMemo(() => {
    const statNum = Number(byStatus?.active);
    if (Number.isFinite(statNum) && !status && !priority && !siteId && !sopId && !q) return statNum;
    return instances.filter((it) => it.status === "active").length;
  }, [byStatus, instances, status, priority, siteId, sopId, q]);

  const slaBreaching = useMemo(() => instances.filter((it) => isSlaBreaching(it)).length, [instances]);

  // Closed since local midnight — the shift's own answer to "are we keeping up".
  // Counts the loaded page, like the two above it, and the tile says so.
  const closedToday = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return instances.filter((it) => {
      const at = it.closed_at || (isOpen(it.status) ? null : it.updated_at);
      return !!at && new Date(at).getTime() >= midnight.getTime();
    }).length;
  }, [instances]);

  // Who is carrying what, from the OPEN alarms on this page. Sorted heaviest
  // first, because the question this answers is who to hand the next one to.
  const ownerLoad = useMemo(() => {
    const by = new Map<string, number>();
    for (const it of instances) {
      if (!isOpen(it.status)) continue;
      const name = incAssigneeName(it);
      if (!name) continue;
      by.set(name, (by.get(name) || 0) + 1);
    }
    return [...by.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [instances]);
  const unassigned = useMemo(
    () => instances.filter((it) => isOpen(it.status) && !incAssignedId(it)).length,
    [instances],
  );

  // ── Selection: the evidence panes follow the row ─────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // WHICH PICTURE OWNS THE BIG CELL. The recording by default — it is what the
  // alarm is about — but the moment a window turns out to hold no footage the
  // space goes to live instead, unless the operator has said otherwise. A black
  // rectangle reading "No footage" must never be the biggest thing on the screen
  // while a working live view sits in the smallest tile.
  const [evidence, setEvidence] = useState<EvidenceKind>("recording");
  const [evidenceChosen, setEvidenceChosen] = useState(false);
  const pickEvidence = (kind: EvidenceKind) => {
    setEvidence(kind);
    setEvidenceChosen(true);
  };

  const selected = useMemo(() => {
    const byId = instances.find((it) => rowId(it) === selectedId);
    // Nothing chosen yet: the first row, so the panes are never blank while the
    // queue has something in it.
    return byId || instances[0] || null;
  }, [selectedId, instances]);

  // The camera an alarm names, as the ESTATE knows it. The incident carries the
  // node-side id the recorder reported; the estate list is keyed by both that and
  // the composite federation key, so this resolves either way.
  const { cameras } = useEstateCameras();
  const cameraById = useMemo(() => {
    const m: Record<string, EstateCamera> = {};
    for (const c of cameras) {
      m[c.id] = c;
      const real = (c as { real_id?: string }).real_id;
      if (real) m[real] = c;
    }
    return m;
  }, [cameras]);
  const selectedCamera = useMemo(() => {
    const id = selected ? incCameraId(selected) : null;
    return id ? cameraById[id] ?? null : null;
  }, [selected, cameraById]);

  // ── Bulk selection over the current page ─────────────────────────────────
  const [checked, setChecked] = useState(() => new Set<string>());
  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set<string>(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSel = () => setChecked(new Set<string>());

  const bulk = useMutation({
    mutationFn: async (kind: BulkAction) => {
      const ids = [...checked];
      const fn =
        kind === "escalate"
          ? (id: string) => wfApi.instances.escalate(id, null)
          : (id: string) => wfApi.instances.setStatus(id, kind, null);
      const results = await Promise.allSettled(ids.map(fn));
      return { total: ids.length, failed: results.filter((r) => r.status === "rejected").length };
    },
    onSuccess: ({ total: n, failed }) => {
      (failed ? toast.warning : toast.success)(
        `${n - failed}/${n} updated${failed ? ` · ${failed} not applicable` : ""}`,
      );
      clearSel();
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      statsQ.refetch();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Take it = activate a pending alarm (matches STATUS_ACTIONS in the detail
  // console). Reuses the real status endpoint.
  const quick = useMutation({
    mutationFn: ({ id }: { id: string }) => wfApi.instances.setStatus(id, "active", null),
    onSuccess: () => {
      toast.success("Alarm taken");
      qc.invalidateQueries({ queryKey: ["wf-instances"] });
      statsQ.refetch();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const [assignFor, setAssignFor] = useState<InstancePublic | null>(null);

  const sopName = useMemo(() => {
    const m: NameMap = {};
    for (const s of sops) m[s.sop_id] = s.name;
    return m;
  }, [sops]);
  const siteName = useMemo(() => {
    const m: NameMap = {};
    for (const s of sitesList) m[s.site_id] = s.name;
    return m;
  }, [sitesList]);

  const filtered = !!(q || status || priority || siteId || sopId || source);
  const filterCount = [status, priority, siteId, sopId, source].filter(Boolean).length;
  // Folded by default: five selects took more of the rail than the queue did.
  // Opened by a filter already being on, so a narrowed queue never looks like an
  // empty estate.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const showFilters = filtersOpen || filterCount > 0;
  const clearFilters = () => {
    setQInput("");
    setStatus("");
    setPriority("");
    setSiteId("");
    setSopId("");
    setSource("");
  };

  const sel =
    "h-8 rounded-lg border border-field bg-transparent px-2 text-[12px] text-foreground outline-hidden focus:border-muted";

  return (
    // RAIL + BENTO. The rail is a fixed track so the queue never reflows when an
    // alarm with a long name is selected; everything else takes what is left.
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)]">
      {/* ── IN THE TOP BAR ────────────────────────────────────────────────
          Live state and the counts an operator triages by, beside the "Alarms"
          badge, so the page itself opens on the work. */}
      <HeaderSlot>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2.5 w-2.5">
              {connected && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  connected ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
            </span>
            <span className="text-[12px] font-semibold text-foreground">
              {connected ? "Live" : "Reconnecting…"}
            </span>
          </span>

          <span className="mx-0.5 h-5 w-px bg-card-border" aria-hidden />

          <CountChip
            label="Critical"
            value={criticalOpen}
            tone="bad"
            active={priority === "critical"}
            title="Open critical alarms, across the deployment"
            onClick={() => setPriority(priority === "critical" ? "" : "critical")}
          />
          <CountChip
            label="Active"
            value={activeCount}
            active={status === "active"}
            title="Alarms somebody is working, across the deployment"
            onClick={() => setStatus(status === "active" ? "" : "active")}
          />
          <CountChip
            label="Overdue"
            value={slaBreaching}
            tone={slaBreaching ? "bad" : "ok"}
            title="Past their deadline — counted on this page only"
          />
          <CountChip
            label="Unassigned"
            value={unassigned}
            tone={unassigned ? "warn" : "ok"}
            title="Open and nobody owns them — counted on this page only"
          />

          <button
            type="button"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["wf-instances"] });
              statsQ.refetch();
            }}
            title="Re-read the queue"
            aria-label="Refresh"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-path" className="text-xs" />
          </button>
        </div>
      </HeaderSlot>

      {/* ── THE QUEUE ──────────────────────────────────────────────────── */}
      <AlarmRail
        rows={instances}
        selectedId={selected ? rowId(selected) : null}
        onSelect={(it) => {
          setSelectedId(rowId(it));
          // A new alarm is a new question: go back to its recording and let the
          // fallback decide again.
          setEvidence("recording");
          setEvidenceChosen(false);
        }}
        checked={checked}
        onToggleChecked={toggle}
        sopName={sopName}
        newIds={newIds}
        empty={
          instancesQ.isLoading ? (
            <span className="inline-flex items-center gap-2 text-[12px] text-muted">
              <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
            </span>
          ) : instancesQ.isError ? (
            // A failed read must never look like a quiet estate.
            <span className="text-center text-[12px] text-red-400">
              Could not load the queue.
              <span className="mt-1 block text-[11px] opacity-80">
                {apiError(instancesQ.error, "Unknown error")}
              </span>
            </span>
          ) : filtered ? (
            <span className="text-center text-[12px] text-muted">
              No alarms match these filters.
              <button
                type="button"
                onClick={clearFilters}
                className="mt-2 block w-full rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
              >
                Clear filters
              </button>
            </span>
          ) : (
            <span className="text-center text-[12px] text-muted">
              No alarms.
              <span className="mt-1 block text-[11px]">
                One arrives when a rule matches an event, or when somebody escalates one.
              </span>
              <Link
                href="/events"
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons:bolt" className="text-xs" /> Go to Events
              </Link>
            </span>
          )
        }
        toolbar={
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                Queue
              </span>
              <span className="font-mono text-[11px] text-muted">{total}</span>
              <span className="ml-auto">
                <ViewToggle view={view} onChange={setView} />
              </span>
            </div>
            <label className="relative block">
              <Icon
                icon="heroicons-outline:magnifying-glass"
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted"
              />
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search alarms"
                aria-label="Search alarms"
                className={`${sel} w-full pl-7`}
              />
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={showFilters}
              className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:funnel" className="text-xs" />
              Filters
              {filterCount > 0 && (
                <span className="rounded-full bg-blue-500/15 px-1.5 text-[10px] font-semibold text-blue-300">
                  {filterCount}
                </span>
              )}
              <Icon
                icon={showFilters ? "heroicons-mini:chevron-up" : "heroicons-mini:chevron-down"}
                className="ml-auto text-xs"
              />
            </button>

            {showFilters && (
            <>
            <div className="flex flex-wrap gap-1.5">
              <select
                aria-label="Filter by state"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className={`${sel} min-w-0 flex-1`}
              >
                <option value="">All states</option>
                {INCIDENT_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {titleize(st)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={`${sel} min-w-0 flex-1`}
              >
                <option value="">All priorities</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {titleize(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <select
                aria-label="Filter by procedure"
                value={sopId}
                onChange={(e) => setSopId(e.target.value)}
                className={`${sel} min-w-0 flex-1`}
              >
                <option value="">All procedures</option>
                {sops.map((sp) => (
                  <option key={sp.sop_id} value={sp.sop_id}>
                    {sp.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by site"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className={`${sel} min-w-0 flex-1`}
              >
                <option value="">All sites</option>
                {sitesList.map((st) => (
                  <option key={st.site_id} value={st.site_id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </div>
            <select
              aria-label="Filter by source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={`${sel} w-full`}
            >
              {INCIDENT_SOURCES.map((sr) => (
                <option key={sr.value} value={sr.value}>
                  {sr.label}
                </option>
              ))}
            </select>
            {filtered && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear filters
              </button>
            )}
            </>
            )}
          </>
        }
        footer={
          <>
            <span className="font-mono text-[11px] text-muted">
              {total === 0
                ? "0"
                : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}`}
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
              >
                <Icon icon="heroicons-mini:chevron-left" className="text-xs" />
              </button>
              <span className="px-0.5 font-mono text-[11px] text-muted">
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
              >
                <Icon icon="heroicons-mini:chevron-right" className="text-xs" />
              </button>
            </span>
          </>
        }
      />

      {/* ── THE ALARM BEING WORKED ─────────────────────────────────────── */}
      <div className="flex h-full min-h-0 flex-col gap-3">
        {checked.size > 0 && (
          <IncidentBulkBar
            count={checked.size}
            pending={bulk.isPending}
            onAction={(kind) => bulk.mutate(kind)}
            onClear={clearSel}
          />
        )}

        {view === "map" ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-card-border bg-card p-3">
            <IncidentMap incidents={instances} sites={sitesList} siteName={siteName} sopName={sopName} />
          </div>
        ) : (
          // THE BENTO. Deliberately asymmetric: the picture is the biggest thing
          // on the screen, because looking is why an operator is here. The three
          // small cells answer the questions that follow it — how long, what next,
          // and is it still happening.
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="min-h-[18rem] xl:row-span-2 xl:min-h-0">
              <AlarmNow
                incident={selected}
                camera={selectedCamera}
                siteName={siteName}
                kind={evidence}
                onKindChange={pickEvidence}
                onFootage={(present) => {
                  if (!present && !evidenceChosen) setEvidence("live");
                }}
                onTake={(it) => quick.mutate({ id: rowId(it) })}
                onAssign={(it) => setAssignFor(it)}
                takePending={quick.isPending}
              />
            </div>

            <div className="grid min-h-[10rem] grid-cols-2 gap-3 xl:min-h-0">
              <SlaRing incident={selected} />
              <ShiftLoad
                overdue={slaBreaching}
                unassigned={unassigned}
                closedToday={closedToday}
                owners={ownerLoad}
              />
            </div>

            <div className="grid min-h-[14rem] grid-cols-1 gap-3 md:grid-cols-2 xl:min-h-0">
              <ProcedureSteps incident={selected} />
              {/* THE OTHER PICTURE. Whatever the big cell is not showing, so the
                  operator always has both without a mode nobody can see. */}
              <AlarmEvidenceCard
                incident={selected}
                camera={selectedCamera}
                kind={evidence === "recording" ? "live" : "recording"}
                onPromote={() => pickEvidence(evidence === "recording" ? "live" : "recording")}
              />
            </div>
          </div>
        )}
      </div>

      {assignFor && (
        <AssignModal
          open={!!assignFor}
          onClose={() => setAssignFor(null)}
          instanceId={rowId(assignFor)}
          currentAssigneeId={incAssignedId(assignFor)}
          onAssigned={() => {
            qc.invalidateQueries({ queryKey: ["wf-instances"] });
            statsQ.refetch();
            setAssignFor(null);
          }}
        />
      )}
    </div>
  );
}

/** The shift, in three numbers and a roll call. Every one of them counts THE
 *  LOADED PAGE — none of it is in /stats — and the tile says so rather than
 *  looking deployment-wide. */
function ShiftLoad({
  overdue,
  unassigned,
  closedToday,
  owners,
}: {
  overdue: number;
  unassigned: number;
  closedToday: number;
  owners: { name: string; count: number }[];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
        This page
      </span>
      <div className="mt-2 grid gap-1.5">
        <Kpi value={overdue} label="overdue" tone={overdue ? "bad" : "flat"} />
        <Kpi value={unassigned} label="unassigned" tone={unassigned ? "warn" : "flat"} />
        <Kpi value={closedToday} label="closed today" tone="flat" />
      </div>
      {owners.length > 0 && (
        <div className="mt-2 grid min-h-0 flex-1 content-start gap-1 overflow-y-auto border-t border-card-border pt-2">
          {owners.map((o) => (
            <span key={o.name} className="flex items-center gap-2 text-[11.5px] text-muted">
              <span className="truncate text-foreground">{o.name}</span>
              <span className="ml-auto font-mono tabular-nums">{o.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({ value, label, tone }: { value: number; label: string; tone: "bad" | "warn" | "flat" }) {
  const cls = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-400" : "text-foreground";
  return (
    <span className="flex items-baseline gap-2">
      <b className={`font-mono text-[22px] font-semibold tabular-nums ${cls}`}>{value}</b>
      <span className="text-[11.5px] text-muted">{label}</span>
    </span>
  );
}

/** A count that FILTERS where it cleanly can. The two that only count the loaded
 *  page say so in their title rather than pretending to be estate-wide. */
function CountChip({
  label,
  value,
  tone = "info",
  active,
  title,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "info" | "bad" | "warn" | "ok";
  active?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const toneCls =
    tone === "bad"
      ? "text-red-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "ok"
          ? "text-emerald-400"
          : "text-foreground";
  const clickable = typeof onClick === "function";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      aria-pressed={clickable ? !!active : undefined}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
        active
          ? "border-blue-500/50 bg-blue-500/10 text-foreground"
          : "border-card-border text-muted"
      } ${clickable ? "hover:bg-hover hover:text-foreground" : "cursor-default"}`}
    >
      <span className={`font-mono text-[13px] tabular-nums ${toneCls}`}>{value}</span>
      {label}
    </button>
  );
}
