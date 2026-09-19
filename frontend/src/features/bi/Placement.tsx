"use client";

// Building Intelligence → UNPLACED DEVICES. Gate 3: the point BELONGS to a place.
//
// Most of this estate's points belong to no building, and until the backend
// could say "this device is in Aeon Tower" without an {x, y}, the only way to
// place one was to pin it on a drawn floor plan — and there are almost no
// floor plans. This is the device-first half of that one fact: tick devices,
// name the building, optionally a floor, confirm. The write is core's
// `POST /device-placements/assign`, into the same table the floor plan writes.
//
// NOTHING IS ASSIGNED FOR ANYONE. No row is pre-ticked, there is no "tick every
// unplaced device" and no default building — with exactly one site on this
// deployment, "put them all there" is precisely the guess a device's building
// must never be. The confirmation lists every device being asserted before the
// button that sends it.
//
// TWO LISTS, BECAUSE A MOVE IS THE SAME WRITE. "No building" is gate 3's work
// (`placement=unplaced`). "In a building" is where a device already placed is
// moved — and a move is the only way a pin gets dropped, which is why the
// outcome says so per device.
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import {
  ActionButton,
  ConsolePage,
  ConsolePanel,
  EstateHeader,
  PanelFooter,
  PanelHeader,
  PanelList,
  PanelSearch,
  QuietButton,
  Segmented,
} from "@/components/console";
import { checkboxClass } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { BiDeviceListResponse, BiDeviceRow } from "@/lib/types";

import AssignDevices from "./components/AssignDevices";
import { bi } from "./api";
import { assignable } from "./assign";
import { categoryMeta, MODULE, PERM_ASSIGN, PERM_READ, PERM_SITES_READ } from "./constants";

type View = "unplaced" | "placed";

/** The server's cap on one `/bi/devices` page. A list that stops here says so. */
const PAGE = 500;

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
  // The write is core's, under core's key; choosing a building needs the list
  // of them. Without both there is no control here at all, only the list.
  const mayAssign = mayRead && can(PERM_ASSIGN) && can(PERM_SITES_READ);
  // A domain strip sends its own scope: `?category=energy`.
  const category = useSearchParams().get("category") || undefined;

  const [view, setView] = useState<View>("unplaced");
  const [search, setSearch] = useState("");
  // Ticked devices, by id, holding the ROW so the confirmation can name each
  // one even after a search has hidden it. Empty until a person ticks.
  const [picked, setPicked] = useState<Record<string, BiDeviceRow>>({});
  const [confirming, setConfirming] = useState(false);

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
  const q = view === "unplaced" ? unplacedQ : placedQ;
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((d) =>
      `${d.device_tag ?? ""} ${d.category ?? ""} ${d.device_type ?? ""} ${d.site_name ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [rows, search]);

  const pickedRows = Object.values(picked);

  function toggle(d: BiDeviceRow) {
    if (!d.device_id) return;
    const id = d.device_id;
    setPicked((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = d;
      return next;
    });
  }

  // A count that has not answered is a dash, never a zero.
  const count = (x: typeof unplacedQ) => (x.data ? x.data.total : "—");
  const scope = category ? categoryMeta(category).label : null;

  if (!mayRead) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Unplaced devices" }]} />
        <p className="text-[11.5px] text-nb-faint">
          Reading this list needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <EstateHeader
        crumbs={[{ label: "Unplaced devices" }]}
        desc={
          <span title="A device belongs to a building because an operator said so. Tick the devices, name the building, optionally a floor. No pin is needed — pin later on the floor plan if you want one. Nothing is assigned automatically and there is no default building.">
            {scope ? `${scope} · ` : ""}tick, name the building, confirm · no pin needed
          </span>
        }
      />

      <ConsolePanel className="flex-1">
        <PanelHeader icon="heroicons:map-pin" title="Devices" count={count(q)} />
        {/* The counts ARE the filter. */}
        <div className="px-3 pb-2">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: "unplaced", label: `NO BUILDING ${count(unplacedQ)}` },
              { value: "placed", label: `IN A BUILDING ${count(placedQ)}` },
            ]}
          />
        </div>
        <PanelSearch value={search} onChange={setSearch} placeholder="Search device, category or building…" />
        <PanelList
          loading={q.isLoading}
          error={q.error ? apiError(q.error, "Could not load the devices") : null}
          empty={!shown.length}
          emptyText={
            rows.length
              ? "No device matches this search."
              : view === "unplaced"
                ? "Every device that has reported belongs to a building."
                : "No device is in a building yet."
          }
        >
          {shown.map((d) => {
            const ok = assignable(d);
            const on = !!(d.device_id && picked[d.device_id]);
            return (
              <label
                key={d.device_id ?? `tag:${d.device_tag}`}
                title={ok ? undefined : "This device has no id in the reading store, so it cannot be placed."}
                className={`flex items-center gap-3 rounded-[10px] border px-3 py-2 text-[12px] transition ${
                  on
                    ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
                    : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
                } ${ok ? "cursor-pointer" : "opacity-60"}`}
              >
                {mayAssign && (
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={on}
                    disabled={!ok}
                    onChange={() => toggle(d)}
                    aria-label={d.device_tag ?? d.device_id ?? "device"}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-nb-ink">{d.device_tag ?? "—"}</span>
                <span className="w-28 truncate text-[11px] text-nb-faint">{d.category ?? "unclassified"}</span>
                <span className="w-20 text-right font-mono text-[11px] tabular-nums text-nb-soft">
                  {d.points} pts
                </span>
                {view === "placed" && (
                  <span className="w-40 truncate text-[11px] text-nb-soft">{d.site_name || "—"}</span>
                )}
                <span className="w-24 text-right text-[11px] text-nb-faint">
                  {d.last_seen_at ? fmtRelative(d.last_seen_at) : "never"}
                </span>
              </label>
            );
          })}
          {q.data && q.data.total > rows.length && (
            <p className="px-1 text-[10.5px] text-nb-faint">
              First {rows.length} of {q.data.total} — search to narrow.
            </p>
          )}
        </PanelList>
        <PanelFooter>
          {mayAssign ? (
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton onClick={() => setConfirming(true)} disabled={!pickedRows.length}>
                {pickedRows.length ? `Assign ${pickedRows.length} to a building…` : "Tick devices to assign"}
              </ActionButton>
              {pickedRows.length > 0 && <QuietButton onClick={() => setPicked({})}>Clear</QuietButton>}
            </div>
          ) : (
            <p
              className="text-[10.5px] text-nb-faint"
              title="Assigning a device to a building is core's write, gated on devices.create; choosing the building needs sites.read."
            >
              Read only — assigning needs <span className="font-mono">devices.create</span>.
            </p>
          )}
        </PanelFooter>
      </ConsolePanel>

      {mayAssign && (
        <AssignDevices
          open={confirming}
          devices={pickedRows}
          onClose={() => setConfirming(false)}
          onDone={() => setPicked({})}
        />
      )}
    </ConsolePage>
  );
}
