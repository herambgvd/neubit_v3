"use client";

// Building Intelligence → STRANDED ROLES. Gate 4: what a number BINDS to.
//
// Every number on this platform passes six gates — it ARRIVES, it MEANS a unit,
// it BELONGS to a place, it BINDS to a metric role, it RATES, it ACTS. Gate 4 is
// shut on this deployment and it is the reason nothing above it computes:
// `point_roles` holds 20 operator assertions about what numbers mean, and not one
// of them is on a point that is still reporting.
//
//   device `1F York Chiller01`
//     point_tag `IWT`        degC, the role is bound here, dead since 5 Sep
//     point_tag `1FYC1_IWT`  reporting, no role
//
// An operator did the binding work; the gateway then rebuilt its connection,
// re-keyed every point id and renamed the tags, and every binding was left
// pointing at a dead generation. No screen has ever said so — the metric simply
// refuses `no_data` for a chiller that is running.
//
// WHY THIS IS NOT THE DUPLICATES CONSOLE. That screen groups on
// `(device tag, point tag)` and settles a connection rebuilt under the SAME tags.
// Here the tag changed too, so the generations are duplicates of nothing and the
// collapse can never reach them.
//
// WHY THIS IS NOT THE METRIC ROLES TABLE. That screen binds a role to a point
// NOBODY has ruled on: its question is "what is this point?", asked of 766 rows,
// answered in bulk from tag suggestions. This screen's question is the opposite
// one — an assertion already exists, a human already made it, and the only thing
// in doubt is WHICH ROW IT NOW NAMES. That is one stranded assertion at a time,
// read against evidence, and it needs the pane the table has nowhere to put.
//
// NOTHING AUTO-APPLIES, AND THERE IS NO THRESHOLD THAT WOULD MAKE IT. The server
// SCORES and PROPOSES; only the operator names ids. A role is a statement about
// what a number MEANS: bind `inlet_water_temp` to the wrong tag and every ΔT,
// every kW/TR and every rating above it still computes, plausibly, and wrongly. A
// refusal is visible; a plausible wrong answer is not. So the score is printed as
// an ORDER with every signal that produced it spelled out as a sentence, and a
// candidate is never pre-selected however far ahead it is.
//
// THE SECOND WRITE IS A DELETE, and it is the only one on this console. A role
// whose `points` row is GONE cannot be repointed — a successor has to be on the
// same device and there is no device tag left to read — so forgetting it is the
// one honest action, and without it the assertion is unfixable AND undeletable
// from any screen, which is the state that hid it in the first place. It is
// therefore the narrowest control here: one id, from the row that is open, a
// confirmation that NAMES what it destroys before it is pressed, and no shape
// that could express a sweep.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import {
  ActionButton,
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  DangerButton,
  EmptyPane,
  PanelFooter,
  PanelHeader,
  PanelList,
  PanelSearch,
  QuietButton,
  Segmented,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";

import Reason from "./components/Reason";
import { bi } from "./api";
import { PERM_MANAGE } from "./constants";
import SetupHeader from "./setup/SetupHeader";
import { taskHref } from "./setup/routes";

/** One stranded assertion. `point_roles` is keyed by point, so the pair is
 *  unique — and it stays a pair rather than the bare id because the role is what
 *  the operator is moving. */
const orphanKey = (o: any) => `${o.role}::${o.point_id}`;

// The two reasons that leave a POINT ROW to read. The third — `point_missing`,
// a role whose point row is GONE, not retired, absent — carries no device tag,
// no point tag and no candidates, and is settled by forgetting rather than by a
// repoint. It is matched as "anything this screen does not recognise" rather
// than by name, so a fourth reason of the same shape renders as itself instead
// of as a superseded point with every field blank.
const KNOWN_REASONS = new Set(["superseded", "retired"]);

/** The assertion's subject is gone: there is no row left to read, and therefore
 *  no device, no tag and no candidate set. Detected from the SHAPE as well as
 *  from the reason, because a row with no point tag has already lost its subject
 *  whatever it is called. */
