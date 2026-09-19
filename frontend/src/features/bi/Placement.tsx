"use client";

// Building Intelligence → Setup → BUILDINGS & DEVICES (gate 3).
//
// ONE TABLE. Every device without a building is a row, with a building
// PRE-FILLED where the store holds evidence for one and the reason printed
// beside it (`setup/placement/suggest.ts`): a same-named device already in that
// building, or a gateway whose other devices are all in it. The operator reads
// the reasons, changes any row they disagree with, and saves. Nothing is placed
// until they press — and no row is pre-filled from the mere fact that the
// estate has one building.
//
// Devices already in a building are a second, folded section of the same
// table, so moving one is the same gesture as placing one.
//
// `?category=energy` from a domain strip narrows both lists, as before.
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { ConsolePage } from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { BiDeviceListResponse, BiDeviceRow } from "@/lib/types";

import { bi } from "./api";
import { assignable, assignBody } from "./assign";
import { MODULE, PERM_ASSIGN, PERM_READ, PERM_SITES_READ } from "./constants";
import { changesOf, fmtDay, suggest, type Row } from "./setup/placement/suggest";
import { useBuildings } from "./setup/useBuildings";
import { useAssignDevices } from "./useAssignDevices";

/** The server's cap on one `/bi/devices` page. */
const PAGE = 500;

const TONE: Record<Row["tone"], string> = {
  evidence: "text-nb-blueb",
  gateway: "text-nb-soft",
  warn: "text-nb-warn",
  none: "text-nb-faint",
};

export default function Placement() {
  return (
    <Suspense fallback={null}>
      <PlacementInner />
    </Suspense>
  );
}

