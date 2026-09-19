"use client";

// UNITS, one question at a time — the same shape as Duplicates, so an operator
// learns one way of working for the whole of Setup.
//
// THE PLATFORM DOES THE LOOKING. Every point's last known reading is checked
// against its unit's plausible range (`unitAsk.ts`). Kinds where every reading
// fits are offered together in one press; a reading that does not fit is held
// back and asked about by itself. Nothing is stored until a person presses —
// the automation is in what they no longer have to check, not in who decides.
//
// Copy rule, from the Duplicates cut: one progress line, the question as the
// heading, one line of why, the readings as the biggest thing on the screen.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { bi } from "../../api";
import { PERM_MANAGE } from "../../constants";
import {
  RANGES,
  reading,
  unitWord,
  type Catalogue,
  type PointQ,
  type Question,
  type UnitPoint,
} from "./unitAsk";
import { questionsOf } from "./unitAsk";

const EASE = [0.22, 1, 0.36, 1] as const;

/** A confirm refused because some of the points have stopped reporting. The
 *  server asks for that to be said out loud, so the screen asks the person. */
const NOT_REPORTING = "POINT_NOT_REPORTING";
const codeOf = (e: unknown): string | undefined =>
  (e as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code;

/** One press. Usually one batch; "accept all" is one batch per unit, saved in
 *  order, and taken back together — one press, one undo. */
interface Write {
  batches: { point_ids: string[]; unit: string | null }[];
  said: string;
  acknowledge_not_reporting?: boolean;
  /** Filled by the dry run: the points that have stopped reporting. */
  quiet?: { device_tag?: string | null; point_tag?: string | null }[];
}

/** Thrown BEFORE anything is written, when the dry run finds quiet points. */
class QuietPoints extends Error {
  constructor(readonly points: NonNullable<Write["quiet"]>) {
    super("some points have stopped reporting");
  }
}

/** Thrown when a later batch fails after earlier ones were saved: the saved
 *  part is carried so the screen can say so and offer to take it back. */
class PartlySaved extends Error {
  constructor(readonly saved: Write["batches"], readonly cause: unknown) {
    super("partly saved");
  }
}

export default function UnitsWizard({
  catalogue,
  onRestart,
}: Readonly<{ catalogue: Catalogue; onRestart: () => void }>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);
  const still = !!useReducedMotion();

  const [skipped, setSkipped] = useState<string[]>([]);
  const [declined, setDeclined] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [quiet, setQuiet] = useState<Write | null>(null);
  const [last, setLast] = useState<Write | null>(null);

  const all = useMemo(() => questionsOf(catalogue, declined), [catalogue, declined]);
  const queue = useMemo(() => all.filter((q) => !skipped.includes(q.key)), [all, skipped]);
  const q: Question | undefined = queue[0];

  // Fixed when the round starts: an answered question leaves the catalogue on
  // the next read, and counting against the live list would never move the bar.
  const [total] = useState(() => Math.max(all.length, 1));
  const done = Math.max(0, Math.min(total - queue.length, total));

  const write = useMutation({
    mutationFn: async (w: Write) => {
      // ASK ONCE, BEFORE WRITING ANYTHING. Each batch used to be written in turn,
      // so "accept all" could save its first kind and then stop on the second
      // with a "stopped reporting" question — leaving the first saved whether
      // the operator answered yes or cancel. The dry run writes nothing.
      if (!w.acknowledge_not_reporting && w.batches.some((b) => b.unit !== null)) {
        const quiet: NonNullable<Write["quiet"]> = [];
        for (const b of w.batches) {
          if (b.unit === null) continue;
          const r: any = await bi.confirmUnits({ point_ids: b.point_ids, unit: b.unit, dry_run: true });
          quiet.push(...((r?.confirmed_not_reporting as NonNullable<Write["quiet"]>) ?? []));
        }
        if (quiet.length) throw new QuietPoints(quiet);
      }
      const saved: Write["batches"] = [];
      for (const b of w.batches) {
        try {
          await bi.confirmUnits({
            point_ids: b.point_ids,
            unit: b.unit,
            acknowledge_not_reporting: w.acknowledge_not_reporting,
          });
        } catch (e) {
          if (saved.length) throw new PartlySaved(saved, e);
          throw e;
        }
        saved.push(b);
      }
    },
    onSuccess: (_res, w) => {
      setErr(null);
      setQuiet(null);
      setLast(w.batches.every((b) => b.unit === null) ? null : w);
      qc.invalidateQueries({ queryKey: ["bi-unit-patterns"] });
      qc.invalidateQueries({ queryKey: ["bi-units"] });
      qc.invalidateQueries({ queryKey: ["bi-summary"] });
    },
    onError: (e, w) => {
      if (e instanceof QuietPoints) {
        setErr(null);
        setQuiet({ ...w, quiet: e.points });
        return;
      }
      // The server's own refusal, should the dry run have raced a point going
      // quiet: same question, nothing was written.
      if (codeOf(e) === NOT_REPORTING && !w.acknowledge_not_reporting) {
        setErr(null);
        setQuiet(w);
        return;
      }
      if (e instanceof PartlySaved) {
        const n = e.saved.reduce((k, b) => k + b.point_ids.length, 0);
        setLast({ batches: e.saved, said: `${n} of them, before the rest failed` });
        setErr(apiError(e.cause, "The rest was not saved"));
        qc.invalidateQueries({ queryKey: ["bi-unit-patterns"] });
        return;
      }
      setErr(apiError(e, "Nothing was saved"));
    },
  });

  const say = useCallback<Say>(
    (batches, said) => {
      const real = batches.filter((b) => b.point_ids.length);
      if (!real.length || write.isPending) return;
      write.mutate({ batches: real, said });
    },
    [write],
  );

  const skip = useCallback(() => {
    if (!q) return;
    setQuiet(null);
    if (q.type === "accept_all") setDeclined((d) => [...d, q.key]);
    else setSkipped((s) => [...s, q.key]);
  }, [q]);

  const primary = useMemo(() => (q ? primaryOf(q) : null), [q]);

  // Y answers with the highlighted press, 1–9 picks a choice, S skips.
  useEffect(() => {
    if (!q || !mayWrite) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const k = e.key.toUpperCase();
      if (k === "S") {
        e.preventDefault();
        skip();
      } else if (k === "Y" && primary) {
        e.preventDefault();
        primary.run(say);
      } else if (q.type === "point" && /^[1-9]$/.test(k)) {
        const c = q.choices[Number(k) - 1];
        if (c) {
          e.preventDefault();
          say([{ point_ids: [q.point.point_id], unit: c.unit }], `${q.point.point_tag} as ${unitWord(c.unit)}`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, mayWrite, primary, say, skip]);

  // NEVER SAY "DONE" OVER THE SERVER'S OWN COUNT. When the catalogue reports
  // numbers still without a unit but no question could be built from it — the
  // readings did not come back, e.g. a reading-writer older than this screen —
  // the walk is empty because it is BLIND, not because the work is finished.
  // This once printed "Every number has a unit" over 422 open points.
  const open = (catalogue.totals.eligible ?? 0) + (catalogue.totals.unmatched ?? 0);
  if (!q && !skipped.length && all.length === 0 && open > 0) {
    return (
      <div className="mx-auto w-full max-w-[980px] py-16 text-center">
        <Icon icon="heroicons:exclamation-triangle" className="mx-auto text-[30px] text-nb-warn" />
        <p className="mt-3 text-[16px] font-semibold text-nb-ink">{open} numbers still have no unit</p>
        <p className="mx-auto mt-1 max-w-[60ch] text-[13px] text-nb-muted">
          Their readings did not come back, so this screen cannot check them or ask about them. Nothing has been
          saved.
        </p>
      </div>
    );
  }

  if (!q) {
    const left = skipped.length;
    return (
      <div className="mx-auto w-full max-w-[980px] py-16 text-center">
        <Icon
          icon={left ? "heroicons-outline:arrow-path" : "heroicons-outline:check-circle"}
          className={`mx-auto text-[30px] ${left ? "text-nb-muted" : "text-nb-good"}`}
        />
        <p className="mt-3 text-[16px] font-semibold text-nb-ink">
          {left ? `${left} skipped` : "Every number has a unit"}
        </p>
        <p className="mt-1 text-[13px] text-nb-muted">
          {left
            ? "Metrics that read them still refuse until someone decides."
            : `${catalogue.totals.already_confirmed} confirmed by a person.`}
        </p>
        {left > 0 && (
          <button
            type="button"
            onClick={onRestart}
            className="mt-4 h-10 rounded-[9px] border border-nb-blue/40 px-4 text-[13px] text-nb-blueb transition hover:bg-nb-blue hover:text-white"
          >
            Go through them again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-7 pt-1">
      <div className="flex items-center gap-4">
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-nb-muted">
          {Math.min(done + 1, total)} of {total}
        </span>
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[.06]">
          <motion.div
            className="h-full rounded-full bg-nb-blue"
            initial={false}
            animate={{ width: `${(done / total) * 100}%` }}
            transition={still ? { duration: 0 } : { duration: 0.5, ease: EASE }}
          />
        </div>
      </div>

      {/* What was just saved, with the way back. A unit typed wrong corrupts
          every rating computed from it, so taking it back is one press. */}
      <AnimatePresence>
        {last && (
          <motion.div
            key={last.said}
            initial={still ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-3 text-[12.5px] text-nb-good"
          >
            <Icon icon="heroicons-outline:check" className="text-[14px]" />
            <span>Saved: {last.said}</span>
            <button
              type="button"
              onClick={() =>
                write.mutate({
                  batches: [{ point_ids: last.batches.flatMap((b) => b.point_ids), unit: null }],
                  said: "undo",
                })
              }
              className="text-nb-muted underline-offset-2 hover:text-nb-ink hover:underline"
            >
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {err && (
        <p className="rounded-[10px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)] px-4 py-2.5 text-[12.5px] text-nb-crit">
          {err}
        </p>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={q.key}
          initial={still ? false : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={still ? { opacity: 1 } : { opacity: 0, x: -24 }}
          transition={still ? { duration: 0 } : { duration: 0.28, ease: EASE }}
          className="flex flex-col gap-6"
        >
          {q.type === "accept_all" && <AcceptAll q={q} still={still} />}
          {q.type === "kind" && <Kind q={q} />}
          {q.type === "state" && <State q={q} />}
          {q.type === "point" && <Point q={q} />}

          {quiet && (
            <div className="rounded-[12px] border border-nb-warn/35 bg-nb-warn/[.05] px-5 py-4">
              <p className="text-[13px] text-nb-ink">
                {quiet.quiet?.length
                  ? `${quiet.quiet.length} of these ${quiet.batches.reduce((k, b) => k + b.point_ids.length, 0)} have stopped reporting.`
                  : "Some of these have stopped reporting."}{" "}
                <span className="text-nb-muted">Nothing has been saved yet.</span>
              </p>
              {quiet.quiet?.length ? (
                <p className="mt-1 truncate font-mono text-[11.5px] text-nb-faint">
                  {quiet.quiet
                    .slice(0, 4)
                    .map((p) => p.point_tag)
                    .join(" · ")}
                  {quiet.quiet.length > 4 ? ` · +${quiet.quiet.length - 4} more` : ""}
                </p>
              ) : null}
              <p className="mt-1 text-[12.5px] text-nb-muted">
                A unit on a quiet point is still your statement about it. Save all of them anyway?
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={write.isPending}
                  onClick={() => write.mutate({ ...quiet, acknowledge_not_reporting: true })}
                  className="h-9 rounded-[8px] border border-nb-blue/45 px-4 text-[12.5px] text-nb-blueb transition hover:bg-nb-blue hover:text-white disabled:opacity-50"
                >
                  {write.isPending ? "Saving…" : "Save anyway"}
                </button>
                <button
                  type="button"
                  onClick={() => setQuiet(null)}
                  className="h-9 rounded-[8px] px-4 text-[12.5px] text-nb-muted hover:text-nb-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mayWrite && !quiet && <Actions q={q} busy={write.isPending} say={say} />}
        </motion.section>
      </AnimatePresence>

      <div className="flex items-center justify-between gap-4 border-t border-white/[.06] pt-4">
        <button type="button" onClick={skip} className="text-[13px] text-nb-muted transition hover:text-nb-ink">
          {q.type === "accept_all" ? "Go through them one by one" : "Not sure? Skip this one"}
        </button>
        {mayWrite ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-nb-faint">
            {q.type === "point" ? (
              <>
                <Key>1</Key>–<Key>{String(q.choices.length > 9 ? 9 : q.choices.length)}</Key>
                <span className="mr-2">choose</span>
              </>
            ) : (
              <>
                <Key>Y</Key>
                <span className="mr-2">yes</span>
              </>
            )}
            <Key>S</Key>
            <span>skip</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-nb-faint">
            Answering needs <span className="font-mono">{PERM_MANAGE}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ── the questions ────────────────────────────────────────────────────────────

type Say = (batches: { point_ids: string[]; unit: string }[], said: string) => void;

/** The press Y stands for on each kind of question. */
function primaryOf(q: Question): { label: string; run: (say: Say) => void } | null {
  if (q.type === "accept_all") {
    return {
      label: `Accept all ${q.kinds.length}`,
      run: (say) =>
        say(
          q.kinds.map((k) => ({ point_ids: k.points.map((p) => p.point_id), unit: k.pattern.unit as string })),
          `${q.total} numbers across ${q.kinds.length} kinds`,
        ),
    };
  }
  if (q.type === "kind") {
    const ok = q.checked.fits;
    if (!ok.length) return null;
    return {
      label: ok.length === q.all.length ? `Yes, all ${ok.length} are ${unitWord(q.unit)}` : `Save the ${ok.length} that read like ${unitWord(q.unit)}`,
      run: (say) => say([{ point_ids: ok.map((p) => p.point_id), unit: q.unit }], `${ok.length} as ${unitWord(q.unit)}`),
    };
  }
  if (q.type === "state") {
    return {
      label: `Yes, mark all ${q.all.length} as no unit`,
      run: (say) => say([{ point_ids: q.all.map((p) => p.point_id), unit: "" }], `${q.all.length} switches as no unit`),
    };
  }
  return null;
}

function AcceptAll({ q, still }: Readonly<{ q: Extract<Question, { type: "accept_all" }>; still: boolean }>) {
  return (
    <div>
      <h2 className="text-[22px] font-medium tracking-[-.2px] text-nb-ink">
        {q.total} numbers already read exactly like their unit
      </h2>
      <p className="mt-2 text-[13.5px] leading-[1.6] text-nb-muted">
        The platform checked every one of their latest readings. Accept these {q.kinds.length} kinds together, or
        go through them one by one.
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {q.kinds.map((k, i) => (
          <motion.li
            key={k.pattern.key}
            initial={still ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={still ? { duration: 0 } : { duration: 0.25, delay: 0.04 * i, ease: EASE }}
            className="flex items-baseline justify-between gap-3 rounded-[10px] border border-white/[.07] px-4 py-3"
          >
            <span className="text-[13px] text-nb-soft">{k.pattern.label}</span>
            <span className="text-[12px] tabular-nums text-nb-muted">
              {k.points.length} · <span className="text-nb-blueb">{unitWord(k.pattern.unit)}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function Samples({ points, unit }: Readonly<{ points: UnitPoint[]; unit?: string | null }>) {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      {points.slice(0, 3).map((p) => (
        <div key={p.point_id} className="rounded-[10px] border border-white/[.07] px-4 py-3.5">
          <div className="truncate font-mono text-[11.5px] text-nb-muted" title={p.point_tag ?? ""}>
            {p.point_tag}
          </div>
          <div className="mt-1.5 text-[22px] font-semibold tabular-nums tracking-[-.3px] text-nb-ink">
            {reading(p.value)}
            {unit != null && p.value != null && (
              <span className="ml-1.5 text-[13px] font-normal text-nb-muted">{unit === "" ? "" : unit}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Kind({ q }: Readonly<{ q: Extract<Question, { type: "kind" }> }>) {
  const { fits, outside, unread } = q.checked;
  const range = RANGES[q.unit];
  const shown = outside.length ? outside : fits.length ? fits : unread;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[22px] font-medium tracking-[-.2px] text-nb-ink">
          Are these {q.all.length} numbers in {unitWord(q.unit)}?
        </h2>
        <p className="mt-2 text-[13.5px] text-nb-muted">
          {q.pattern.label}. {range ? `A reading in ${unitWord(q.unit)} is ${range.says}.` : ""}
        </p>
      </div>
      <Samples points={shown} unit={outside.length ? null : q.unit} />
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
        {fits.length > 0 && <span className="text-nb-good">{fits.length} read like {unitWord(q.unit)}</span>}
        {outside.length > 0 && (
          <span className="text-nb-warn">
            {outside.length} {outside.length === 1 ? "does" : "do"} not — shown above
          </span>
        )}
        {unread.length > 0 && <span className="text-nb-muted">{unread.length} have read nothing this month</span>}
      </div>
    </div>
  );
}

function State({ q }: Readonly<{ q: Extract<Question, { type: "state" }> }>) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[22px] font-medium tracking-[-.2px] text-nb-ink">
          These {q.all.length} are switches, not measurements
        </h2>
        <p className="mt-2 text-[13.5px] text-nb-muted">
          {q.pattern.label}. A switch reads on or off, so it has no unit.
        </p>
      </div>
      <Samples points={q.all} />
    </div>
  );
}

function Point({ q }: Readonly<{ q: PointQ }>) {
  const p = q.point;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-mono text-[20px] font-medium text-nb-ink">{p.point_tag}</h2>
        <p className="mt-1 text-[13px] text-nb-muted">{p.device_tag}</p>
        <p className="mt-3 text-[13.5px] text-nb-soft">
          {q.pattern ? `${q.pattern.label}. What does it measure?` : "No naming convention matches this one. What does it measure?"}
        </p>
      </div>
      <div className="flex items-center gap-7 rounded-[12px] border border-white/[.07] px-6 py-5">
        <div>
          <div className="text-[12px] text-nb-muted">Latest reading</div>
          <div className="mt-1 text-[34px] font-semibold tabular-nums tracking-[-.5px] text-nb-ink">
            {reading(p.value)}
          </div>
        </div>
        {q.choices.some((c) => c.hint) && (
          <>
            <div className="w-px self-stretch bg-white/[.07]" />
            <ul className="flex flex-col gap-1.5 text-[12.5px] text-nb-muted">
              {q.choices
                .filter((c) => c.hint)
                .map((c) => (
                  <li key={c.unit}>
                    <span className="text-nb-soft">{unitWord(c.unit)}:</span> {c.hint}
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Actions({ q, busy, say }: Readonly<{ q: Question; busy: boolean; say: Say }>) {
  if (q.type === "point") {
    return (
      <div className="flex flex-wrap gap-2">
        {q.choices.map((c, i) => (
          <button
            key={c.unit}
            type="button"
            disabled={busy}
            onClick={() => say([{ point_ids: [q.point.point_id], unit: c.unit }], `${q.point.point_tag} as ${unitWord(c.unit)}`)}
            className="flex h-10 items-center gap-2 rounded-[9px] border border-nb-blue/40 px-4 text-[13px] text-nb-blueb transition hover:bg-nb-blue hover:text-white disabled:opacity-50"
          >
            {i < 9 && <span className="font-mono text-[10.5px] opacity-60">{i + 1}</span>}
            {c.says}
          </button>
        ))}
      </div>
    );
  }
  const p = primaryOf(q);
  const everyone =
    q.type === "kind" && q.checked.fits.length < q.all.length ? q.all : null;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {p && (
        <button
          type="button"
          disabled={busy}
          onClick={() => p.run(say)}
          className="h-10 rounded-[9px] bg-nb-blue px-5 text-[13px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-50"
        >
          {busy ? "Saving…" : p.label}
        </button>
      )}
      {everyone && q.type === "kind" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => say([{ point_ids: everyone.map((x) => x.point_id), unit: q.unit }], `${everyone.length} as ${unitWord(q.unit)}`)}
          className="h-10 rounded-[9px] border border-white/[.14] px-4 text-[13px] text-nb-soft transition hover:border-nb-blue/50 hover:text-nb-ink disabled:opacity-50"
        >
          All {everyone.length} are {unitWord(q.unit)} anyway
        </button>
      )}
    </div>
  );
}

function Key({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <kbd className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-white/10 bg-white/[.03] px-1 font-mono text-[10.5px] text-nb-muted">
      {children}
    </kbd>
  );
}