export function subjectMissing(o: any): boolean {
  if (!o) return false;
  if (o.orphan_reason && !KNOWN_REASONS.has(o.orphan_reason)) return true;
  return !o.point_tag;
}

/** Why this role is stranded, in words. Three different facts about the
 *  building, and they must not print the same sentence. */
function whyStranded(o: any, graceMinutes: number): string {
  if (subjectMissing(o)) {
    return (
      "The point this assertion names is not in the reading store at all — not retired, absent. " +
      "There is no row to read, no device to look at and nothing that could succeed it."
    );
  }
  if (o.orphan_reason === "retired") {
    return (
      "The point this role is bound to is retired, so it is not part of the estate and the role " +
      "cannot be selecting anything. Whether it was retired by hand or by a duplicate collapse " +
      "that could not move the role, the binding is stranded either way."
    );
  }
  return (
    `This device is still delivering — its newest reading is ${fmtRelative(o.device_last_seen_at)} — ` +
    `while the tag the role is bound to last carried a value ${fmtRelative(o.last_seen_at)}, more than ` +
    `${graceMinutes} minutes behind it. That is a rename, not an outage: the measurement is arriving ` +
    "under a different tag."
  );
}

/** What the candidate list is SAYING when it is empty. "No successor was found"
 *  and "there was nothing to look at" are different answers and the count is how
 *  they are told apart. */
function noCandidateReason(o: any): string {
  const considered = Number(o?.candidates_considered ?? 0);
  if (!considered) {
    return (
      "No point on this device is at its leading edge, so there was nothing to look at. " +
      "The search ran and found no pool — this is not an empty screen."
    );
  }
  return (
    `${considered} point(s) at this device's leading edge were looked at, and none of them carried ` +
    "evidence strong enough to propose. A shared unit is not evidence — every temperature point on a " +
    "chiller reads the same one — so nothing is offered rather than a nearest match."
  );
}

// The signal names, as a heading for the sentence the server already wrote. The
// sentence is the evidence; this is only what to call it, and an unrecognised
// kind prints its own key rather than being dropped.
const EVIDENCE_LABEL: Record<string, string> = {
  identical_tag: "The tag did not change",
  measurement_tail: "Same measurement at the tail",
  role_convention: "This estate's own role convention",
  shared_token: "A shared token that is not the device's name",
  unit_match: "The same confirmed unit",
  dimension_match: "At least the right dimension",
};

const FILTERS = (withC: number, withoutC: number) => [
  { value: "", label: `ALL ${withC + withoutC}` },
  { value: "proposed", label: `SUCCESSOR PROPOSED ${withC}` },
  { value: "none", label: `NOTHING PROPOSED ${withoutC}` },
];

/** A unit, in the one vocabulary this console uses for a blocked value: an
 *  operator's "no dimension" is an ANSWER and nobody's unit is not. */
function UnitCell({ unit }: Readonly<{ unit: string | null | undefined }>) {
  if (unit === null || unit === undefined) {
    return <span className="text-nb-faint">unit not recorded</span>;
  }
  if (unit === "") return <span className="text-nb-ink">dimensionless</span>;
  return <span className="font-mono text-nb-ink">{unit}</span>;
}

