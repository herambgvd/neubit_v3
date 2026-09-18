"use client";

// Devices → IoT. The gateway fleet: protocol gateways (conflux), the connections
// inside each, and the points they deliver.
//
// A two-pane master/detail, deliberately the same shape as Recorders next door
// — left is the fleet with a search and online counts, right is one gateway's
// detail. Same MasterDetail / ListPanel / EmptyDetail, same TanStack Query and
// StatusBadge. An operator who knows one screen knows this one.
//
// READ ONLY, and that is the architecture rather than an unfinished phase. The
// gateway server owns the fleet: it mints enrolment tokens, decides pending vs
// approved, and gateways phone home to IT. There is no Add here and no Delete,
// for the same reason the Cameras tab has none — the thing that owns a device
// is where the device is managed.
//
// THE THREE NUMBERS. A point count is not one figure:
//   configured  what the gateway has set up
//   arrived     what has ever reached this platform
//   reporting   what is live inside the freshness window
// Each gap is a different fault — a point that never published at all, and one
// that has stopped — so the detail pane shows all three and never a total.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import StatusBadge, { StatusDot } from "@/features/vms/components/StatusBadge";
// One definition of how a reading renders, shared with the Building
// Intelligence screens. Two would drift, and the same number would read
// differently depending on which screen an operator opened.
import { fmtReading, qualityTone } from "@/features/bi/constants";
import { iot } from "./api";
import {
  ackView,
  ageSec,
  canAcknowledge,
  categoryTabs,
  inCategory,
  devicesFrom,
  filterDevices,
  filterGateways,
  gatewayName,
  gatewayTotals,
  missingPoints,
  openAlerts,
  type DeviceRow,
} from "./selectors";
import type { IotAlert, IotEnrollToken, IotGateway, IotPoint } from "./types";

const CAT_TEXT: Record<string, string> = {
  energy: "text-nb-teal",
  hvac: "text-nb-violet",
  water: "text-nb-blue",
};

function relAge(sec: number | null): string {
  if (sec == null) return "never";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  // "up 0h" on a gateway restarted twenty minutes ago reads as a gateway that
  // is not up. Hours only once there are hours.
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function GatewaysPage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const gwQ = useQuery({
    queryKey: ["iot-gateways"],
    queryFn: () => iot.gateways.list(),
    refetchInterval: 30_000,
  });

  const gateways = useMemo(() => gwQ.data?.gateways ?? [], [gwQ.data]);
  const filtered = useMemo(() => filterGateways(gateways, search), [gateways, search]);

  // The explicit choice, or the first row when there is none. Derived rather
  // than synced by an effect, which renders one frame with nothing selected
  // before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.gatewayId ?? null;
  const selected = useMemo(
    () => gateways.find((g) => g.gatewayId === effectiveId) || null,
    [gateways, effectiveId],
  );

  const onlineCount = gateways.filter((g) => g.status === "online").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[25%_1fr]"
        aside={
          <ListPanel
            title="Gateways"
            icon="heroicons-outline:cpu-chip"
            count={gateways.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name, site or connection…"
            action={
              <button
                onClick={() => gwQ.refetch()}
                title="Refresh"
                aria-label="Refresh gateways"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-nb-line text-nb-soft transition hover:border-nb-teal hover:text-nb-teal"
              >
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            }
          >
            {/* NO create button. Gateways enrol on the gateway server; there is
                nothing this console could add. */}
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[1.2px]">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
                <span className="text-nb-soft">{onlineCount} online</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-nb-crit shadow-[0_0_5px_rgba(248,113,113,.6)]" />
                <span className="text-nb-faint">{gateways.length - onlineCount} offline</span>
              </span>
            </div>

            {gwQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-nb-faint">
                <Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base text-nb-teal" />
                Loading…
              </div>
            ) : gwQ.isError ? (
              // The fleet server being unreachable is a sentence, not a stack
              // trace: the API already says which host it tried.
              <div className="px-4 py-6 text-center text-xs leading-relaxed text-nb-crit">
                {apiError(gwQ.error, "Could not reach the gateway server")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-nb-faint">
                {gateways.length === 0
                  ? "No gateways have enrolled yet. They appear here once they report to the gateway server."
                  : "No matches."}
              </div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((g) => (
                  <GatewayRow
                    key={g.gatewayId}
                    gw={g}
                    selected={effectiveId === g.gatewayId}
                    onSelect={() => setSelectedId(g.gatewayId)}
                  />
                ))}
              </div>
            )}

            <p className="border-t border-nb-line px-4 pb-2 pt-3 text-[11px] leading-relaxed text-nb-faint">
              Gateways enrol on the gateway server. Nothing is onboarded here.
            </p>
            <EnrolmentTokens />
          </ListPanel>
        }
      >
        {selected ? (
          <GatewayDetail key={selected.gatewayId} gw={selected} />
        ) : (
          <EmptyDetail
            icon="heroicons-outline:cpu-chip"
            title="No gateway selected"
            subtitle="Pick a gateway to see its connections, devices and points."
          />
        )}
      </MasterDetail>
    </div>
  );
}

