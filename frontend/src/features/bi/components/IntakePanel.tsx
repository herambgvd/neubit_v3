"use client";

// INTAKE — what arrived, what still means nothing, and what is not there at all.
//
// New sensors land on this estate every week; two chillers appeared during the
// session this panel was written in and were invisible until someone happened to
// look. Every metric that would have used them refused, correctly and by name —
// inside a metric evaluation nobody reads until a number renders as a dash.
//
// This is the missing surface, and it lives ABOVE the roles table rather than on
// a page of its own: the operator triaging a week's arrivals is the same person
// who binds a role, and the row they are worried about is in the table below.
// Clicking a row filters that table to the device.
//
// THE COLUMN THAT MATTERS IS "LAST READING", NOT "LAST SEEN". `last_seen_at`
// used to advance on ANY message, including a retained one replayed on
// reconnect whose timestamp was already stored — so a dead address looked alive
// forever. `e9818d2` fixed the writer, but classification stays on
// `max(readings.ts)`: rows inflated before that fix never heal, and they are
// precisely the ones this panel is here to show. The server classifies and this
// panel shows what it decided:
//
//   reporting               delivering values
//   awaiting first reading  arrived minutes ago, nothing yet — ordinary
//   silent                  reported once and stopped: usually a re-tagged device
//   never reported          an address that has produced nothing, ever
//
// A "never reported" point is NOT pending confirmation. There is nothing to
// confirm; the address is wrong, or the topic is outside the connection's
// subscription. Giving it a unit would store a fact no metric can ever use.
//
// Nothing on this panel writes. It has no confirm button on purpose — the two
// assertions already have their screens, and a third place to make them is a
// third place for them to disagree.
import { useQuery } from "@tanstack/react-query";

import { LoadingBlock, Segmented } from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import { bi } from "../api";

const VIEWS = [
  { value: "", label: "ALL PENDING" },
  // Not a state — the WINDOW applied to the rows as well as to the counters.
  // "What arrived this week and still means nothing" is the question this whole
  // panel was built for, and it deserves to be one click rather than a reading
  // of the first-seen column.
  { value: "new", label: "NEW IN WINDOW" },
  { value: "reporting", label: "REPORTING" },
  { value: "silent", label: "SILENT" },
  { value: "never_reported", label: "NEVER REPORTED" },
];

const STATE_TONE: Record<string, string> = {
  reporting: "text-nb-good",
  awaiting_first_reading: "text-nb-blueb",
  silent: "text-nb-warn",
  never_reported: "text-nb-crit",
};

const STATE_LABEL: Record<string, string> = {
  reporting: "reporting",
  awaiting_first_reading: "awaiting first reading",
  silent: "silent",
  never_reported: "never reported",
};

