"use client";

// ALARMS (route /alarms) — the work half of the console.
//
// Events is the LEDGER: what the recorders reported, high volume, look and move
// on. This is the WORK: the things a person must do, each running a procedure,
// with an owner, a deadline and an outcome. It is reached from an event by
// escalating one, or raised by a rule the correlation engine matched.
//
// SAME SHAPE AS THE EVENTS CONSOLE, for the same reasons and after the same
// feedback:
//
//   * the section names itself in the TOP BAR, and the counts an operator
//     triages by ride there too — a row of chrome on the page is a row of
//     evidence lost;
//   * EVIDENCE ACROSS THE TOP: what the camera recorded when the alarm was
//     raised, the alarm's own facts, and what that camera shows NOW. An alarm
//     console that describes an event and sends the operator elsewhere to look
//     has the job backwards;
//   * ONE DENSE TABLE below, filters in its toolbar and paging at the right of
//     that toolbar, rows scrolling INSIDE it. The page itself never scrolls, so
//     the video an operator was told to watch cannot leave the screen.
//
// It replaces a board of rich cards. A card repeats every label on every row, so
// eight alarms filled a screen a table holds thirty of, and "everything breaching
// SLA" was a hunt rather than a glance. The cards also carried a real defect: the
// whole card was a link and the camera strip inside it held another one, which is
// invalid HTML and threw a hydration error on every render.
//
// Realtime: useIncidentStream (core SSE bridge) drives list/stat refresh, the
// live badge, and the NEW mark on just-arrived rows; a slow poll is the net.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { HeaderSlot } from "@/components/shell/HeaderSlot";
import { EmptyState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, titleize } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import type { SitePublic } from "@/lib/types";
import EventLivePane from "@/features/vms/components/EventLivePane";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import type { EstateCamera } from "@/features/vms/types";
import { workflow as wfApi } from "./api";
import { INCIDENT_SOURCES, INCIDENT_STATUSES, PRIORITIES } from "./constants";
import type { InstancePublic, NameMap, SopPublic } from "./types";
import IncidentBulkBar from "./components/incidents/IncidentBulkBar";
import type { BulkAction } from "./components/incidents/IncidentBulkBar";
import ViewToggle from "./components/incidents/ViewToggle";
import type { IncidentView } from "./components/incidents/ViewToggle";
import AlarmTable from "./components/incidents/AlarmTable";
import AlarmDetails from "./components/incidents/AlarmDetails";
import AlarmRecordingPane from "./components/incidents/AlarmRecordingPane";
import IncidentMap from "./components/incidents/IncidentMap";
import AssignModal from "./components/detail/AssignModal";
import { useIncidentStream } from "./hooks/useIncidentStream";
import {
  incAssignedId,
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
  const [pageSize, setPageSize] = useState(25);
  const [view, setView] = useState<IncidentView>("board");

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [q, status, priority, siteId, sopId, source, pageSize]);

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
  const unassigned = useMemo(
    () => instances.filter((it) => isOpen(it.status) && !incAssignedId(it)).length,
    [instances],
  );

  // ── Selection: the evidence panes follow the row ─────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const selected = useMemo(() => {
    if (dismissed) return null;
    const byId = instances.find((it) => rowId(it) === selectedId);
    // Nothing chosen yet: the first row, so the panes are never blank while the
    // queue has something in it.
    return byId || instances[0] || null;
  }, [dismissed, selectedId, instances]);

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
  const allSelected = instances.length > 0 && instances.every((it) => checked.has(rowId(it)));
  const toggleAll = () =>
    setChecked(allSelected ? new Set<string>() : new Set<string>(instances.map(rowId)));

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
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── IN THE TOP BAR ────────────────────────────────────────────────
          Live state and the counts an operator triages by, beside the "Alarms"
          badge. The filters live in the table's toolbar, with the rows they
          narrow, which is what lets the evidence start at the top of the page. */}
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

      {/* ── EVIDENCE ABOVE, QUEUE BELOW ───────────────────────────────────
          The recording at the moment the alarm was raised from, its facts, and
          what that camera shows now. A bounded row: Details scrolls in its own
          card so a long alarm cannot stretch the players out of shape. */}
      <div className="grid shrink-0 grid-cols-1 gap-3 [&>*]:min-h-[15rem] lg:h-[19rem] lg:grid-cols-3 lg:[&>*]:min-h-0">
        <AlarmRecordingPane incident={selected} camera={selectedCamera} />
        {selected ? (
          <AlarmDetails
            incident={selected}
            sopName={sopName}
            siteName={siteName}
            cameraName={selectedCamera?.name ?? null}
            onAck={(it) => quick.mutate({ id: rowId(it) })}
            onAssign={(it) => setAssignFor(it)}
            ackPending={quick.isPending}
            onClose={() => {
              setDismissed(true);
              setSelectedId(null);
            }}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
            <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
              <Icon icon="heroicons-outline:information-circle" className="text-sm text-blue-500" />
              <span className="text-[12px] font-semibold text-foreground">Details</span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon icon="heroicons-outline:cursor-arrow-rays" className="text-3xl text-muted opacity-40" />
              <p className="text-[12.5px] text-foreground">Pick an alarm</p>
              <p className="max-w-xs text-[11px] text-muted">
                Its procedure, deadline, owner and the event behind it land here.
              </p>
            </div>
          </div>
        )}
        <EventLivePane camera={selectedCamera} />
      </div>

      {checked.size > 0 && (
        <IncidentBulkBar
          count={checked.size}
          pending={bulk.isPending}
          onAction={(kind) => bulk.mutate(kind)}
          onClear={clearSel}
        />
      )}

      {instancesQ.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center gap-2 rounded-xl border border-card-border bg-card p-6 text-xs text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading alarms…
        </div>
      ) : instancesQ.isError ? (
        // A failed read must never look like a quiet estate.
        <div className="flex min-h-0 flex-1 items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <Icon icon="heroicons-outline:exclamation-circle" className="mt-0.5 shrink-0 text-sm" />
          <div>
            <p className="font-medium">Could not load alarms</p>
            <p className="mt-0.5 text-[11px] opacity-80">{apiError(instancesQ.error, "Unknown error")}</p>
          </div>
        </div>
      ) : view === "map" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <IncidentMap incidents={instances} sites={sitesList} siteName={siteName} sopName={sopName} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <AlarmTable
            rows={instances}
            selectedId={selected ? rowId(selected) : null}
            onSelect={(it) => {
              setSelectedId(rowId(it));
              setDismissed(false);
            }}
            checked={checked}
            onToggleChecked={toggle}
            onToggleAll={toggleAll}
            sopName={sopName}
            siteName={siteName}
            newIds={newIds}
            empty={
              <EmptyState
                icon={filtered ? "heroicons-outline:funnel" : "heroicons-outline:shield-check"}
                title={filtered ? "No alarms match these filters" : "No alarms"}
                subtitle={
                  filtered
                    ? "Widen the state, the priority or the site — the filters are still above."
                    : "An alarm arrives when a rule matches an event, or when somebody escalates one from Events."
                }
                action={
                  filtered ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
                    >
                      <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear filters
                    </button>
                  ) : (
                    <Link
                      href="/events"
                      className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
                    >
                      <Icon icon="heroicons:bolt" className="text-xs" /> Go to Events
                    </Link>
                  )
                }
              />
            }
            toolbar={
              <>
                <label className="relative w-48">
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
                <select
                  aria-label="Filter by state"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className={sel}
                >
                  <option value="">All states</option>
                  {INCIDENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleize(s)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className={sel}
                >
                  <option value="">All priorities</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {titleize(p)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by site"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className={sel}
                >
                  <option value="">All sites</option>
                  {sitesList.map((s) => (
                    <option key={s.site_id} value={s.site_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by procedure"
                  value={sopId}
                  onChange={(e) => setSopId(e.target.value)}
                  className={sel}
                >
                  <option value="">All procedures</option>
                  {sops.map((s) => (
                    <option key={s.sop_id} value={s.sop_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className={sel}
                >
                  {INCIDENT_SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {filtered && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:x-mark" className="text-xs" /> Clear
                  </button>
                )}
              </>
            }
            paging={
              <>
                <ViewToggle view={view} onChange={setView} />
                <span className="font-mono text-[11px] text-muted">
                  {total === 0
                    ? "0"
                    : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}`}
                </span>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                  Rows
                  <select
                    aria-label="Rows per page"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="h-7 rounded-md border border-field bg-transparent px-1.5 text-[11px] text-foreground outline-hidden"
                  >
                    {[25, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
                  >
                    <Icon icon="heroicons-mini:chevron-left" className="text-xs" />
                  </button>
                  <span className="px-1 font-mono text-[11px] text-muted">
                    {page + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-40"
                  >
                    <Icon icon="heroicons-mini:chevron-right" className="text-xs" />
                  </button>
                </span>
              </>
            }
          />
        </div>
      )}

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
