"use client";

// Building Intelligence → PLACEMENT. Where the estate IS, and the screen that
// says so.
//
// `points.site_id / floor_id / zone_id` have existed since migration 0008 and
// nothing could write them: no API, no screen, no field on the gateway wire. 314
// points, 0 placed. This is what fills them, and the shape of it is the whole
// decision:
//
//   • The unit of work is a DEVICE, not a point. A placement is a fact about a
//     box — every one of `4F_Solar_Panel01`'s 21 points is in the same room — so
//     this estate is 29 decisions instead of 314. A point-level override exists
//     for the sub-meter that genuinely is not where its panel is, and the API
//     serves it; this screen deliberately does not lead with it.
//   • The names come from CORE, never from here. This client posts ids only; the
//     server resolves each one against `/sites` / `/floors` / `/zones` and copies
//     the label from core's answer. A name typed into a browser is a label
//     nothing checked, and `/bi/summary` would print it as fact.
//   • UNPLACED is a state, never a bucket. It is the default view, it is counted
//     in the header, and no device is ever defaulted to "the first floor".
//
// THE TAG-PREFIX GROUPS ARE A SELECTION AID AND NOTHING ELSE.
// The gateway's tags follow a convention an operator obviously reads as a floor
// (`B1_`, `4F-3F`, `1F York Chiller01`), and grouping by it turns "place 29
// devices" into "place six groups". But a convention is not data: `4F-3F AC DB`
// names two floors and `4F-5F Light DB` names two more. So the prefix groups the
// LIST and pre-selects a SELECTION; the floor is still the operator's to pick,
// and nothing anywhere maps `4F` to a floor id. Contract §4 — quietly turning a
// naming convention into a stored fact is the fabrication this platform forbids,
// and it is the kind that looks right for four floors in five.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  ConsolePage,
  ConsoleGrid,
  PANEL_CLS,
  PanelHeader,
  PanelSearch,
  PanelList,
  PanelFooter,
  PanelStat,
  SectionCard,
  SectionHead,
  Segmented,
  ActionButton,
  QuietButton,
  LoadingBlock,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { asItems, fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";

import { bi } from "./api";
import { PERM_MANAGE, PERM_READ } from "./constants";

const VIEWS = [
  { value: "unplaced", label: "Unplaced" },
  { value: "placed", label: "Placed" },
  { value: "all", label: "All" },
];

/** A device row's location as one line, or the honest absence of one. */
function whereLabel(d: any) {
  if (!d.placed) return null;
  return [d.site_name, d.floor_name, d.zone_name].filter(Boolean).join(" · ");
}

export default function Placement() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canManage = can(PERM_MANAGE);

  const [view, setView] = useState("unplaced");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [siteId, setSiteId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [zoneId, setZoneId] = useState("");

  const devicesQ = useQuery<any>({
    queryKey: ["bi-placement", view, search],
    queryFn: () => bi.placement.devices({ placed: view, search, limit: 500 }),
    enabled: can(PERM_READ),
    refetchInterval: 60_000,
  });

  // The building tree comes from CORE — it is the only authority on what a site
  // or a floor IS. Cascading and server-filtered, the same shape the VMS
  // placement picker uses (the floors/zones list endpoints cap at 100).
  const sitesQ = useQuery<any>({
    queryKey: ["placement-sites"],
    queryFn: () => sitesApi.list({ limit: 200 }),
    staleTime: 60_000,
  });
  const floorsQ = useQuery<any>({
    queryKey: ["placement-floors", siteId],
    queryFn: () => sitesApi.floors.list({ site_id: siteId, limit: 100 }),
    enabled: !!siteId,
    staleTime: 60_000,
  });
  const zonesQ = useQuery<any>({
    queryKey: ["placement-zones", floorId],
    queryFn: () => sitesApi.zones.list({ floor_id: floorId, limit: 100 }),
    enabled: !!floorId,
    staleTime: 60_000,
  });

  const siteRows = asItems(sitesQ.data);
  const floorRows = siteId ? asItems(floorsQ.data) : [];
  const zoneRows = floorId ? asItems(zonesQ.data) : [];

  const rows: any[] = devicesQ.data?.items ?? [];
  const overview = devicesQ.data?.overview;

  // Group by the gateway's tag prefix. A GROUPING, not a mapping — see the file
  // header. `null` (a tag with no separator, e.g. `gateway`) gets its own group
  // rather than being folded into another one.
  const groups = useMemo(() => {
    const by = new Map<string, any[]>();
    for (const r of rows) {
      const key = r.tag_prefix || "—";
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(r);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((k) => selected[k]),
    [selected],
  );
  const selectedPoints = useMemo(
    () =>
      rows
        .filter((r) => selected[r.device_id])
        .reduce((n, r) => n + (r.points || 0), 0),
    [rows, selected],
  );

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }
  function toggleGroup(members: any[]) {
    const allOn = members.every((m) => selected[m.device_id]);
    setSelected((s) => {
      const next = { ...s };
      for (const m of members) next[m.device_id] = !allOn;
      return next;
    });
  }

  function done(msg: string) {
    toast.success(msg);
    setSelected({});
    qc.invalidateQueries({ queryKey: ["bi-placement"] });
    // The Portfolio's placement counts and Floor-wise panel read the same rows.
    qc.invalidateQueries({ queryKey: ["bi-summary"] });
  }

  const placeM = useMutation({
    mutationFn: () =>
      bi.placement.place({
        device_ids: selectedIds,
        site_id: siteId,
        floor_id: floorId || undefined,
        zone_id: zoneId || undefined,
      }),
    onSuccess: (r: any) => {
      // The server names any device id it has never seen rather than reporting
      // success for it. Say so — a typo must not look like a placement.
      if (r.unknown_device_ids?.length) {
        toast.warning(
          `${r.unknown_device_ids.length} device id(s) are not in the reading store and were not placed`,
        );
      }
      done(
        `Placed ${r.devices_placed} device${r.devices_placed === 1 ? "" : "s"} · ${r.points_updated} point${r.points_updated === 1 ? "" : "s"} followed`,
      );
    },
    onError: (e) => toast.error(apiError(e, "Could not place these devices")),
  });

  const unplaceM = useMutation({
    mutationFn: () => bi.placement.unplace({ device_ids: selectedIds }),
    onSuccess: (r: any) =>
      done(
        `Unplaced ${r.devices_unplaced} device${r.devices_unplaced === 1 ? "" : "s"} · ${r.points_updated} point${r.points_updated === 1 ? "" : "s"} are unplaced again`,
      ),
    onError: (e) => toast.error(apiError(e, "Could not unplace these devices")),
  });

  const busy = placeM.isPending || unplaceM.isPending;
  const canSubmit = canManage && selectedIds.length > 0 && !!siteId && !busy;

  if (!can(PERM_READ)) {
    return (
      <ConsolePage>
        <SectionCard className="m-4">
          <SectionHead
            icon="heroicons:lock-closed"
            title="Placement"
            desc="This screen needs the bi.read permission."
          />
        </SectionCard>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-[.4px] text-nb-ink">
            Placement
          </h1>
          <p className="mt-0.5 text-[11.5px] text-nb-faint">
            Anchor a reporting device in a site, floor or zone. Its points follow —
            including the ones that have not reported yet.
          </p>
        </div>
        <Segmented value={view} onChange={setView} options={VIEWS} />
      </div>

      <ConsoleGrid cols="lg:grid-cols-[1fr_340px]">
        {/* ── the worklist ─────────────────────────────────────────────── */}
        <div className={PANEL_CLS}>
          <PanelHeader
            icon="heroicons:cpu-chip"
            title="Devices"
            count={devicesQ.data?.total ?? 0}
            actions={
              selectedIds.length ? (
                <QuietButton onClick={() => setSelected({})}>
                  Clear {selectedIds.length}
                </QuietButton>
              ) : null
            }
          />
          <PanelSearch
            value={search}
            onChange={setSearch}
            placeholder="Search device tag…"
          />
          <PanelList
            loading={devicesQ.isLoading}
            error={devicesQ.error ? apiError(devicesQ.error, "Could not load devices") : null}
            empty={!devicesQ.isLoading && rows.length === 0}
            emptyText={
              view === "unplaced"
                ? "Every reporting device is placed."
                : view === "placed"
                  ? "No device has been placed yet."
                  : "No device is reporting."
            }
          >
            {groups.map(([prefix, members]) => {
              const allOn = members.every((m: any) => selected[m.device_id]);
              return (
                <div key={prefix} className="border-b border-nb-line/40 last:border-b-0">
                  <div className="flex items-center gap-2 bg-[rgba(10,18,40,.45)] px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(members)}
                      className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-faint hover:text-nb-muted"
                      title="Select every device whose tag starts with this — a naming convention, not a placement"
                    >
                      <Icon
                        icon={allOn ? "heroicons:check-circle-solid" : "heroicons:check-circle"}
                        className={allOn ? "text-sm text-nb-blueb" : "text-sm"}
                      />
                      {prefix}
                    </button>
                    <span className="text-[10.5px] text-nb-faint">
                      {members.length} device{members.length === 1 ? "" : "s"} ·{" "}
                      {members.reduce((n: number, m: any) => n + m.points, 0)} points
                    </span>
                  </div>
                  {members.map((d: any) => {
                    const on = !!selected[d.device_id];
                    const where = whereLabel(d);
                    return (
                      <button
                        key={d.device_id}
                        type="button"
                        onClick={() => toggle(d.device_id)}
                        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${
                          on ? "bg-[rgba(96,165,250,.12)]" : "hover:bg-[rgba(96,165,250,.06)]"
                        }`}
                      >
                        <Icon
                          icon={on ? "heroicons:check-circle-solid" : "heroicons:check-circle"}
                          className={`shrink-0 text-base ${on ? "text-nb-blueb" : "text-nb-faint"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] text-nb-ink">
                            {d.device_tag || d.device_id}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-nb-faint">
                            {[d.category, d.device_type].filter(Boolean).join(" · ") ||
                              "unclassified"}{" "}
                            · {d.points} point{d.points === 1 ? "" : "s"}
                            {d.points_overridden ? (
                              <span className="ml-1 text-nb-warn">
                                · {d.points_overridden} placed individually
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          {where ? (
                            <span className="block text-[11.5px] text-nb-good">{where}</span>
                          ) : (
                            // Unplaced renders as unplaced. Not as a blank, not
                            // as a default floor.
                            <span className="block text-[11.5px] italic text-nb-faint">
                              Unplaced
                            </span>
                          )}
                          <span className="block text-[10.5px] text-nb-faint">
                            {fmtRelative(d.last_seen_at)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </PanelList>
          <PanelFooter>
            <span className="text-[11px] text-nb-faint">
              Groups are the leading token of the gateway&rsquo;s own device tag. They
              select; they never place — nothing here maps <code>4F</code> to a floor.
            </span>
          </PanelFooter>
        </div>

        {/* ── the decision ─────────────────────────────────────────────── */}
        <div className="min-h-0 space-y-3 overflow-y-auto">
          <SectionCard>
            <SectionHead
              icon="heroicons:map-pin"
              title="Place selected"
              desc={
                canManage
                  ? "Every selected device goes to the same place. The site is required; a floor and a zone are not — “on the site, on no particular storey” is a true answer for a rooftop meter."
                  : "You do not hold bi.manage, so this is read-only. A tenant admin can grant it in the role editor."
              }
            />
            {devicesQ.isLoading ? (
              <LoadingBlock label="Loading estate…" />
            ) : (
              <>
                <PanelStat
                  label="Selected"
                  value={`${selectedIds.length} device${selectedIds.length === 1 ? "" : "s"} · ${selectedPoints} points`}
                  tone={selectedIds.length ? "blue" : "faint"}
                />

                <div className="mt-3 space-y-2.5">
                  <Picker
                    label="Site"
                    value={siteId}
                    onChange={(v: string) => {
                      setSiteId(v);
                      setFloorId("");
                      setZoneId("");
                    }}
                    options={siteRows.map((s: any) => ({ value: s.site_id, label: s.name }))}
                    placeholder="Choose a site…"
                    disabled={!canManage}
                    emptyHint="No site exists yet. Create one under Configurations → Sites."
                  />
                  <Picker
                    label="Floor (optional)"
                    value={floorId}
                    onChange={(v: string) => {
                      setFloorId(v);
                      setZoneId("");
                    }}
                    options={floorRows.map((f: any) => ({ value: f.floor_id, label: f.name }))}
                    placeholder="No floor"
                    disabled={!canManage || !siteId}
                    emptyHint={siteId ? "This site has no floor." : undefined}
                  />
                  <Picker
                    label="Zone (optional)"
                    value={zoneId}
                    onChange={setZoneId}
                    options={zoneRows.map((z: any) => ({ value: z.zone_id, label: z.name }))}
                    placeholder="No zone"
                    disabled={!canManage || !floorId}
                    emptyHint={floorId ? "This floor has no zone." : undefined}
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton disabled={!canSubmit} onClick={() => placeM.mutate()}>
                    {placeM.isPending ? "Placing…" : "Place"}
                  </ActionButton>
                  <QuietButton
                    disabled={!canManage || !selectedIds.length || busy}
                    onClick={() => unplaceM.mutate()}
                  >
                    {unplaceM.isPending ? "Unplacing…" : "Unplace"}
                  </QuietButton>
                </div>
                {!canManage && (
                  <p className="mt-2 text-[11px] text-nb-warn">
                    Missing permission <code>bi.manage</code>.
                  </p>
                )}
                {canManage && (
                  <p className="mt-2 text-[11px] leading-relaxed text-nb-faint">
                    Choosing a place also needs <code>sites.read</code> /{" "}
                    <code>floors.read</code>: the server verifies every id against core
                    with your token and copies the NAME from core&rsquo;s answer, so a
                    stored placement can never name a floor that does not exist.
                  </p>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard>
            <SectionHead
              icon="heroicons:chart-pie"
              title="Estate"
              desc="Counted over devices (the work) and over points (the data). Unplaced is stated, not implied by an empty list."
            />
            {overview ? (
              <>
                <PanelStat
                  label="Devices placed"
                  value={`${overview.devices_placed} of ${overview.devices}`}
                  tone={overview.devices_placed ? "good" : "faint"}
                />
                <PanelStat
                  label="Devices unplaced"
                  value={overview.devices_unplaced}
                  tone={overview.devices_unplaced ? "warn" : "good"}
                />
                <PanelStat
                  label="Points on a floor"
                  value={`${overview.points_with_floor} of ${overview.points}`}
                  tone={overview.points_with_floor ? "good" : "faint"}
                />
                <PanelStat
                  label="Points unplaced"
                  value={overview.points_unplaced}
                  tone={overview.points_unplaced ? "warn" : "good"}
                />
                <PanelStat
                  label="Points placed individually"
                  value={overview.points_overridden}
                  tone="faint"
                />
              </>
            ) : (
              <LoadingBlock label="Counting…" />
            )}
          </SectionCard>

          <SectionCard>
            <SectionHead
              icon="heroicons:information-circle"
              title="What this does not do"
              desc="Stated rather than hidden, so an empty column is never mistaken for a broken one."
            />
            <ul className="space-y-2 text-[11.5px] leading-relaxed text-nb-faint">
              <li>
                <b className="text-nb-soft">It never guesses a floor.</b> The gateway
                wire carries no placement, and a floor parsed out of a device tag would
                be right for most of an estate and silently wrong for the rest.{" "}
                <code>4F-3F AC DB</code> names two floors.
              </li>
              <li>
                <b className="text-nb-soft">It places a device, not a drawing pin.</b>{" "}
                Where a device is on a floor-plan image is a different fact and a
                different screen (Sites → Floors). This one has no coordinates to
                invent.
              </li>
              <li>
                <b className="text-nb-soft">A reading can never move a placement.</b>{" "}
                The writer&rsquo;s upsert does not name these columns; it only lets a
                point that reports for the first time inherit its device&rsquo;s
                placement.
              </li>
            </ul>
          </SectionCard>
        </div>
      </ConsoleGrid>
    </ConsolePage>
  );
}

/** A labelled native select styled to the console. Native on purpose: a picker
 *  with 200 sites needs the platform's own keyboard handling more than it needs
 *  a custom popover. */
function Picker({ label, value, onChange, options, placeholder, disabled, emptyHint }: any) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.6)] px-3 py-2 text-[12.5px] text-nb-ink outline-hidden disabled:opacity-45"
      >
        <option value="">{placeholder}</option>
        {options.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!options.length && emptyHint && (
        <span className="mt-1 block text-[11px] text-nb-faint">{emptyHint}</span>
      )}
    </label>
  );
}
