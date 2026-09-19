"use client";

// DUPLICATES, one question at a time.
//
// 45 groups is 45 decisions, and a table of 45 rows asks an operator to hold
// the whole queue in their head before answering any of it. So this asks ONE:
// the sensor, its copies side by side, and what each one carries. Answer, and
// the next slides in. It is the ONLY way this screen is worked — a second,
// list-shaped UI for the same job was one UI too many.
//
// LESS ON THE SCREEN, NOT MORE. An earlier cut stacked seven layers of text —
// a title, a subtitle, a progress heading, an info box, an eyebrow, the
// question, an explainer and a footer strip — and said "nothing is deleted"
// three times. It read as generated. Now: one progress line, the sensor's own
// name as the heading, ONE sentence of why, and two cards whose difference is
// the biggest thing on them. The copy is an operator's — COPIES are KEPT or
// ARCHIVED — and nothing is said twice.
//
// IT RECOMMENDS NOTHING. `askable.ts` says why: a gateway is sometimes rebuilt
// because a sensor was REPLACED, and then the young copy is the real one. The
// cards show what is true of each — how long it ran, how much it holds, where
// it sits in time — and the person decides.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { iot } from "@/features/iot/api";

import { bi } from "../api";
import { PERM_MANAGE } from "../constants";
import { daysLabel, readingsLabel, type Choice, type Question } from "./askable";

/** Deleting a point destroys its readings in both systems, so it takes the
 *  gateway's own key as well as BI's. */
export const PERM_DELETE = "iot.manage";

const EASE = [0.22, 1, 0.36, 1] as const;

/** "5 Sept", or "11 Sept, 09:02" when the copy lived inside one day and the
 *  hour is the only thing that tells two copies apart. */
