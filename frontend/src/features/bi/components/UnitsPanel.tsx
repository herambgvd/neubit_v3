"use client";

// UNITS — where an operator says what a point measures.
//
// This is the screen that unblocks Ratings, and its whole design is one rule:
// **the platform may SUGGEST a unit from a tag; only a human may STORE one.**
//
// The suggestion comes from the server (`/bi/units`, computed at read time from
// the point tag and never written) and arrives with a `basis` in words — "the
// tag ends in `_kwh`" — so the operator is confirming a stated reason rather
// than a value that appeared from nowhere. Bulk is offered, because 314 points
// one at a time is how a feature does not get used, but a bulk action here is
// still a list the operator can see: "apply to all points matching this pattern"
// selects the rows, shows them, and posts THEIR IDS. The server never expands a
// pattern of its own — that would be a guess wearing a human's authority.
//
// A point nobody confirms keeps a NULL unit and is counted as unconfirmed. That
// is a perfectly good outcome and the counter at the top says so plainly.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ActionButton,
  LoadingBlock,
  PanelSearch,
  QuietButton,
  Segmented,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { bi } from "../api";
import { PERM_MANAGE } from "../constants";

const VIEWS = [
  { value: "unconfirmed", label: "UNCONFIRMED" },
  { value: "confirmed", label: "CONFIRMED" },
  { value: "all", label: "ALL" },
];