function GatewayRow({
  gw,
  selected,
  onSelect,
}: Readonly<{ gw: IotGateway; selected: boolean; onSelect: () => void }>) {
  const t = gatewayTotals(gw, undefined);
  const online = gw.status === "online";
  return (
    <button
      onClick={onSelect}
      className={`relative block w-full overflow-hidden rounded-[13px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-teal bg-nb-teal/[.08] shadow-[0_0_0_1px_rgba(34,211,238,.4)]"
          : "border-nb-line bg-[rgba(150,180,245,.04)] hover:border-nb-teal/50 hover:bg-nb-teal/[.06]"
      }`}
    >
      {selected && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l-sm bg-nb-teal" />}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              online ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-crit shadow-[0_0_5px_rgba(248,113,113,.6)]"
            }`}
          />
          <p className="truncate font-mono text-xs font-semibold text-nb-ink">{gatewayName(gw)}</p>
        </span>
        <StatusBadge status={gw.status} />
      </div>
      {/* A gateway awaiting approval is reachable and reporting and still
          carries nothing — status alone would show it as healthy. */}
      {gw.state === "pending" && (
        <p className="mt-0.5 flex items-center gap-1 pl-3.5 text-[10px] text-nb-warn">
          <Icon icon="heroicons-outline:key" className="shrink-0 text-[11px]" />
          Waiting for approval on the gateway server
        </p>
      )}
      {gw.site && <p className="mt-0.5 truncate pl-3.5 text-[10px] text-nb-faint">{gw.site}</p>}
      <p className="mt-0.5 pl-3.5 font-mono text-[10px] tabular-nums text-nb-faint">
        {t.inventoryUnknown ? "connections unknown" : `${t.connections} connection(s) · ${t.arrived} point(s)`}
      </p>
    </button>
  );
}

function GatewayDetail({ gw }: Readonly<{ gw: IotGateway }>) {
  const [deviceSearch, setDeviceSearch] = useState("");
  const [openDevice, setOpenDevice] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [category, setCategory] = useState("all");

  const ptsQ = useQuery({
    queryKey: ["iot-gateway-points", gw.gatewayId, showRetired],
    queryFn: () => iot.gateways.points(gw.gatewayId, showRetired),
    staleTime: 20_000,
  });
  const points: IotPoint[] | undefined = ptsQ.data?.points;
  const totals = gatewayTotals(gw, points);
  const devices = useMemo(() => (points ? devicesFrom(points) : []), [points]);
  // Tabs are built from EVERY device, not the filtered set: a count that moved
  // as you typed in the search box would be a different number every keystroke
  // and could never be compared with anything.
  const tabs = useMemo(() => categoryTabs(devices), [devices]);
  const shownDevices = useMemo(
    () => filterDevices(inCategory(devices, category), points || [], deviceSearch),
    [devices, category, points, deviceSearch],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-nb-line bg-[rgba(150,180,245,.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nb-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-nb-teal/40 bg-nb-teal/[.12] text-nb-teal">
            <Icon icon="heroicons-outline:cpu-chip" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-mono text-base font-semibold text-nb-ink">{gatewayName(gw)}</h1>
            <p className="truncate font-mono text-[11px] text-nb-faint">
              {gw.site || "—"} · v{gw.version || "?"} · up {uptime(gw.uptimeSec)}
              {gw.tags?.length ? ` · ${gw.tags.join(", ")}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={gw.status} />
          <span className="rounded-full border border-nb-line px-2 py-0.5 text-[10px] text-nb-soft">{gw.state}</span>
          <GatewayCommands gw={gw} />
        </div>
      </div>

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        {gw.state === "pending" && (
          <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-nb-warn/35 bg-nb-warn/[.08] px-3 py-2.5">
            <Icon icon="heroicons-outline:key" className="mt-0.5 shrink-0 text-sm text-nb-warn" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-nb-warn">This gateway is not approved yet</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-nb-soft">
                It is reporting, but a shared enrolment token admitted it. Approve it on the gateway
                server before trusting what it carries.
              </p>
            </div>
          </div>
        )}

        {/* The three numbers, as three steps. A single "points" figure would
            hide both drops, and each drop is a different fault. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Configured" value={totals.inventoryUnknown ? "unknown" : totals.configured} />
          <InfoCell
            label="Arrived here"
            value={
              <>
                {totals.arrived}
                {totals.configured > totals.arrived && (
                  <span className="ml-1.5 text-[11px] text-nb-warn">
                    −{totals.configured - totals.arrived} never did
                  </span>
                )}
              </>
            }
          />
          <InfoCell
            label="Reporting now"
            value={
              ptsQ.isLoading ? (
                <span className="text-nb-faint">…</span>
              ) : (
                <>
                  <span className={totals.quiet ? "text-nb-warn" : "text-nb-good"}>{totals.reporting}</span>
                  <span className="text-nb-faint"> / {points?.length ?? 0}</span>
                </>
              )
            }
          >
            {!ptsQ.isLoading && totals.quiet > 0 && (
              <p className="mt-0.5 text-[10px] text-nb-warn">{totals.quiet} gone quiet</p>
            )}
          </InfoCell>
          <InfoCell
            label="Published"
            value={gw.stats?.published?.toLocaleString() ?? "—"}
            hint={`${gw.stats?.dropped ?? 0} dropped · outbox ${gw.stats?.outboxDepth ?? 0}`}
          />
        </div>

        <GatewayAlerts gatewayId={gw.gatewayId} />

        {/* Connections */}
        <SectionHead label="Connections" count={totals.inventoryUnknown ? null : totals.connections} />
        {totals.inventoryUnknown ? (
          // null is not an empty list: this gateway runs a build that cannot
          // report its connections, which is a different claim from "it has none".
          <p className="rounded-[10px] border border-dashed border-nb-warn/35 px-3 py-4 text-center text-xs text-nb-warn">
            This gateway does not report its connections. Upgrade it to see what it is carrying.
          </p>
        ) : (gw.connections || []).length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs text-nb-faint">
            This gateway has no connections configured yet. They are created on the gateway itself.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5">
            {(gw.connections || []).map((c) => {
              const missing = missingPoints(c);
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-nb-line bg-[rgba(150,180,245,.04)] px-3 py-2"
                >
                  <StatusDot status={c.arrived?.points ? "online" : "unknown"} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-nb-ink">{c.name}</span>
                  <span className="rounded-full border border-nb-line px-2 py-0.5 text-[10px] text-nb-soft">{c.proto}</span>
                  <span className="font-mono text-[11px] tabular-nums text-nb-faint">
                    {c.arrived?.devices ?? 0}/{c.devices} devices · {c.arrived?.points ?? 0}/{c.points} points
                  </span>
                  {missing > 0 && (
                    <span className="rounded-full border border-nb-warn/35 bg-nb-warn/[.08] px-2 py-0.5 text-[10px] text-nb-warn">
                      {missing} never arrived
                    </span>
                  )}
                  <span className="font-mono text-[11px] tabular-nums text-nb-faint">
                    {c.arrived?.last_seen_at ? fmtRelative(c.arrived.last_seen_at) : "no readings"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {/* Devices, derived from the points we hold — there is no device table
            on this side, only `points.device_tag`. */}
        {/* Category tabs. Energy, HVAC and water answer different questions and
            are read by different people; one list of 38 mixes them. */}
        {tabs.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1 border-b border-nb-line">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setCategory(t.key)}
                aria-current={category === t.key ? "page" : undefined}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] transition ${
                  category === t.key
                    ? "border-nb-teal text-nb-ink"
                    : "border-transparent text-nb-faint hover:text-nb-soft"
                }`}
              >
                {t.label}
                <span className="rounded-full border border-nb-line bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] tabular-nums text-nb-soft">
                  {t.devices}
                </span>
                {/* The warning rides on the tab, so a fault in a category
                    nobody is looking at is still visible from here. */}
                {t.quiet > 0 && <span className="text-[10px] text-nb-warn">{t.quiet} quiet</span>}
              </button>
            ))}
          </div>
        )}

        <div className="mb-2 mt-3 flex flex-wrap items-center gap-2">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">Devices</p>
          <span className="rounded-full border border-nb-line bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
            {devices.length}
          </span>
          <span className="flex-1" />
          <input
            value={deviceSearch}
            onChange={(e) => setDeviceSearch(e.target.value)}
            placeholder="Filter devices or point tags…"
            aria-label="Filter devices"
            className="w-56 rounded-[8px] border border-nb-line bg-nb-field px-2.5 py-1 text-xs text-nb-ink placeholder:text-nb-faint focus:border-nb-teal focus:outline-none"
          />
          <button
            onClick={() => setShowRetired(!showRetired)}
            aria-pressed={showRetired}
            className={`rounded-[8px] border px-2.5 py-1 text-[11px] transition ${
              showRetired
                ? "border-nb-teal/45 bg-nb-teal/[.1] text-nb-teal"
                : "border-nb-line text-nb-soft hover:text-nb-ink"
            }`}
          >
            {showRetired ? "Hiding nothing" : "Show retired"}
          </button>
        </div>
        {/* Says WHY something is missing, in the operator's own units. "Some
            points are hidden" is the kind of sentence that sends somebody
            looking for a bug. */}
        <p className="mb-2 text-[11px] leading-relaxed text-nb-faint">
          Points that were retired, or that have been silent for more than{" "}
          {ptsQ.data?.retire_after_days ?? 30} days, are left out of this list and out of every
          count above. Values are read raw over the last{" "}
          {ptsQ.data?.value_lookback_minutes ?? 60} minutes — a dash means nothing arrived in that
          window, not zero.
        </p>

        {ptsQ.isLoading ? (
          <p className="px-1 py-3 text-xs text-nb-faint">
            <Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-nb-teal" />
            Loading points…
          </p>
        ) : ptsQ.isError ? (
          <p className="px-1 py-3 text-xs text-nb-crit">{apiError(ptsQ.error, "Could not load points")}</p>
        ) : devices.length === 0 ? (
          // The sync stamps `points.gateway_id`; until it has run this gateway's
          // points are here but not yet attributed to it. Saying so beats an
          // empty table that looks like an estate with nothing in it.
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs leading-relaxed text-nb-faint">
            No points are attributed to this gateway yet. They are matched to it when the fleet sync
            next runs.
          </p>
        ) : shownDevices.length === 0 ? (
          <p className="px-1 py-3 text-xs text-nb-faint">
            {deviceSearch
              ? `No device or point tag matches “${deviceSearch}”${category === "all" ? "" : ` under ${category}`}.`
              : `No devices under ${category}.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shownDevices.map((d) => (
              <DeviceItem
                key={d.tag}
                dev={d}
                points={points || []}
                gatewayId={gw.gatewayId}
                open={openDevice === d.tag}
                onToggle={() => setOpenDevice(openDevice === d.tag ? null : d.tag)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DeviceItem({
  dev,
  points,
  gatewayId,
  open,
  onToggle,
}: Readonly<{
  dev: DeviceRow;
  points: IotPoint[];
  gatewayId: string;
  open: boolean;
  onToggle: () => void;
}>) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const mine = useMemo(
    () => points.filter((p) => (p.device_tag || "(no device)") === dev.tag),
    [points, dev.tag],
  );
  const live = dev.points - dev.quiet;
  // A device is "retired" when every one of its points is. There is no device
  // row on this side — a device IS its points — so retiring one means retiring
  // each of them, and a half-retired device is a real state rather than an error.
  const retiredCount = mine.filter((p) => p.retired_at).length;
  const allRetired = mine.length > 0 && retiredCount === mine.length;

  const remove = useMutation({
    mutationFn: async () => {
      let readings = 0;
      // Sequential and point by point: a failure half way leaves the rest of
      // the device intact and visible, rather than a device in an unknown
      // state across two systems.
      for (const p of mine) {
        const r = await iot.points.remove(p.point_id);
        readings += r?.readings_deleted ?? 0;
      }
      return readings;
    },
    onSuccess: (readings) => {
      toast.success(`${dev.tag} deleted — ${readings.toLocaleString()} readings removed`);
      qc.invalidateQueries({ queryKey: ["iot-gateway-points", gatewayId] });
      qc.invalidateQueries({ queryKey: ["iot-gateways"] });
    },
    onError: (e) => toast.error(apiError(e, "Could not delete that device")),
  });

  const retire = useMutation({
    mutationFn: async (retired: boolean) => {
      // Sequential, not Promise.all: this is a handful of rows and a failure
      // half way through should leave the rest untouched and visible rather
      // than scattering partial writes across the estate.
      for (const p of mine) await iot.points.retire(p.point_id, retired);
    },
    onSuccess: (_d, retired) => {
      toast.success(
        retired
          ? `${dev.tag} retired — it stays on the gateway and stops counting here`
          : `${dev.tag} restored`,
      );
      qc.invalidateQueries({ queryKey: ["iot-gateway-points", gatewayId] });
    },
    onError: (e) => toast.error(apiError(e, "Could not retire that device")),
  });
  return (
    <li className="overflow-hidden rounded-[10px] border border-nb-line bg-[rgba(150,180,245,.04)]">
      <div className="flex items-center gap-2 pr-3">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left transition hover:bg-white/5"
      >
        <Icon
          icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
          className="shrink-0 text-xs text-nb-faint"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-nb-ink">{dev.tag}</span>
        <span className={`text-[11px] ${CAT_TEXT[dev.category || ""] || "text-nb-faint"}`}>
          {dev.category || "unclassified"}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-nb-faint">{dev.type || "—"}</span>
        <span className="font-mono text-[11px] tabular-nums">
          <span className={dev.quiet ? "text-nb-warn" : "text-nb-ink"}>{live}</span>
          <span className="text-nb-faint"> / {dev.points}</span>
        </span>
        <span
          className={`w-20 text-right font-mono text-[11px] tabular-nums ${
            dev.newestSec != null && dev.newestSec > 900 ? "text-nb-warn" : "text-nb-faint"
          }`}
        >
          {relAge(dev.newestSec)}
        </span>
      </button>
      {can("bi.manage") && (
        <div className="flex shrink-0 items-center gap-2">
          {allRetired ? (
            <>
              <span className="hidden text-[11px] text-nb-faint sm:inline">retired</span>
              <button
                onClick={() => retire.mutate(false)}
                disabled={retire.isPending}
                className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-soft transition hover:border-nb-teal hover:text-nb-teal disabled:opacity-50"
              >
                Restore
              </button>
            </>
          ) : (
            <>
              {retiredCount > 0 && (
                <span className="hidden text-[11px] text-nb-faint sm:inline">
                  {retiredCount}/{mine.length} retired
                </span>
              )}
              <button
                onClick={() =>
                  setConfirm({
                    // The danger flag, the word "permanently", the reading
                    // count and the alternative are all in here on purpose:
                    // this is the only action on the screen that cannot be
                    // undone, and the one an operator is most likely to reach
                    // for when they actually wanted Retire.
                    title: `Delete ${dev.tag}`,
                    message:
                      `Permanently delete this device's ${mine.length} point(s) from the gateway ` +
                      `AND every reading they ever produced from this platform. This cannot be undone.` +
                      (live > 0
                        ? ` ${live} of its points are still reporting — if the connection has ` +
                          `auto-watch on, deleting will remove the history and the point will come ` +
                          `straight back as a new, empty one.`
                        : ``) +
                      ` If this device is only offline, Retire instead — that keeps everything.`,
                    confirmLabel: "Delete permanently",
                    danger: true,
                    onConfirm: () => { remove.mutate(); setConfirm(null); },
                  })
                }
                disabled={remove.isPending || retire.isPending || mine.length === 0}
                className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-faint transition hover:border-nb-crit hover:text-nb-crit disabled:opacity-50"
              >
                Delete
              </button>
              <button
                onClick={() =>
                  setConfirm({
                    title: `Retire ${dev.tag}`,
                    message:
                      `Stop counting this device's ${mine.length} point(s) here. Nothing is deleted: ` +
                      `it stays configured on the gateway and every reading it produced is kept. ` +
                      `If it starts reporting again it comes back on its own.`,
                    confirmLabel: "Retire",
                    onConfirm: () => { retire.mutate(true); setConfirm(null); },
                  })
                }
                disabled={retire.isPending || remove.isPending || mine.length === 0}
                className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-faint transition hover:border-nb-warn hover:text-nb-warn disabled:opacity-50"
              >
                Retire
              </button>
            </>
          )}
          <ConfirmDialog
            state={confirm}
            onClose={() => setConfirm(null)}
            pending={retire.isPending || remove.isPending}
          />
        </div>
      )}
      </div>
      {open && (
        <div className="border-t border-nb-line px-3 py-2">
          {allRetired && (
            <p className="mb-2 text-[11px] text-nb-faint">
              Retired — not counted here. It is still configured on the gateway, and it comes back
              on its own if it starts reporting again.
            </p>
          )}
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {mine.map((p) => {
              const age = ageSec(p.last_seen_at);
              const quiet = age == null || age > 900;
              return (
                <li key={p.point_id} className="flex items-center gap-2 text-[12px]">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      p.retired_at ? "bg-nb-faint" : quiet ? "bg-nb-warn" : "bg-nb-good"
                    }`}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate ${p.retired_at ? "text-nb-faint line-through" : "text-nb-soft"}`}
                    title={p.point_tag || ""}
                  >
                    {p.point_tag || "—"}
                  </span>
                  {/* THE VALUE. A dash here means "no reading inside the
                      server's lookback", never zero — the server returns no
                      value at all rather than an hours-old number dressed as
                      live. Colour comes from the envelope's quality flag: the
                      device saying a sample is suspect is not something to
                      hide behind a tidy number. */}
                  <span
                    className={`w-24 shrink-0 text-right font-mono text-[12px] tabular-nums ${
                      p.latest ? qualityTone(p.latest.quality) || "text-nb-ink" : "text-nb-faint"
                    }`}
                    title={
                      p.latest && p.latest.quality !== 0
                        ? `the device reported quality ${p.latest.quality} for this sample`
                        : undefined
                    }
                  >
                    {fmtReading(p.latest)}
                  </span>
                  {/* Unit is NULL on every point of this estate and is shown as
                      a dash rather than inferred from a tag like KWH_kwh. */}
                  <span className="w-10 shrink-0 text-right text-[11px] text-nb-faint">{p.unit || ""}</span>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-nb-faint">
                    {relAge(age)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

// The credentials a gateway enrols WITH.
//
// This is the one place the console holds something secret, and only for as
// long as a mint's reply is on screen: the gateway server stores a bcrypt hash
// and returns the plaintext exactly once, so there is no "show it again" to
// build. The reply is rendered, copied, and gone on the next render.
//
// Revoked tokens stay listed. Which token admitted which gateway has to remain
// traceable, so revoking marks the row rather than removing it, and a list that
// hid them would lose the trail that makes a revoke investigable.
function EnrolmentTokens() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<string | null>(null);

  const tokensQ = useQuery({
    queryKey: ["iot-enrol-tokens"],
    queryFn: () => iot.tokens.list(),
    enabled: open,
    staleTime: 30_000,
  });

  const mint = useMutation({
    mutationFn: () => iot.tokens.mint(name.trim()),
    onSuccess: (t) => {
      // Held in local state ONLY, and never written anywhere that survives a
      // reload: this is the only copy of the credential that will ever exist.
      setMinted(t.secret || null);
      setName("");
      if (!t.secret) toast.error("The gateway server minted a token but returned no credential");
      qc.invalidateQueries({ queryKey: ["iot-enrol-tokens"] });
    },
    onError: (e) => toast.error(apiError(e, "Could not mint a token")),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => iot.tokens.revoke(id),
    onSuccess: () => {
      toast.success("Token revoked — gateways it already admitted keep running");
      qc.invalidateQueries({ queryKey: ["iot-enrol-tokens"] });
    },
    onError: (e) => toast.error(apiError(e, "Could not revoke that token")),
  });

  if (!can("iot.manage")) return null;
  const tokens: IotEnrollToken[] = tokensQ.data ?? [];

  return (
    <div className="border-t border-nb-line px-4 py-3">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint transition hover:text-nb-soft"
      >
        <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="text-[11px]" />
        Enrolment tokens
      </button>

      {open && (
        <div className="mt-2.5">
          {minted && (
            // Shown once. The wording says so, because an operator who assumes
            // they can come back for it has lost the credential.
            <div className="mb-2.5 rounded-[10px] border border-nb-warn/40 bg-nb-warn/[.08] p-2.5">
              <p className="text-[11px] font-medium text-nb-warn">Copy this now — it is shown once</p>
              <code className="mt-1 block break-all rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-nb-ink">
                {minted}
              </code>
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(minted).then(
                      () => toast.success("Copied"),
                      () => toast.error("Could not copy — select it and copy by hand"),
                    );
                  }}
                  className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-soft transition hover:border-nb-teal hover:text-nb-teal"
                >
                  Copy
                </button>
                <button
                  onClick={() => setMinted(null)}
                  className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-faint transition hover:text-nb-ink"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this token…"
              aria-label="New enrolment token name"
              className="min-w-0 flex-1 rounded-[8px] border border-nb-line bg-nb-field px-2 py-1 text-[11.5px] text-nb-ink placeholder:text-nb-faint focus:border-nb-teal focus:outline-none"
            />
            <button
              onClick={() => mint.mutate()}
              disabled={!name.trim() || mint.isPending}
              className="shrink-0 rounded-[8px] border border-nb-teal/45 bg-nb-teal/[.12] px-2.5 py-1 text-[11px] text-nb-teal transition disabled:opacity-40"
            >
              Mint
            </button>
          </div>

          {tokensQ.isLoading ? (
            <p className="mt-2 text-[11px] text-nb-faint">Loading…</p>
          ) : tokensQ.isError ? (
            <p className="mt-2 text-[11px] text-nb-crit">{apiError(tokensQ.error, "Could not list tokens")}</p>
          ) : tokens.length === 0 ? (
            <p className="mt-2 text-[11px] text-nb-faint">No tokens issued yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-[11.5px]">
                  <span className={`min-w-0 flex-1 truncate ${t.revoked ? "text-nb-faint line-through" : "text-nb-soft"}`}>
                    {t.name}
                  </span>
                  {/* lastUsed 0 means it has never admitted anything — a token
                      issued and forgotten, which is worth seeing before it is
                      worth revoking. */}
                  <span className="shrink-0 text-[10px] text-nb-faint">
                    {t.revoked ? "revoked" : t.lastUsed ? "in use" : "unused"}
                  </span>
                  {!t.revoked && (
                    <button
                      onClick={() => revoke.mutate(t.id)}
                      disabled={revoke.isPending}
                      className="shrink-0 rounded-[6px] border border-nb-line px-1.5 py-0.5 text-[10px] text-nb-faint transition hover:border-nb-crit hover:text-nb-crit disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Approve / revoke, which take effect ON THE GATEWAY SERVER.
//
// Neither is offered for the SERVING instance. conflux synthesises its own
// entry live and refuses both outright — "this instance is not an enrolled
// gateway — approve, revoke and remove do not apply to it" — so a button here
// would be one that can only ever produce an error. The reason is shown
// instead, because "why is there no button" is the next question.
//
// Decommissioning is deliberately absent. It is the one action with nothing to
// undo it, and it belongs where somebody is looking at the gateway server.
function GatewayCommands({ gw }: Readonly<{ gw: IotGateway }>) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["iot-gateways"] });

  const approve = useMutation({
    mutationFn: () => iot.approve(gw.gatewayId),
    onSuccess: () => { toast.success("Approved on the gateway server"); refresh(); },
    onError: (e) => toast.error(apiError(e, "The gateway server refused that")),
  });
  const revoke = useMutation({
    mutationFn: () => iot.revoke(gw.gatewayId),
    onSuccess: () => { toast.success("Revoked — its heartbeats are no longer accepted"); refresh(); },
    onError: (e) => toast.error(apiError(e, "The gateway server refused that")),
  });

  if (!can("iot.manage")) return null;
  if (gw.isSelf) {
    return (
      <span className="text-[11px] text-nb-faint" title="conflux serves its own entry and refuses these">
        this is the gateway server itself
      </span>
    );
  }

  const busy = approve.isPending || revoke.isPending;
  return (
    <>
      {gw.state !== "approved" && (
        <button
          onClick={() => approve.mutate()}
          disabled={busy}
          className="rounded-[8px] border border-nb-good/40 bg-nb-good/[.1] px-2.5 py-1 text-[11px] text-nb-good transition hover:border-nb-good disabled:opacity-50"
        >
          Approve
        </button>
      )}
      {gw.state !== "revoked" && (
        <button
          onClick={() =>
            setConfirm({
              title: "Revoke gateway",
              message:
                `Stop accepting heartbeats from ${gatewayName(gw)}? Nothing is deleted — its readings, ` +
                `points and record all stay — and approving it again restores it.`,
              confirmLabel: "Revoke",
              danger: true,
              onConfirm: () => { revoke.mutate(); setConfirm(null); },
            })
          }
          disabled={busy}
          className="rounded-[8px] border border-nb-line px-2.5 py-1 text-[11px] text-nb-crit transition hover:border-nb-crit disabled:opacity-50"
        >
          Revoke
        </button>
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={busy} />
    </>
  );
}

// The faults this gateway delivered — the consumer `iot_alerts.gateway_id` was
// put on the wire for.
//
// `ack_state` has THREE values and the third is the interesting one: null means
// the alert predates the acknowledgement wire, so nobody ever said whether it
// was dealt with. Rendering that as "open" would invent a fact, so it renders
// as unknown and offers no Acknowledge button — there is nothing here that
// could honestly be closed.
function GatewayAlerts({ gatewayId }: Readonly<{ gatewayId: string }>) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canAck = can("iot.manage");

  const alertsQ = useQuery({
    queryKey: ["iot-gateway-alerts", gatewayId],
    queryFn: () => iot.gateways.alerts(gatewayId),
    staleTime: 20_000,
  });

  // The alert whose acknowledgement is in flight. The command is accepted by
  // the gateway, which then republishes the alert over NATS, and our row only
  // changes when the projector has written that message — a second or two
  // later. Refetching the instant the command returns therefore reads the OLD
  // state and sticks there, which is what this state stops: the row says
  // "applying…" until the gateway's own answer arrives.
  const [pending, setPending] = useState<string | null>(null);

  const ack = useMutation({
    mutationFn: ({ id, acked }: { id: string; acked: boolean }) => iot.alerts.ack(id, acked),
    onMutate: ({ id }) => setPending(id),
    onSuccess: (_d, v) => {
      toast.success(v.acked ? "Acknowledged on the gateway" : "Reopened on the gateway");
      // Deliberately NOT an optimistic row update: that would show a state this
      // platform invented, and the case it gets wrong — the gateway accepted
      // the command and the message never arrived — is the one worth seeing.
      // Poll instead, briefly and with a bound, for the gateway's own answer.
      void waitForChange(v.id, v.acked);
    },
    onError: (e) => {
      setPending(null);
      toast.error(apiError(e, "The gateway did not accept that"));
    },
  });

  // Refetch until the row reflects the command, or until the budget runs out.
  // Giving up leaves the row showing what the platform actually holds rather
  // than what was asked for — a command that was accepted and then lost on the
  // bus must not look like it worked.
  async function waitForChange(id: string, acked: boolean) {
    const want = acked ? "acked" : "open";
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const fresh = await qc.fetchQuery({
        queryKey: ["iot-gateway-alerts", gatewayId],
        queryFn: () => iot.gateways.alerts(gatewayId),
        staleTime: 0,
      });
      if (fresh.alerts.find((a) => a.alert_id === id)?.ack_state === want) break;
    }
    setPending(null);
  }

  const alerts: IotAlert[] = alertsQ.data?.alerts ?? [];
  // "unknown" is deliberately NOT counted here: an alert whose gateway never
  // reported an acknowledgement is not known to be outstanding, and saying it
  // is would claim work nobody can name.
  const open = openAlerts(alerts).length;

  return (
    <>
      <div className="mb-2 mt-4 flex flex-wrap items-center gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">Faults</p>
        <span className="rounded-full border border-nb-line bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
          {alerts.length}
        </span>
        {open > 0 && <span className="text-[11px] text-nb-warn">{open} not acknowledged</span>}
      </div>

      {alertsQ.isLoading ? (
        <p className="px-1 py-3 text-xs text-nb-faint">
          <Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-nb-teal" />
          Loading faults…
        </p>
      ) : alertsQ.isError ? (
        <p className="px-1 py-3 text-xs text-nb-crit">{apiError(alertsQ.error, "Could not load faults")}</p>
      ) : alerts.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs text-nb-faint">
          This gateway has raised no faults that reached the platform.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {alerts.slice(0, 12).map((a) => {
            const view = ackView(a);
            const acked = view === "acknowledged";
            const unknown = view === "unknown";
            return (
              <li
                key={a.alert_id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-nb-line bg-[rgba(150,180,245,.04)] px-3 py-2"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    a.severity === "critical" ? "bg-nb-crit" : "bg-nb-warn"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-nb-ink" title={a.message || ""}>
                  <span className="font-medium">{a.device_tag || "—"}</span>
                  <span className="text-nb-soft"> — {a.message || "—"}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-nb-faint">{fmtRelative(a.ts)}</span>
                {pending === a.alert_id ? (
                  // The gateway has the command; its answer has not come back
                  // over the bus yet. Showing the old badge here would
                  // contradict the toast that just said it worked.
                  <span className="rounded-full border border-nb-line px-2 py-0.5 text-[10px] text-nb-soft">
                    applying…
                  </span>
                ) : acked ? (
                  <span
                    className="rounded-full border border-nb-good/35 bg-nb-good/[.08] px-2 py-0.5 text-[10px] text-nb-good"
                    title={a.acked_at ? `Acknowledged ${fmtRelative(a.acked_at)}` : undefined}
                  >
                    acknowledged
                  </span>
                ) : unknown ? (
                  // Not "open": nobody ever said. The gateway that raised this
                  // one could not report an acknowledgement at all.
                  <span className="rounded-full border border-nb-line px-2 py-0.5 text-[10px] text-nb-faint">
                    state unknown
                  </span>
                ) : (
                  <span className="rounded-full border border-nb-warn/35 bg-nb-warn/[.08] px-2 py-0.5 text-[10px] text-nb-warn">
                    {view}
                  </span>
                )}
                {canAck && canAcknowledge(a) && (
                  <button
                    onClick={() => ack.mutate({ id: a.alert_id, acked: !acked })}
                    disabled={pending !== null}
                    className="rounded-[7px] border border-nb-line px-2 py-0.5 text-[11px] text-nb-soft transition hover:border-nb-teal hover:text-nb-teal disabled:opacity-50"
                  >
                    {acked ? "Reopen" : "Acknowledge"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {alerts.length > 12 && (
        <p className="mt-2 text-[11px] text-nb-faint">showing 12 of {alerts.length}</p>
      )}
    </>
  );
}

function SectionHead({ label, count }: Readonly<{ label: string; count: number | null }>) {
  return (
    <div className="mb-2 mt-4 flex items-center justify-between">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">{label}</p>
      {count != null && (
        <span className="rounded-full border border-nb-line bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
          {count}
        </span>
      )}
    </div>
  );
}

function InfoCell({
  label,
  value,
  hint,
  children,
}: Readonly<{ label: string; value: React.ReactNode; hint?: string; children?: React.ReactNode }>) {
  return (
    <div className="min-w-0 rounded-[10px] border border-nb-line bg-[rgba(150,180,245,.04)] px-3 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[1.4px] text-nb-faint">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-medium tabular-nums text-nb-ink">{value ?? "—"}</p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-nb-faint">{hint}</p>}
      {children}
    </div>
  );
}
