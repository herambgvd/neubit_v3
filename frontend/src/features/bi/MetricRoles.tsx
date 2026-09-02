"use client";

// METRIC ROLES — where an operator says what a point IS to a metric.
//
// The metric registry names its inputs by ROLE (`inlet_water_temp`), never by
// point tag: a tag is one estate's naming convention and the whole reason the
// registry generalises is that the next estate spells it differently. This
// screen follows the UNITS tab's anatomy exactly, and its one rule is the same:
// **the platform may SUGGEST a role from a tag; only a human may STORE one.**
//
// The suggestion comes from the server (`/bi/metrics/roles`, computed at read
// time and never written) with a `basis` in words — "the tag is `IWT` —
// entering water temperature by this estate's convention" — so the operator
// confirms a stated reason, not a value from nowhere. Bulk selects rows the
// operator can SEE and posts THEIR IDS; the server never expands a pattern.
//
// The role vocabulary is CLOSED and comes from the server with the list, so the
// picker cannot grow a folksonomy no metric definition could name. `role: null`
// clears — retraction is reachable, because a mis-assigned role an operator
// cannot take back would silently corrupt every metric computed through it.
//
// A point nobody confirms stays unbound, every metric that needs it renders
// BLOCKED with the reason, and that is the honest state — not a defect.
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

import { PERM_MANAGE } from "./constants";
import { metrics } from "./metricsApi";

const VIEWS = [
  { value: "unconfirmed", label: "UNBOUND" },
  { value: "confirmed", label: "CONFIRMED" },
  { value: "all", label: "ALL" },
];

export default function MetricRoles() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);

  const [view, setView] = useState("unconfirmed");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [role, setRole] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const q = useQuery<any>({
    queryKey: ["bi-metric-roles", view, search],
    queryFn: () =>
      metrics.roles({ confirmed: view, search: search.trim() || undefined, limit: 500 }),
  });

  const rows: any[] = q.data?.items || [];
  const counts = q.data?.counts;
  const vocabulary: any[] = q.data?.vocabulary || [];
  const ids = Object.keys(picked).filter((k) => picked[k]);

  // Suggestion groups: every loaded row whose suggestion shares a basis — the
  // pattern, made visible as actual rows before anything is written.
  const groups = useMemo(() => {
    const m = new Map<string, { role: string; basis: string; ids: string[] }>();
    for (const r of rows) {
      if (!r.suggestion) continue;
      const k = `${r.suggestion.basis}::${r.suggestion.role}`;
      const g = m.get(k) || { role: r.suggestion.role, basis: r.suggestion.basis, ids: [] };
      g.ids.push(r.point_id);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.ids.length - a.ids.length);
  }, [rows]);

  const confirm = useMutation({
    mutationFn: ({ point_ids, role: r }: any) => metrics.confirmRoles({ point_ids, role: r }),
    onSuccess: (res: any) => {
      setErr(null);
      setDone(
        `${res.updated} point(s) ${res.role === null ? "cleared back to unbound" : `bound to role “${res.role}”`}` +
          (res.not_visible ? ` · ${res.not_visible} not visible to you and untouched` : ""),
      );
      setPicked({});
      qc.invalidateQueries({ queryKey: ["bi-metric-roles"] });
      qc.invalidateQueries({ queryKey: ["bi-metric-evaluate"] });
    },
    onError: (e) => {
      setDone(null);
      setErr(apiError(e, "Could not record the role"));
    },
  });

  function selectGroup(g: { role: string; ids: string[] }) {
    const next: Record<string, boolean> = {};
    for (const id of g.ids) next[id] = true;
    setPicked(next);
    setRole(g.role);
  }

  const roleLabel = (r: string) => vocabulary.find((v) => v.role === r)?.label || r;

  return (
    <div className="space-y-3">
      <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            Metric roles
          </div>
          <Segmented value={view} onChange={setView} options={VIEWS} />
        </div>

        {counts && (
          <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">
              {counts.points} live points
            </span>
            <span className="rounded-[6px] border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] px-2 py-0.5 text-nb-good">
              {counts.confirmed} bound
            </span>
            <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)] px-2 py-0.5 text-nb-warn">
              {counts.unconfirmed} unbound
            </span>
          </div>
        )}

        <p className="mb-2 text-[10.5px] leading-relaxed text-nb-faint">
          A derived metric names its inputs by <b>role</b> — <span className="font-mono">OWT</span>{" "}
          suggests <i>leaving water temperature</i>, but a tag is a naming convention, never
          evidence. Nothing is stored until you confirm it, and a metric whose roles nobody has
          confirmed renders <b>blocked</b> with the reason rather than computing on a guess.
        </p>

        <PanelSearch value={search} onChange={setSearch} placeholder="Search device or point…" />

        {/* pattern groups — the bulk path, with the matched rows made visible */}
        {mayWrite && groups.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.basis + g.role}
                type="button"
                onClick={() => selectGroup(g)}
                title={`Select the ${g.ids.length} loaded points where ${g.basis}`}
                className="rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1 text-[10.5px] text-nb-soft transition hover:border-nb-blue"
              >
                Select {g.ids.length} where {g.basis} →{" "}
                <span className="font-mono text-nb-ink">{g.role}</span>
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
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-7 rounded-[6px] border border-nb-line bg-[rgba(6,11,26,.7)] px-2 font-mono text-[12px] text-nb-ink outline-none focus:border-nb-blue"
          >
            <option value="">choose a role…</option>
            {vocabulary.map((v) => (
              <option key={v.role} value={v.role}>
                {v.role} — {v.label}
              </option>
            ))}
          </select>
          <ActionButton
            onClick={() => confirm.mutate({ point_ids: ids, role })}
            disabled={confirm.isPending || !role}
          >
            {confirm.isPending ? "Saving…" : `Confirm as ${role || "…"}`}
          </ActionButton>
          <QuietButton onClick={() => confirm.mutate({ point_ids: ids, role: null })}>
            Clear role
          </QuietButton>
          <QuietButton onClick={() => setPicked({})}>Deselect</QuietButton>
        </div>
      )}
      {done && <p className="text-[11.5px] text-nb-good">{done}</p>}
      {err && <p className="text-[11.5px] text-nb-crit">{err}</p>}
      {!mayWrite && (
        <p className="text-[11px] text-nb-faint">
          Binding a role needs <span className="font-mono">bi.manage</span>. You can see what has
          been confirmed and what has not.
        </p>
      )}

      {q.isLoading ? (
        <LoadingBlock label="Loading points…" />
      ) : q.error ? (
        <p className="text-[12px] text-nb-crit">{apiError(q.error, "Could not load points")}</p>
      ) : !rows.length ? (
        <p className="py-6 text-center text-[11.5px] text-nb-faint">Nothing matches this filter.</p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-nb-line">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-semibold">Device</th>
                <th className="px-3 py-2 font-semibold">Point</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Stated by</th>
                <th className="px-3 py-2 font-semibold">Suggestion from the tag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = !!picked[r.point_id];
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
                      {r.role ? (
                        <span className="text-nb-ink" title={roleLabel(r.role)}>
                          {r.role}
                        </span>
                      ) : (
                        <span className="text-nb-faint">not bound</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[11px]">
                      {r.role ? (
                        <span className="text-nb-good" title={r.role_confirmed_at || undefined}>
                          {r.role_confirmed_by || "an operator"}
                        </span>
                      ) : (
                        <span className="text-nb-faint">nobody</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-nb-faint">
                      {r.suggestion ? (
                        <>
                          <span className="font-mono text-nb-soft">{r.suggestion.role}</span> —{" "}
                          {r.suggestion.basis}
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