export default function UnitsPanel() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);

  const [view, setView] = useState("unconfirmed");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [unit, setUnit] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const q = useQuery<any>({
    queryKey: ["bi-units", view, search],
    queryFn: () => bi.units({ confirmed: view, search: search.trim() || undefined, limit: 500 }),
  });

  const rows: any[] = q.data?.items || [];
  const counts = q.data?.counts;
  const ids = Object.keys(picked).filter((k) => picked[k]);

  // The suggestion groups. Each is "every loaded row whose suggestion has this
  // basis" — the pattern, made visible as a set of actual rows before anything
  // is written.
  const groups = useMemo(() => {
    const m = new Map<string, { unit: string; basis: string; ids: string[] }>();
    for (const r of rows) {
      if (!r.suggestion) continue;
      const k = `${r.suggestion.basis}::${r.suggestion.unit}`;
      const g = m.get(k) || { unit: r.suggestion.unit, basis: r.suggestion.basis, ids: [] };
      g.ids.push(r.point_id);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.ids.length - a.ids.length);
  }, [rows]);

  const confirm = useMutation({
    mutationFn: ({ point_ids, unit: u }: any) => bi.confirmUnits({ point_ids, unit: u }),
    onSuccess: (res: any) => {
      setErr(null);
      setDone(
        `${res.updated} point(s) ${res.unit === null ? "cleared back to unconfirmed" : `recorded as “${res.unit || "no unit (a ratio)"}”`}` +
          (res.not_visible ? ` · ${res.not_visible} not visible to you and untouched` : ""),
      );
      setPicked({});
      qc.invalidateQueries({ queryKey: ["bi-units"] });
      qc.invalidateQueries({ queryKey: ["bi-rating"] });
    },
    onError: (e) => {
      setDone(null);
      setErr(apiError(e, "Could not record the unit"));
    },
  });

  function selectGroup(g: { ids: string[] }) {
    const next: Record<string, boolean> = {};
    for (const id of g.ids) next[id] = true;
    setPicked(next);
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            Units
          </div>
          <Segmented value={view} onChange={setView} options={VIEWS} />
        </div>

        {counts && (
          <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">
              {counts.points} live points
            </span>
            <span className="rounded-[6px] border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] px-2 py-0.5 text-nb-good">
              {counts.confirmed} confirmed
            </span>
            <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)] px-2 py-0.5 text-nb-warn">
              {counts.unconfirmed} unconfirmed
            </span>
          </div>
        )}

        <p className="mb-2 text-[10.5px] leading-relaxed text-nb-faint">
          The source sends no unit for any point on this deployment, so every unit here is
          somebody&apos;s statement. A tag such as <span className="font-mono">KWH_kwh</span> is
          offered as a <b>suggestion</b> with the pattern it matched — it is a naming convention,
          never evidence, so nothing is stored until you confirm it. What you do not confirm keeps
          a blank unit and counts as unconfirmed.
        </p>

        <PanelSearch value={search} onChange={setSearch} placeholder="Search device or point…" />

        {/* pattern groups — the bulk path, with the matched rows made visible */}
        {mayWrite && groups.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.basis + g.unit}
                type="button"
                onClick={() => selectGroup(g)}
                title={`Select the ${g.ids.length} loaded points where ${g.basis}`}
                className="rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1 text-[10.5px] text-nb-soft transition hover:border-nb-blue"
              >
                Select {g.ids.length} where {g.basis} →{" "}
                <span className="font-mono text-nb-ink">{g.unit || "(no unit)"}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* the confirmation bar */}
      {mayWrite && ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.08)] px-3 py-2.5">
          <span className="text-[11.5px] text-nb-ink">
            {ids.length} point{ids.length === 1 ? "" : "s"} selected
          </span>
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="unit, e.g. kWh"
            className="h-7 w-36 rounded-[6px] border border-nb-line bg-[rgba(6,11,26,.7)] px-2 font-mono text-[12px] text-nb-ink outline-none focus:border-nb-blue"
          />
          <ActionButton
            onClick={() => confirm.mutate({ point_ids: ids, unit })}
            disabled={confirm.isPending}
          >
            {confirm.isPending ? "Saving…" : `Confirm as “${unit || "no unit (a ratio)"}”`}
          </ActionButton>
          <QuietButton onClick={() => confirm.mutate({ point_ids: ids, unit: null })}>
            Clear unit
          </QuietButton>
          <QuietButton onClick={() => setPicked({})}>Deselect</QuietButton>
        </div>
      )}
      {done && <p className="text-[11.5px] text-nb-good">{done}</p>}
      {err && <p className="text-[11.5px] text-nb-crit">{err}</p>}
      {!mayWrite && (
        <p className="text-[11px] text-nb-faint">
          Recording a unit needs <span className="font-mono">bi.manage</span>. You can see what has
          been confirmed and what has not.
        </p>
      )}

      {q.isLoading ? (
        <LoadingBlock label="Loading points…" />
      ) : q.error ? (
        <p className="text-[12px] text-nb-crit">{apiError(q.error, "Could not load points")}</p>
      ) : !rows.length ? (
        <p className="py-6 text-center text-[11.5px] text-nb-faint">
          Nothing matches this filter.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-nb-line">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-semibold">Device</th>
                <th className="px-3 py-2 font-semibold">Point</th>
                <th className="px-3 py-2 font-semibold">Unit</th>
                <th className="px-3 py-2 font-semibold">Stated by</th>
                <th className="px-3 py-2 font-semibold">Suggestion from the tag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = !!picked[r.point_id];
                const confirmed = r.unit_source === "operator";
                return (
                  <tr
                    key={r.point_id}
                    onClick={() => mayWrite && setPicked((p) => ({ ...p, [r.point_id]: !on }))}
                    className={`border-t border-nb-line/50 transition ${
                      mayWrite ? "cursor-pointer" : ""
                    } ${on ? "bg-[rgba(96,165,250,.1)]" : "hover:bg-white/[.03]"}`}
                  >
                    <td className="px-3 py-1.5">
                      <Icon
                        icon={on ? "heroicons:check-circle-solid" : "heroicons:stop"}
                        className={`text-[14px] ${on ? "text-nb-blueb" : "text-nb-faint"}`}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-[11.5px] text-nb-soft">{r.device_tag}</td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px] text-nb-ink">
                      {r.point_tag}
                      {r.type !== "num" && (
                        <span className="ml-1.5 text-[10px] text-nb-faint">({r.type})</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px]">
                      {r.unit_source ? (
                        <span className="text-nb-ink">{r.unit || "— (a ratio)"}</span>
                      ) : (
                        <span className="text-nb-faint">not recorded</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[11px]">
                      {confirmed ? (
                        <span className="text-nb-good" title={r.unit_confirmed_at || undefined}>
                          {r.unit_confirmed_by || "an operator"}
                        </span>
                      ) : r.unit_source === "reading" ? (
                        <span className="text-nb-soft">the wire (env.u)</span>
                      ) : (
                        <span className="text-nb-faint">nobody</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-nb-faint">
                      {r.suggestion ? (
                        <>
                          <span className="font-mono text-nb-soft">
                            {r.suggestion.unit || "(no unit)"}
                          </span>{" "}
                          — {r.suggestion.basis}
                        </>
                      ) : (
                        <span className="italic">no pattern matched</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