export default function RoleSuccession() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);

  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // The successor chosen per stranded role. Nothing is ever seeded into it: an
  // entry exists only because a person clicked one.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<any>(null);
  // The orphan whose forget confirmation is open. It holds a key rather than a
  // boolean because the confirmation belongs to ONE assertion: selecting another
  // stranded role must not carry a pressed confirm across to it.
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [forgot, setForgot] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery<any>({
    queryKey: ["bi-role-orphans"],
    queryFn: () => bi.roleOrphans(),
  });

  const orphans: any[] = useMemo(() => q.data?.orphans ?? [], [q.data]);
  const graceMinutes: number = q.data?.grace_minutes ?? 15;
  const freshMinutes: number = q.data?.fresh_minutes ?? 15;
  const withCandidates: number =
    q.data?.with_candidates ?? orphans.filter((o) => (o.candidates || []).length).length;
  const withoutCandidates: number =
    q.data?.without_candidates ?? orphans.filter((o) => !(o.candidates || []).length).length;

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orphans.filter((o) => {
      const has = (o.candidates || []).length > 0;
      if (filter === "proposed" && !has) return false;
      if (filter === "none" && has) return false;
      if (!needle) return true;
      return `${o.role} ${o.device_tag ?? ""} ${o.point_tag ?? ""}`.toLowerCase().includes(needle);
    });
  }, [orphans, filter, search]);

  const selected = useMemo(
    () => orphans.find((o) => orphanKey(o) === selectedKey) || null,
    [orphans, selectedKey],
  );

  /** Every chosen move, as the request body, with the candidate it came from so
   *  a conflict can be named BEFORE it is posted. */
  const chosen = useMemo(
    () =>
      orphans
        .map((o) => {
          const to = choices[orphanKey(o)];
          if (!to) return null;
          const candidate = (o.candidates || []).find((c: any) => c.point_id === to);
          return { orphan: o, candidate };
        })
        .filter(Boolean) as { orphan: any; candidate: any }[],
    [orphans, choices],
  );

  // A successor that already carries a different role CANNOT take this one —
  // `point_roles` is keyed by the point. The server refuses it; this screen says
  // so before the press rather than reporting it afterwards as a failure.
  const conflicted = chosen.filter((c) => c.candidate?.conflicting_role);

  const repoint = useMutation({
    mutationFn: (moves: any[]) => bi.repointRoles({ moves }),
    onSuccess: (res: any) => {
      setErr(null);
      setForgot(null);
      setApplied(res);
      setChoices({});
      setSelectedKey(null);
      qc.invalidateQueries({ queryKey: ["bi-role-orphans"] });
      // Every metric that selects one of these roles was refusing `no_data`.
      qc.invalidateQueries({ queryKey: ["bi-metric-roles"] });
      qc.invalidateQueries({ queryKey: ["bi-summary"] });
    },
    onError: (e) => {
      setApplied(null);
      setErr(apiError(e, "Nothing was moved"));
    },
  });

  // The other write, and the only destructive one on this console. It takes ONE
  // point id, from the row that is open: there is no sweep here and there is no
  // request shape that could express one, because this deletes a human's
  // statement about what a number meant and nothing puts it back.
  const forget = useMutation({
    mutationFn: (pointIds: string[]) => bi.forgetRoles({ point_ids: pointIds }),
    onSuccess: (res: any) => {
      setErr(null);
      setApplied(null);
      setForgot(res);
      setConfirmForget(null);
      setSelectedKey(null);
      qc.invalidateQueries({ queryKey: ["bi-role-orphans"] });
      // One fewer assertion exists, so the roles table and the summary that
      // counts them are both stale.
      qc.invalidateQueries({ queryKey: ["bi-metric-roles"] });
      qc.invalidateQueries({ queryKey: ["bi-summary"] });
    },
    onError: (e) => {
      setForgot(null);
      setErr(apiError(e, "Nothing was forgotten"));
    },
  });

  function choose(o: any, pointId: string) {
    const key = orphanKey(o);
    setChoices((prev) => {
      const next = { ...prev };
      if (next[key] === pointId) delete next[key];
      else next[key] = pointId;
      return next;
    });
  }

  return (
    <ConsolePage>
      <SetupHeader
        task="roles"
        sub="Stranded roles"
        desc={
          <span title="A role says what a number MEANS. A gateway rebuild renames the tag it was bound to, and the assertion is left on a point that stopped reporting — so the metric above it refuses for a machine that is running. This is where an operator moves the assertion onto the point that replaced it. Nothing is ever moved automatically: the successors below are proposed with the evidence that ranked them, and only ids a person names are written. Where the point row is gone entirely there is nothing to move onto, and the one thing left to decide is whether to forget the assertion — which deletes it.">
            an operator&apos;s assertion, left on a point that stopped · nothing moves unless you
            name it
          </span>
        }
      />

      {applied && (
        <div className="mb-3 rounded-[12px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="text-nb-ink">
              {applied.requested} move(s) requested · {applied.moved} moved ·{" "}
              {applied.refused} refused
            </span>
            <span
              className="text-[10.5px] text-nb-faint"
              title="One transaction per move, so a batch can half-apply. Every outcome is listed below."
            >
              one transaction per move
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {(applied.results || []).map((r: any) => (
              <li
                key={`${r.role}:${r.from_point_id}`}
                className={`rounded-[8px] border px-2.5 py-1.5 text-[11px] ${
                  r.status === "moved"
                    ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.07)]"
                    : "border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.07)]"
                }`}
              >
                <span
                  className={`font-mono ${r.status === "moved" ? "text-nb-good" : "text-nb-crit"}`}
                >
                  {r.role}
                </span>{" "}
                {r.status === "moved" ? (
                  <span className="text-nb-soft">
                    moved on {r.device_tag} from{" "}
                    <span className="font-mono text-nb-ink">{r.from_point_tag}</span> to{" "}
                    <span className="font-mono text-nb-ink">{r.to_point_tag}</span>
                  </span>
                ) : (
                  <span className="text-nb-soft">refused — {r.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {forgot && (
        <div className="mb-3 rounded-[12px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="text-nb-ink">
              {forgot.requested} assertion(s) named · {forgot.forgotten} forgotten ·{" "}
              {forgot.refused} refused
            </span>
            <span
              className="text-[10.5px] text-nb-faint"
              title="Each forgotten assertion is echoed back below. That echo is the last place it exists — nothing on this platform holds another copy."
            >
              echoed back below — the last place it exists
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {(forgot.results || []).map((r: any) => (
              <li
                key={r.point_id}
                className={`rounded-[8px] border px-2.5 py-1.5 text-[11px] ${
                  r.status === "forgotten"
                    ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.07)]"
                    : "border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.07)]"
                }`}
              >
                <span
                  className={`font-mono ${
                    r.status === "forgotten" ? "text-nb-good" : "text-nb-crit"
                  }`}
                >
                  {r.role || r.point_id}
                </span>{" "}
                {r.status === "forgotten" ? (
                  <span className="text-nb-soft">
                    forgotten — asserted by {r.confirmed_by || "an operator"}
                    {r.confirmed_at ? ` ${fmtRelative(r.confirmed_at)}` : ""}
                    {r.role_source ? `, stated as ${r.role_source}` : ""}, on point{" "}
                    <span className="font-mono text-nb-ink">{r.point_id}</span>
                  </span>
                ) : (
                  <span className="text-nb-soft">refused — {r.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="mb-2 text-[11.5px] text-nb-crit">{err}</p>}

      <ConsoleGrid cols="xl:grid-cols-[25%_1fr]">
        {/* ── the worklist ────────────────────────────────────────── */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons:variable"
            title="Stranded roles"
            count={q.data?.total ?? ""}
          />
          {/* The counts ARE the filter: a number on this screen that nothing can
              act on would be a number nobody can do anything with. */}
          <div className="px-3 pb-2">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={FILTERS(withCandidates, withoutCandidates)}
            />
          </div>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search role, device or point…" />
          <PanelList
            loading={q.isLoading}
            error={q.error ? apiError(q.error, "Could not load the stranded roles") : null}
            empty={!shown.length}
            emptyText={
              orphans.length
                ? "No stranded role matches this view."
                : "No stranded role. Every assertion an operator made is on a point that is still reporting."
            }
          >
            {shown.map((o) => {
              const key = orphanKey(o);
              const on = key === selectedKey;
              const count = (o.candidates || []).length;
              const gone = subjectMissing(o);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  className={`w-full rounded-[10px] border px-3 py-2 text-left transition ${
                    on
                      ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
                      : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
                  }`}
                >
                  <div className="truncate font-mono text-[12px] text-nb-ink">{o.role}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-nb-soft">
                    {gone ? (
                      <span className="text-nb-faint">no point row left</span>
                    ) : (
                      <>
                        {o.device_tag ? `${o.device_tag} / ` : ""}
                        {o.point_tag}
                      </>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px]">
                    {count ? (
                      <span className="text-nb-blueb">
                        {count} successor(s) proposed
                      </span>
                    ) : (
                      <span className="text-nb-warn">nothing proposed</span>
                    )}
                    {choices[key] && <span className="text-nb-good">successor chosen</span>}
                  </div>
                </button>
              );
            })}
          </PanelList>
          <PanelFooter>
            {mayWrite ? (
              <div className="space-y-1.5">
                {chosen.length > 0 && (
                  <ActionButton
                    onClick={() =>
                      repoint.mutate(
                        chosen.map((c) => ({
                          role: c.orphan.role,
                          from_point_id: c.orphan.point_id,
                          to_point_id: c.candidate.point_id,
                        })),
                      )
                    }
                    disabled={repoint.isPending || conflicted.length > 0}
                  >
                    {repoint.isPending
                      ? "Moving…"
                      : `Move the ${chosen.length} role(s) you have chosen`}
                  </ActionButton>
                )}
                {conflicted.length > 0 && (
                  <Reason
                    className="text-[10.5px] leading-relaxed text-nb-warn"
                    text={`${conflicted.length} chosen successor(s) already carry a role, so those moves would be refused. Settle that role on the metric roles screen, or choose a different successor.`}
                  />
                )}
                <Reason
                  className="text-[10.5px] leading-relaxed text-nb-faint"
                  text="A move is written only for a successor you named. There is no sweep and no score above which this screen decides — a wrongly bound role computes a plausible answer nobody can see is wrong."
                />
              </div>
            ) : (
              <p
                className="text-[10.5px] leading-relaxed text-nb-faint"
                title="Moving a role needs bi.manage. You can read which assertions are stranded, what is proposed for them and the evidence behind it."
              >
                Moving a role needs <span className="font-mono">bi.manage</span>.
              </p>
            )}
          </PanelFooter>
        </ConsolePanel>

        {/* ── one stranded role ───────────────────────────────────── */}
        <ConsolePanel>
          {!selected ? (
            <EmptyPane
              icon="heroicons:variable"
              title="No stranded role selected"
              subtitle="Pick one to see who asserted it, why it is stranded, and which points on its device could carry it now"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <header className="mb-3">
                <h2 className="truncate font-mono text-base font-semibold text-nb-ink">
                  {selected.role}
                </h2>
                <p className="mt-0.5 font-mono text-[11.5px] text-nb-soft">
                  {subjectMissing(selected) ? (
                    <span className="text-nb-faint">
                      bound to point {selected.point_id}, which is no longer in the store
                    </span>
                  ) : (
                    <>
                      {selected.device_tag ? (
                        <span className="text-nb-soft">{selected.device_tag} / </span>
                      ) : (
                        <span className="text-nb-faint">no device recorded / </span>
                      )}
                      <span className="text-nb-ink">{selected.point_tag}</span>
                    </>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-nb-faint">
                  Asserted by {selected.confirmed_by || "an operator"}
                  {selected.confirmed_at ? ` ${fmtRelative(selected.confirmed_at)}` : ""}
                  {selected.role_source ? ` · stated as ${selected.role_source}` : ""} ·{" "}
                  <UnitCell unit={selected.unit} />
                </p>
              </header>

              <Reason
                className="mb-3 rounded-[10px] border border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.07)] px-3 py-2 text-[11.5px] leading-relaxed text-nb-warn"
                text={whyStranded(selected, graceMinutes)}
              />

              {selected.fresh === false && !subjectMissing(selected) && (
                <Reason
                  className="mb-3 text-[10.5px] leading-relaxed text-nb-faint"
                  text={`Nothing on this estate is inside the ${freshMinutes}-minute freshness window right now — ingest runs in cycles. That is why being stranded is measured against this device's own newest reading rather than against the clock.`}
                />
              )}

              {subjectMissing(selected) ? (
                <>
                  <Reason
                    className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-[11.5px] leading-relaxed text-nb-faint"
                    text="No successor can be offered: a successor is a point on the same device and there is no device left to read, so the only decision left about this assertion is whether to forget it — and that is the control below."
                  />

                  {/* THE ONE DESTRUCTIVE CONTROL ON THIS CONSOLE, and the only
                      thing that can reach a role whose point row is gone — a
                      repoint needs a successor on the same device and there is
                      no device. It names WHAT IT DELETES before it is pressed
                      rather than reporting it afterwards: the role, who asserted
                      it, when, and how they stated it. That is the same rule the
                      conflicting-successor warning follows, for a refusal that
                      can be taken back; this one cannot. */}
                  {mayWrite ? (
                    <div className="mt-3 rounded-[10px] border border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.07)] px-3 py-2.5">
                      <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[1px] text-nb-crit">
                        <Icon icon="heroicons:exclamation-triangle" className="text-[13px]" />
                        Forgetting deletes an operator&apos;s assertion
                      </p>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-nb-soft">
                        This deletes{" "}
                        <span className="font-mono text-nb-ink">{selected.role}</span>, asserted by{" "}
                        <span className="font-mono text-nb-ink">
                          {selected.confirmed_by || "an operator"}
                        </span>
                        {selected.confirmed_at
                          ? ` ${fmtRelative(selected.confirmed_at)}`
                          : " at a time nobody recorded"}
                        {selected.role_source ? `, stated as ${selected.role_source}` : ""}, on
                        point <span className="font-mono text-nb-ink">{selected.point_id}</span>.
                        Nothing puts it back.
                      </p>
                      {confirmForget === orphanKey(selected) ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <DangerButton
                            onClick={() => forget.mutate([selected.point_id])}
                            disabled={forget.isPending}
                          >
                            {forget.isPending
                              ? "Forgetting…"
                              : `Yes — forget ${selected.role} permanently`}
                          </DangerButton>
                          <QuietButton onClick={() => setConfirmForget(null)}>
                            Keep the assertion
                          </QuietButton>
                        </div>
                      ) : (
                        <div className="mt-2">
                          <DangerButton onClick={() => setConfirmForget(orphanKey(selected))}>
                            Forget this assertion…
                          </DangerButton>
                        </div>
                      )}
                      <Reason
                        className="mt-2 text-[10.5px] leading-relaxed text-nb-faint"
                        text="Only this one is forgotten: there is no sweep and no way to ask for one, and no self-heal writes a role back. If the point is back in the store this is refused rather than applied — moving a live binding is a repoint and clearing one is an unbind, and both are different decisions about a measurement that is still there."
                      />
                    </div>
                  ) : (
                    <p
                      className="mt-3 text-[10.5px] leading-relaxed text-nb-faint"
                      title="Forgetting an assertion needs bi.manage. You can read what was asserted, by whom and when; deleting it is the same authority as moving one."
                    >
                      Forgetting an assertion needs <span className="font-mono">bi.manage</span>.
                    </p>
                  )}
                </>
              ) : (selected.candidates || []).length === 0 ? (
                <Reason
                  className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-[11.5px] leading-relaxed text-nb-faint"
                  text={noCandidateReason(selected)}
                />
              ) : (
                <>
                  <Reason
                    className="mb-2 text-[11px] leading-relaxed text-nb-faint"
                    text={
                      ((selected.candidates || []).length === 1
                        ? "This is the only credible candidate on the device, which makes it the only one offered — not evidence that it is the right one. Read its tag against the device above before you move anything: a gateway typo and a second machine look identical from here. "
                        : "") +
                      `${(selected.candidates || []).length} of ${selected.candidates_considered ?? 0} point(s) looked at carried credible evidence. ` +
                      "The score is an ORDER — the things worth reading, most promising first — not a probability and not a decision, so nothing is pre-selected however far ahead it is."
                    }
                  />
                  <ul className="space-y-2">
                    {(selected.candidates || []).map((c: any) => {
                      const picked = choices[orphanKey(selected)] === c.point_id;
                      return (
                        <li
                          key={c.point_id}
                          className={`rounded-[10px] border px-3 py-2.5 transition ${
                            picked
                              ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
                              : "border-nb-line bg-[rgba(6,11,26,.5)]"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => mayWrite && choose(selected, c.point_id)}
                            disabled={!mayWrite}
                            className="flex w-full items-center gap-2 text-left disabled:cursor-default"
                          >
                            <Icon
                              icon={picked ? "heroicons:check-circle-solid" : "heroicons:stop"}
                              className={`text-[14px] ${picked ? "text-nb-blueb" : "text-nb-faint"}`}
                            />
                            <span className="font-mono text-[12px] text-nb-ink">{c.point_tag}</span>
                            <span className="font-mono text-[10.5px]">
                              <UnitCell unit={c.unit} />
                            </span>
                            <span className="font-mono text-[10.5px] text-nb-faint">
                              last value {c.last_seen_at ? fmtRelative(c.last_seen_at) : "never"}
                            </span>
                            <span className="flex-1" />
                            <span className="font-mono text-[10.5px] text-nb-soft">
                              rank score {c.score}
                            </span>
                          </button>

                          {/* THE EVIDENCE, not a bar. The server wrote a sentence
                              per signal so an operator can check the reason
                              rather than trust the number that came out of it. */}
                          <ul className="mt-2 space-y-1">
                            {(c.evidence || []).map((e: any) => (
                              <li
                                key={`${c.point_id}:${e.kind}`}
                                className="rounded-[8px] border border-nb-line/60 bg-[rgba(10,18,40,.5)] px-2.5 py-1.5"
                              >
                                <span className="text-[10.5px] font-semibold uppercase tracking-[1px] text-nb-muted">
                                  {EVIDENCE_LABEL[e.kind] || e.kind}
                                </span>
                                <span className="ml-2 font-mono text-[10.5px] text-nb-faint">
                                  +{e.weight}
                                </span>
                                <p className="mt-0.5 text-[11px] leading-relaxed text-nb-soft">
                                  {e.detail}
                                </p>
                              </li>
                            ))}
                          </ul>

                          {c.conflicting_role && (
                            <p
                              className="mt-2 flex flex-wrap items-baseline gap-x-1.5 rounded-[8px] border border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.07)] px-2.5 py-1.5 text-[11px] leading-relaxed text-nb-crit"
                              title={`This point already carries ${c.conflicting_role}. A move onto it will be refused and nothing will be written: a point carries one role, so one of the two assertions would have to go, and both are an operator's.`}
                            >
                              <span>
                                A move onto it will be refused and nothing will be written — this
                                point already carries{" "}
                                <span className="font-mono">{c.conflicting_role}</span>
                              </span>
                              <Link href={taskHref("roles")} className="underline">
                                Settle it on the metric roles screen →
                              </Link>
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <Reason
                    className="mt-2 text-[10.5px] leading-relaxed text-nb-faint"
                    text={
                      (mayWrite && chosen.length > 0
                        ? "The move is applied from the button under the worklist. "
                        : "") +
                      "Moving records the successor on the stranded point and carries the role across — the same continuity chain a duplicate collapse writes. It retires nothing: the renamed generation stops being counted on its own, and retiring it here would be a second decision nobody asked for."
                    }
                  />
                </>
              )}
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