function when(iso: string | null, withTime = false): string {
  if (!iso) return "not known";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not known";
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (!withTime) return day;
  return `${day}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export default function DuplicateWizard({
  questions,
  freshMinutes,
  onRestart,
  onSettled,
}: Readonly<{
  questions: Question[];
  freshMinutes: number;
  /** Start the walk again over what is still open — the skipped ones. */
  onRestart: () => void;
  onSettled: (msg: string) => void;
}>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);
  const mayDelete = can(PERM_DELETE) && can(PERM_MANAGE);
  const still = !!useReducedMotion();

  const [skipped, setSkipped] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Choice | null>(null);

  // An answered question leaves the list on the next read, so the walk is over
  // the REMAINING queue, never a fixed index.
  const queue = useMemo(
    () => questions.filter((q) => !skipped.includes(q.key)),
    [questions, skipped],
  );
  const q: Question | undefined = queue[0];
  // The denominator is fixed when the round starts. A kept question LEAVES the
  // server's list on the next read, so counting against the live list would
  // shrink the total with every answer and the bar would never move.
  const [total] = useState(() => Math.max(questions.length, 1));
  const done = Math.max(0, Math.min(total - queue.length, total));

  const keep = useMutation({
    mutationFn: (survivor: string) =>
      bi.collapseGhosts({
        groups: [{ device_tag: q!.device_tag, point_tag: q!.point_tag, survivor_point_id: survivor }],
      }),
    onSuccess: (res: any) => {
      setErr(null);
      onSettled(
        `Kept 1 copy · ${res.points_retired} archived` +
          (res.roles_migrated ? ` · ${res.roles_migrated} metric link moved across` : ""),
      );
      qc.invalidateQueries({ queryKey: ["bi-ghosts"] });
      qc.invalidateQueries({ queryKey: ["bi-summary"] });
    },
    onError: (e) => setErr(apiError(e, "Nothing was changed")),
  });

  const destroy = useMutation({
    mutationFn: (pointId: string) => iot.points.remove(pointId),
    onSuccess: (res: any) => {
      setErr(null);
      setConfirmDelete(null);
      onSettled(
        `Copy deleted everywhere · ${(res.readings_deleted ?? 0).toLocaleString("en-GB")} readings destroyed`,
      );
      qc.invalidateQueries({ queryKey: ["bi-ghosts"] });
    },
    onError: (e) => setErr(apiError(e, "Nothing was deleted")),
  });

  const skip = useCallback(() => {
    if (!q) return;
    setConfirmDelete(null);
    setSkipped((s) => [...s, q.key]);
  }, [q]);

  // A, B, C… keep; S skips. A queue of 45 is a keyboard job.
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
        return;
      }
      const hit = q.choices.find((c) => c.letter === k);
      if (hit && !keep.isPending) {
        e.preventDefault();
        keep.mutate(hit.point_id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, mayWrite, keep, skip]);

  if (!q) {
    // Skipped questions are not lost: they are still open on the server, and
    // the next round asks them again.
    const left = skipped.length;
    return (
      <div className="mx-auto w-full max-w-[980px] py-16 text-center">
        <Icon
          icon={left ? "heroicons-outline:arrow-path" : "heroicons-outline:check-circle"}
          className={`mx-auto text-[30px] ${left ? "text-nb-muted" : "text-nb-good"}`}
        />
        <p className="mt-3 text-[16px] font-semibold text-nb-ink">
          {left ? `${left} skipped` : "Nothing left to decide"}
        </p>
        <p className="mt-1 text-[13px] text-nb-muted">
          {left
            ? "They are still counted twice until someone decides."
            : "Every sensor has one copy marked as the real one."}
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

  const pct = (done / total) * 100;
  const withTime = q.choices.some((c) => c.days === 0);

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-7 pt-1">
      {/* progress — one line */}
      <div className="flex items-center gap-4">
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-nb-muted">
          {Math.min(done + 1, total)} of {total}
        </span>
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[.06]">
          <motion.div
            className="h-full rounded-full bg-nb-blue"
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={still ? { duration: 0 } : { duration: 0.5, ease: EASE }}
          />
        </div>
      </div>

      {err && (
        <p className="rounded-[10px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)] px-4 py-2.5 text-[12.5px] text-nb-crit">
          {err}
        </p>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={q.key}
          aria-label={`${q.device_tag} ${q.point_tag}`}
          initial={still ? false : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={still ? { opacity: 1 } : { opacity: 0, x: -24 }}
          transition={still ? { duration: 0 } : { duration: 0.28, ease: EASE }}
          className="flex flex-col gap-6"
        >
          {/* the sensor is the heading */}
          <div>
            <h2 className="font-mono text-[22px] font-medium tracking-[-.2px] text-nb-ink">
              {q.point_tag}
            </h2>
            <p className="mt-1 text-[13px] text-nb-muted">
              {q.device_tag}
              {q.category ? <span className="text-nb-faint"> · {q.category}</span> : null}
            </p>
            <p className="mt-4 text-[14px] leading-[1.6] text-nb-soft">
              {q.because === "none_live"
                ? `Neither copy has reported in the last ${freshMinutes} minutes. Which one was the real sensor?`
                : "More than one copy is reporting right now. Which one is the real sensor?"}
            </p>
            <p className="mt-1 text-[12.5px] leading-[1.6] text-nb-faint">
              A gateway rebuild saves a new copy of every sensor. Keep the real one — the others are
              archived with their readings, and you can undo it.
            </p>
          </div>

          {/* the copies */}
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${Math.min(q.choices.length, 3)}, minmax(0, 1fr))` }}
          >
            {q.choices.map((c, i) => (
              <CopyCard
                key={c.point_id}
                choice={c}
                index={i}
                still={still}
                withTime={withTime}
                mayWrite={mayWrite}
                busy={keep.isPending}
                onKeep={() => keep.mutate(c.point_id)}
                onDelete={mayDelete ? () => setConfirmDelete(c) : undefined}
              />
            ))}
          </div>

          <AnimatePresence>
            {confirmDelete && (
              <DeleteConfirm
                choice={confirmDelete}
                busy={destroy.isPending}
                still={still}
                onCancel={() => setConfirmDelete(null)}
                onConfirm={() => destroy.mutate(confirmDelete.point_id)}
              />
            )}
          </AnimatePresence>
        </motion.section>
      </AnimatePresence>

      {/* the way out, and the keys — one line */}
      <div className="flex items-center justify-between gap-4 border-t border-white/[.06] pt-4">
        <button
          type="button"
          onClick={skip}
          className="text-[13px] text-nb-muted transition hover:text-nb-ink"
        >
          Not sure? Skip this one
        </button>
        {mayWrite ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-nb-faint">
            {q.choices.map((c) => (
              <Key key={c.letter}>{c.letter}</Key>
            ))}
            <span className="mr-2">keep</span>
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

function Key({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <kbd className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-white/10 bg-white/[.03] px-1 font-mono text-[10.5px] text-nb-muted">
      {children}
    </kbd>
  );
}

function CopyCard({
  choice,
  index,
  still,
  withTime,
  mayWrite,
  busy,
  onKeep,
  onDelete,
}: Readonly<{
  choice: Choice;
  index: number;
  still: boolean;
  withTime: boolean;
  mayWrite: boolean;
  busy: boolean;
  onKeep: () => void;
  onDelete?: () => void;
}>) {
  const c = choice;
  return (
    <motion.article
      aria-label={`Copy ${c.letter}`}
      initial={still ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={still ? { duration: 0 } : { duration: 0.3, delay: 0.05 + index * 0.06, ease: EASE }}
      className="group flex flex-col rounded-[12px] border border-white/[.08] bg-white/[.02] p-5 transition-colors hover:border-nb-blue/40"
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-nb-muted">Copy {c.letter}</span>
        {c.live ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-nb-good">
            <span className="h-1.5 w-1.5 rounded-full bg-nb-good" />
            reporting now
          </span>
        ) : null}
      </div>

      {/* the difference, as the biggest thing on the card */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[28px] font-semibold leading-none tracking-[-.5px] tabular-nums text-nb-ink">
          {daysLabel(c.days)}
        </span>
        {c.mostHistory && <span className="text-[11.5px] text-nb-blueb">longest</span>}
      </div>
      <div className="mt-1.5 text-[13px] tabular-nums text-nb-muted">
        {readingsLabel(c.readings)} readings
      </div>

      {/* where it sits in time, against its sibling on the same axis */}
      <div className="relative mt-5 h-[6px] rounded-full bg-white/[.05]">
        {c.span && (
          <motion.div
            className={`absolute top-0 h-full rounded-full ${c.latest ? "bg-nb-blue" : "bg-white/25"}`}
            style={{ left: `${c.span.left}%` }}
            initial={still ? false : { width: 0 }}
            animate={{ width: `${c.span.width}%` }}
            transition={still ? { duration: 0 } : { duration: 0.6, delay: 0.15 + index * 0.06, ease: EASE }}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11.5px] tabular-nums text-nb-faint">
        <span>{when(c.firstSeen, withTime)}</span>
        <span className={c.latest ? "text-nb-soft" : ""}>
          {when(c.lastSeen, withTime)}
          {c.latest && !c.live ? " · stopped last" : ""}
        </span>
      </div>

      {c.role && (
        <div className="mt-4 text-[12px] text-nb-warn">
          A metric reads this copy ({c.role})
        </div>
      )}

      {mayWrite && (
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="mt-5 h-10 rounded-[9px] border border-nb-blue/40 text-[13px] font-medium text-nb-blueb transition hover:bg-nb-blue hover:text-white disabled:opacity-50 group-hover:border-nb-blue/70"
        >
          {busy ? "Saving…" : `Keep ${c.letter}`}
        </button>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-nb-faint/70" title={c.point_id}>
          {c.point_id.slice(0, 8)}
        </span>
        {/* The third answer and the only destructive one: this copy was never a
            real sensor. Behind its own key and a confirmation. */}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] text-nb-faint transition hover:text-nb-crit"
          >
            Delete — not a real sensor
          </button>
        )}
      </div>
    </motion.article>
  );
}

/** Deleting is not archiving, and the difference is every reading the copy ever
 *  produced. It is said in full before it is offered. */
function DeleteConfirm({
  choice,
  busy,
  still,
  onCancel,
  onConfirm,
}: Readonly<{ choice: Choice; busy: boolean; still: boolean; onCancel: () => void; onConfirm: () => void }>) {
  return (
    <motion.div
      role="alertdialog"
      aria-label={`Delete copy ${choice.letter}`}
      initial={still ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="rounded-[12px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.05)] px-5 py-4"
    >
      <p className="text-[13.5px] font-medium text-nb-ink">Delete copy {choice.letter} everywhere?</p>
      <p className="mt-1.5 text-[12.5px] leading-[1.6] text-nb-muted">
        It is removed from the gateway and from here, with its{" "}
        <span className="text-nb-soft">{readingsLabel(choice.readings)}</span> readings. It cannot be
        undone. If the sensor is only gone from site, keep it and archive it instead.
      </p>
      <div className="mt-3.5 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="h-9 rounded-[8px] bg-[#b91c1c] px-4 text-[12.5px] font-medium text-white transition hover:bg-[#dc2626] disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete it and its readings"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-[8px] px-4 text-[12.5px] text-nb-muted transition hover:text-nb-ink"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  );
}