function PlacementInner() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  // The write is core's, under core's key; choosing a building needs the list.
  const mayAssign = mayRead && can(PERM_ASSIGN) && can(PERM_SITES_READ);
  const category = useSearchParams().get("category") || undefined;
  const still = !!useReducedMotion();

  const unplacedQ = useQuery<BiDeviceListResponse>({
    queryKey: ["bi-devices", "placement", "unplaced", category ?? ""],
    queryFn: () => bi.devices({ placement: "unplaced", category, limit: PAGE }),
    enabled: mayRead,
  });
  const placedQ = useQuery<BiDeviceListResponse>({
    queryKey: ["bi-devices", "placement", "placed", category ?? ""],
    queryFn: () => bi.devices({ placement: "placed", category, limit: PAGE }),
    enabled: mayRead,
  });
  const { items: buildings } = useBuildings(mayRead);

  const unplaced = useMemo(() => unplacedQ.data?.items ?? [], [unplacedQ.data]);
  const placed = useMemo(() => placedQ.data?.items ?? [], [placedQ.data]);
  // Suggestions read the PLACED list too — without it there is no evidence, so
  // the table waits for both rather than showing rows with no reasons.
  const rows = useMemo(
    () => (placedQ.data ? suggest(unplaced, placed) : []),
    [unplaced, placed, placedQ.data],
  );

  // What a person changed. A row they did not touch shows its suggestion.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [showPlaced, setShowPlaced] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const assign = useAssignDevices();
  const [saving, setSaving] = useState(false);

  const current = useMemo(() => {
    const c: Record<string, string | null> = {};
    for (const d of [...unplaced, ...placed]) if (d.device_id) c[d.device_id] = d.site_id ?? null;
    return c;
  }, [unplaced, placed]);

  const choiceOf = (d: BiDeviceRow, s: string | null | undefined) =>
    d.device_id ? edits[d.device_id] ?? s ?? "" : "";

  const choices = useMemo(() => {
    const c: Record<string, string> = {};
    for (const r of rows) if (r.device.device_id) c[r.device.device_id] = choiceOf(r.device, r.suggestion?.siteId);
    for (const d of placed) if (d.device_id) c[d.device_id] = choiceOf(d, d.site_id);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, placed, edits]);

  const changes = useMemo(() => changesOf(choices, current), [choices, current]);
  const changeCount = [...changes.values()].reduce((n, ids) => n + ids.length, 0);
  const untouchedSuggestions =
    Object.keys(edits).length === 0 && changeCount === rows.filter((r) => r.suggestion).length;
  const suggested = rows.filter((r) => r.suggestion).length;

  async function save() {
    setSaving(true);
    setErr(null);
    let placedN = 0;
    let moved = 0;
    let pins = 0;
    try {
      for (const [siteId, ids] of changes) {
        const body = assignBody(ids.map((device_id) => ({ device_id })), siteId);
        if (!body) continue;
        const res = await assign.mutateAsync(body);
        for (const a of res.items ?? []) {
          placedN += 1;
          if (!a.created) moved += 1;
          if (a.pin_cleared) pins += 1;
        }
      }
      setEdits({});
      setDone(
        `Placed ${placedN}` +
          (moved ? ` · ${moved} moved from another building` : "") +
          (pins ? ` · ${pins} lost their floor-plan pin` : ""),
      );
    } catch (e) {
      setErr(
        (placedN ? `Placed ${placedN}, then: ` : "") + apiError(e, "Nothing more was placed"),
      );
    } finally {
      setSaving(false);
    }
  }

  if (!mayRead) {
    return (
      <ConsolePage>
        <p className="pt-6 text-[12.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  const loading = unplacedQ.isLoading || placedQ.isLoading;
  const loadErr = unplacedQ.error || placedQ.error;

  return (
    <ConsolePage>
      {/* FULL WIDTH, AND THE PAGE NEVER SCROLLS: the header line stays put and
          only the table's body scrolls, so "Accept" is always in reach. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 pt-4">
        {/* one line: the size of the job, and the one press */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-[14px] text-nb-soft">
            <span className="text-[19px] font-semibold tabular-nums text-nb-ink">
              {unplacedQ.data ? unplacedQ.data.total : "—"}
            </span>{" "}
            devices without a building
            {rows.length > 0 && (
              <span className="text-nb-muted"> · a building is suggested for {suggested}</span>
            )}
          </p>
          <span className="flex-1" />
          {mayAssign ? (
            <button
              type="button"
              onClick={save}
              disabled={!changeCount || saving}
              className="h-9 rounded-[8px] bg-nb-blue px-4 text-[13px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-40"
            >
              {saving
                ? "Saving…"
                : !changeCount
                  ? "Nothing to save"
                  : untouchedSuggestions
                    ? `Accept ${changeCount} suggestion${changeCount === 1 ? "" : "s"}`
                    : `Save ${changeCount} change${changeCount === 1 ? "" : "s"}`}
            </button>
          ) : (
            <span className="text-[12px] text-nb-faint">
              Placing needs <span className="font-mono">{PERM_ASSIGN}</span>
            </span>
          )}
        </div>

        <AnimatePresence>
          {(done || err) && (
            <motion.p
              key={done || err}
              initial={still ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`text-[12.5px] ${err ? "text-nb-crit" : "text-nb-good"}`}
            >
              {err || done}
            </motion.p>
          )}
        </AnimatePresence>

        {loadErr && (
          <p className="rounded-[10px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)] px-4 py-2.5 text-[12.5px] text-nb-crit">
            {apiError(loadErr, "Could not read the devices")}
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-white/[.08]">
          <Header />
          <div data-testid="placement-rows" className="min-h-0 flex-1 overflow-y-auto">
          {loading && <p className="px-5 py-10 text-center text-[13px] text-nb-faint">Reading the devices…</p>}
          {!loading && rows.length === 0 && !loadErr && (
            <p className="px-5 py-8 text-center text-[13px] text-nb-muted">Every device is in a building.</p>
          )}
          {rows.map((r, i) => (
            <DeviceLine
              key={r.device.device_id ?? `${r.device.device_tag}-${i}`}
              device={r.device}
              value={choices[r.device.device_id ?? ""] ?? ""}
              buildings={buildings}
              reason={r.reason}
              tone={r.tone}
              quiet={!!r.quietSince}
              mayAssign={mayAssign}
              onChange={(siteId) => r.device.device_id && setEdits((e) => ({ ...e, [r.device.device_id!]: siteId }))}
            />
          ))}

          {placed.length > 0 && (
            <button
              type="button"
              onClick={() => setShowPlaced((s) => !s)}
              className="flex w-full items-center gap-2 border-t border-white/[.06] px-5 py-3 text-left text-[12.5px] text-nb-muted transition hover:text-nb-ink"
            >
              <Icon
                icon="heroicons-outline:chevron-right"
                className={`text-[13px] transition-transform ${showPlaced ? "rotate-90" : ""}`}
              />
              {placedQ.data?.total ?? placed.length} already in a building
            </button>
          )}
          {showPlaced &&
            placed.map((d, i) => (
              <DeviceLine
                key={d.device_id ?? `p-${d.device_tag}-${i}`}
                device={d}
                value={choices[d.device_id ?? ""] ?? ""}
                buildings={buildings}
                reason={d.site_name ? `in ${d.site_name}` : ""}
                tone="none"
                quiet={false}
                mayAssign={mayAssign}
                onChange={(siteId) => d.device_id && setEdits((e) => ({ ...e, [d.device_id!]: siteId }))}
              />
            ))}
          </div>
        </div>
      </div>
    </ConsolePage>
  );
}

const COLS = "grid grid-cols-[minmax(0,1.2fr)_220px_minmax(0,1fr)_110px] items-center gap-x-5";

function Header() {
  return (
    <div className={`${COLS} bg-white/[.02] px-5 py-2.5 text-[10.5px] tracking-[.6px] text-nb-faint`}>
      <span>DEVICE</span>
      <span>BUILDING</span>
      <span>WHY</span>
      <span className="text-right">LAST SEEN</span>
    </div>
  );
}

function DeviceLine({
  device,
  value,
  buildings,
  reason,
  tone,
  quiet,
  mayAssign,
  onChange,
}: Readonly<{
  device: BiDeviceRow;
  value: string;
  buildings: { site_id: string; site_name: string | null }[];
  reason: string;
  tone: Row["tone"];
  quiet: boolean;
  mayAssign: boolean;
  onChange: (siteId: string) => void;
}>) {
  const can = mayAssign && assignable(device);
  const label = device.device_tag ?? "unnamed device";
  return (
    <div className={`${COLS} border-t border-white/[.05] px-5 py-2.5 ${quiet ? "bg-white/[.012]" : ""}`}>
      <div className="min-w-0">
        <div className={`truncate text-[13px] ${quiet ? "text-nb-muted" : "text-nb-ink"}`}>{label}</div>
        <div className="text-[11px] text-nb-faint">
          {device.category ?? "no category"} · {device.points} pts
        </div>
      </div>
      <select
        aria-label={`Building for ${label}`}
        value={value}
        disabled={!can}
        onChange={(e) => onChange(e.target.value)}
        className={`h-8 rounded-[7px] border bg-transparent px-2 text-[12.5px] outline-none transition disabled:opacity-50 ${
          value ? "border-nb-blue/40 text-nb-blueb" : "border-white/[.14] text-nb-muted"
        }`}
      >
        <option value="">choose…</option>
        {buildings.map((b) => (
          <option key={b.site_id} value={b.site_id}>
            {b.site_name ?? b.site_id}
          </option>
        ))}
      </select>
      <span className={`truncate text-[12px] ${TONE[tone]}`} title={reason}>
        {assignable(device) ? reason : "has no device id — cannot be placed"}
      </span>
      <span className="text-right text-[12px] text-nb-muted" title={device.last_seen_at ?? ""}>
        {quiet ? fmtDay(device.last_seen_at) : device.last_seen_at ? fmtRelative(device.last_seen_at) : "—"}
      </span>
    </div>
  );
}