export default function IntakePanel({
  days,
  state,
  onDays,
  onState,
  onFocusDevice,
}: {
  days: number;
  state: string;
  onDays: (d: number) => void;
  onState: (s: string) => void;
  onFocusDevice: (deviceTag: string) => void;
}) {
  const q = useQuery<any>({
    queryKey: ["bi-intake", days, state],
    // ALL PENDING asks for outstanding work — everything with no confirmed unit.
    // A STATE view drops that filter on purpose: a silent or never-reported
    // point that someone already confirmed is the most important row on this
    // panel, not the least, and filtering it out would hide exactly the
    // mis-binding this surface exists to expose.
    queryFn: () =>
      bi.intake({
        days,
        state: state && state !== "new" ? state : undefined,
        new_only: state === "new" ? true : undefined,
        // A STATE view keeps confirmed rows: a silent or never-reported point
        // somebody already confirmed is the most important row here, not the
        // least, and hiding it would hide the mis-binding this exists to expose.
        pending: state && state !== "new" ? false : undefined,
        limit: 300,
      }),
  });

  const counts = q.data?.counts;
  const devices: any[] = q.data?.devices || [];
  const items: any[] = q.data?.items || [];
  const th = q.data?.thresholds;

  return (
    <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
          Intake · what arrived and still means nothing
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={String(days)}
            onChange={(v: string) => onDays(Number(v))}
            options={[
              { value: "1", label: "24H" },
              { value: "7", label: "7D" },
              { value: "30", label: "30D" },
            ]}
          />
          <Segmented value={state} onChange={onState} options={VIEWS} />
        </div>
      </div>

      {counts && (
        <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">
            {counts.arrived} arrived in {days}d
          </span>
          <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)] px-2 py-0.5 text-nb-warn">
            {counts.arrived_unit_unconfirmed} of them with no unit
          </span>
          <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-faint">
            {counts.unit_unconfirmed} unconfirmed across the estate
          </span>
          <span className="rounded-[6px] border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] px-2 py-0.5 text-nb-good">
            {counts.reporting} reporting
          </span>
          {counts.silent > 0 && (
            <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] px-2 py-0.5 text-nb-warn">
              {counts.silent} silent
            </span>
          )}
          {counts.never_reported > 0 && (
            <span
              className="rounded-[6px] border border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.08)] px-2 py-0.5 text-nb-crit"
              title="Addresses that have produced no value, ever. Not pending confirmation — wrong."
            >
              {counts.never_reported} never reported
            </span>
          )}
        </div>
      )}

      {/* devices, because "a new chiller appeared" is one row here and three below */}
      {devices.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {devices.slice(0, 12).map((d) => (
            <button
              key={d.device_tag}
              type="button"
              onClick={() => onFocusDevice(d.device_tag)}
              title={`First seen ${d.first_seen_at} · ${d.reporting}/${d.points} points reporting · ${d.unit_confirmed}/${d.points} with a confirmed unit`}
              className="rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1 text-[10.5px] text-nb-soft transition hover:border-nb-blue"
            >
              <span className="text-nb-ink">{d.device_tag}</span>{" "}
              <span className="text-nb-faint">
                {fmtRelative(d.first_seen_at)} · {d.unit_confirmed}/{d.points} with a unit
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="mb-2 text-[10.5px] leading-relaxed text-nb-faint">
        A point means nothing until a human confirms its unit, and a metric input nothing until
        someone binds its role — so a sensor that arrived on Monday blocks every metric it belongs
        to until then. <b>Never reported</b> is a different problem and must not be confirmed away:
        that address has produced no value at all, so it is a spelling or a subscription to fix,
        not a dropdown to fill. Classification reads{" "}
        <span className="font-mono">max(readings.ts)</span>, not{" "}
        <span className="font-mono">last_seen_at</span> — a replayed retained message used to move
        the latter without carrying any data, and the rows that happened to never heal
        {th ? ` (silent after ${th.silent_after_hours}h; ${th.first_reading_grace_minutes} min grace for a first reading)` : ""}
        .
      </p>

      {q.isLoading ? (
        <LoadingBlock label="Reading the intake…" />
      ) : q.error ? (
        <p className="text-[12px] text-nb-crit">{apiError(q.error, "Could not load the intake")}</p>
      ) : !items.length ? (
        <p className="py-4 text-center text-[11.5px] text-nb-faint">
          Nothing outstanding in this window. Every point that arrived has a unit a human confirmed.
        </p>
      ) : (
        <div className="max-h-[320px] overflow-auto rounded-[10px] border border-nb-line">
          <table className="w-full min-w-[760px] text-left">
            <thead className="sticky top-0">
              <tr className="bg-[rgba(6,11,26,.9)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                <th className="px-3 py-2 font-semibold">Device</th>
                <th className="px-3 py-2 font-semibold">Point</th>
                <th className="px-3 py-2 font-semibold">First seen</th>
                <th className="px-3 py-2 font-semibold">Last reading</th>
                <th className="px-3 py-2 font-semibold">State</th>
                <th className="px-3 py-2 font-semibold">Unit</th>
                <th className="px-3 py-2 font-semibold">Role</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr
                  key={r.point_id}
                  onClick={() => onFocusDevice(r.device_tag)}
                  className="cursor-pointer border-t border-nb-line/50 transition hover:bg-white/[.03]"
                >
                  <td className="px-3 py-1.5 text-[11.5px] text-nb-soft">{r.device_tag}</td>
                  <td className="px-3 py-1.5 font-mono text-[11.5px] text-nb-ink">{r.point_tag}</td>
                  <td className="px-3 py-1.5 text-[11px] text-nb-faint">
                    {fmtRelative(r.first_seen_at)}
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-nb-faint">
                    {r.last_reading_at ? fmtRelative(r.last_reading_at) : "never"}
                  </td>
                  <td className={`px-3 py-1.5 text-[11px] ${STATE_TONE[r.state] || "text-nb-faint"}`}>
                    {STATE_LABEL[r.state] || r.state}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {r.unit_confirmed ? (
                      <span className="text-nb-good">{r.unit || "(dimensionless)"}</span>
                    ) : (
                      <span className="text-nb-warn">not confirmed</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    {r.role ? (
                      <span className="text-nb-good">{r.role}</span>
                    ) : (
                      <span className="text-nb-faint">not bound</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
