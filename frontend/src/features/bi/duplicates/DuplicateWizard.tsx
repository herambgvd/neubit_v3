"use client";

// DUPLICATES, one question at a time.
//
// 45 groups is 45 decisions, and a table of 45 rows asks an operator to hold
// the whole queue in their head before answering any of it. So this asks ONE:
// the record, the two or three candidates, and what each one carries. Answer,
// and the next question slides in. The whole list is one press away for anyone
// who wants it.
//
// THE COPY IS THE FEATURE. Nobody outside this codebase knows what a
// "generation" or a "collapse" is. Here they are RECORDS, one of them is KEPT
// and the others are FILED AWAY, and the screen says out loud that no reading
// is deleted and the whole thing can be undone. The one paragraph explaining
// why duplicates exist at all sits on the screen, not in a training deck.
//
// IT RECOMMENDS NOTHING. `askable.ts` says why: a gateway is sometimes rebuilt
// because a sensor was REPLACED, and then the young record is the real one. The
// tiles state what is true of each record — how long it ran, how much it holds,
// whether a metric reads it — and the person decides.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { iot } from "@/features/iot/api";

import { bi } from "../api";
import { PERM_MANAGE } from "../constants";
import {
  daysLabel,
  readingsLabel,
  type Choice,
  type Question,
} from "./askable";

/** Deleting a point destroys its readings in both systems, so it takes the
 *  gateway's own key as well as BI's. */
export const PERM_DELETE = "iot.manage";

const fmtStamp = (iso: string | null) => {
  if (!iso) return "not known";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not known";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

export default function DuplicateWizard({
  questions,
  freshMinutes,
  onShowList,
  onSettled,
}: Readonly<{
  questions: Question[];
  freshMinutes: number;
  onShowList: () => void;
  onSettled: (msg: string) => void;
}>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayWrite = can(PERM_MANAGE);
  const mayDelete = can(PERM_DELETE) && can(PERM_MANAGE);
  const still = useReducedMotion();

  const [at, setAt] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Choice | null>(null);

  // A question answered leaves the list on the next read, so the index is kept
  // inside the REMAINING queue rather than over a fixed one.
  const queue = useMemo(
    () => questions.filter((q) => !skipped.includes(q.key)),
    [questions, skipped],
  );
  const q: Question | undefined = queue[Math.min(at, Math.max(0, queue.length - 1))];
  const answered = questions.length - queue.length;

  const keep = useMutation({
    mutationFn: (survivor: string) =>
      bi.collapseGhosts({
        groups: [
          { device_tag: q!.device_tag, point_tag: q!.point_tag, survivor_point_id: survivor },
        ],
      }),
    onSuccess: (res: any) => {
      setErr(null);
      onSettled(
        `Kept 1 record · ${res.points_retired} filed away` +
          (res.roles_migrated ? ` · ${res.roles_migrated} metric binding moved across` : ""),
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
        `Record deleted from the gateway and from here · ${(res.readings_deleted ?? 0).toLocaleString("en-GB")} readings destroyed`,
      );
      qc.invalidateQueries({ queryKey: ["bi-ghosts"] });
    },
    onError: (e) => setErr(apiError(e, "Nothing was deleted")),
  });

  const skip = useCallback(() => {
    if (q) setSkipped((s) => [...s, q.key]);
    setAt(0);
  }, [q]);

  // A, B, C… answer; S skips. A queue of 45 is a keyboard job.
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
    return (
      <div className="rounded-[14px] border border-[rgba(52,211,153,.35)] bg-[rgba(52,211,153,.07)] px-5 py-6 text-center">
        <p className="text-[15px] font-semibold text-nb-good">Nothing left to decide</p>
        <p className="mx-auto mt-1.5 max-w-[60ch] text-[12.5px] leading-[1.6] text-nb-soft">
          {skipped.length
            ? `${skipped.length} question(s) were skipped and are waiting in the whole list.`
            : "Every duplicated sensor on this estate has one record marked as the real one."}
        </p>
        <button
          type="button"
          onClick={onShowList}
          className="mt-3 h-10 rounded-[9px] border border-nb-line px-4 text-[12.5px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
        >
          See the whole list
        </button>
      </div>
    );
  }

  const pct = questions.length ? Math.round((answered / questions.length) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* progress */}
      <div className="flex items-center gap-5">
        <div className="flex-1">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[16px] font-semibold text-nb-ink">Sorting out duplicated sensors</h2>
            <span className="text-[12.5px] text-nb-muted">
              question {Math.min(answered + 1, questions.length)} of {questions.length}
            </span>
          </div>
          <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-[rgba(140,165,220,.16)]">
            <motion.div
              className="h-[5px] rounded-full bg-nb-blue"
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={still ? { duration: 0 } : { type: "spring", stiffness: 180, damping: 26 }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onShowList}
          className="h-10 shrink-0 rounded-[9px] border border-nb-line px-3.5 text-[12.5px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          See the whole list instead
        </button>
      </div>

      {/* why you are being asked — once, on the screen, not in a deck */}
      <div className="flex gap-3 rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.55)] px-4 py-3.5">
        <Icon icon="heroicons-outline:information-circle" className="mt-[1px] shrink-0 text-[18px] text-nb-blueb" />
        <p className="text-[12.5px] leading-[1.65] text-nb-soft">
          <span className="font-semibold text-nb-ink">Why you are being asked.</span> Each time the
          gateway is rebuilt it saves a new record for a sensor and keeps the old one, so one real
          sensor shows up twice or more — and every copy is counted. You say which record is the
          real sensor; the rest are filed away pointing at it. No reading is deleted, and this can
          be undone.
        </p>
      </div>

      {err && (
        <p className="rounded-[10px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.08)] px-3.5 py-2.5 text-[12.5px] text-nb-crit">
          {err}
        </p>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={q.key}
          initial={still ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={still ? { opacity: 1 } : { opacity: 0, y: -14 }}
          transition={still ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-4"
        >
          {/* the question */}
          <div className="text-center">
            <div className="font-mono text-[11px] uppercase tracking-[1.4px] text-nb-muted">
              {q.device_tag} · {q.point_tag}
              {q.category ? ` · ${q.category}` : ""}
            </div>
            <h3 className="mt-2 text-[22px] font-semibold tracking-[-.3px] text-nb-ink">
              Which record is the real sensor?
            </h3>
            <p className="mx-auto mt-1.5 max-w-[70ch] text-[12.5px] text-nb-soft">
              {q.because === "none_live"
                ? `Neither record has sent anything in the last ${freshMinutes} minutes, so the data cannot say which is real. Pick the one that ran as the sensor.`
                : "More than one record is sending right now. Filing away a record that is still delivering would lose a live reading, so a person has to choose."}
            </p>
          </div>

          {/* the choices */}
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(${Math.min(q.choices.length, 3)}, minmax(0, 1fr))` }}
          >
            {q.choices.map((c) => (
              <ChoiceTile
                key={c.point_id}
                choice={c}
                still={!!still}
                mayWrite={mayWrite}
                busy={keep.isPending}
                onKeep={() => keep.mutate(c.point_id)}
                onDelete={mayDelete ? () => setConfirmDelete(c) : undefined}
              />
            ))}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* escapes */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={skip}
          className="h-11 rounded-[10px] border border-nb-line px-5 text-[13px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
        >
          I am not sure — skip this one
        </button>
        {mayWrite ? (
          <span className="text-[11.5px] text-nb-faint">
            press{" "}
            {q.choices.map((c) => (
              <kbd
                key={c.letter}
                className="mx-[2px] rounded-[5px] border border-nb-line px-1.5 py-[1px] font-mono text-[10.5px] text-nb-muted"
              >
                {c.letter}
              </kbd>
            ))}{" "}
            to answer ·{" "}
            <kbd className="rounded-[5px] border border-nb-line px-1.5 py-[1px] font-mono text-[10.5px] text-nb-muted">
              S
            </kbd>{" "}
            to skip
          </span>
        ) : (
          <span className="text-[11.5px] text-nb-faint">
            Answering needs <span className="font-mono">{PERM_MANAGE}</span>.
          </span>
        )}
      </div>

      {/* what happens when you answer */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-nb-line bg-[rgba(6,11,26,.55)] px-4 py-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[1.3px] text-nb-muted">
          when you answer
        </span>
        <span className="text-[12px] text-nb-soft">the record you pick becomes the sensor</span>
        <Icon icon="heroicons-outline:arrow-right" className="text-[13px] text-nb-faint" />
        <span className="text-[12px] text-nb-soft">the others are filed away, pointing at it</span>
        <Icon icon="heroicons-outline:arrow-right" className="text-[13px] text-nb-faint" />
        <span className="text-[12px] text-nb-soft">old readings stay exactly where they are</span>
      </div>

      {confirmDelete && (
        <DeleteConfirm
          choice={confirmDelete}
          busy={destroy.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => destroy.mutate(confirmDelete.point_id)}
        />
      )}
    </div>
  );
}

function ChoiceTile({
  choice,
  still,
  mayWrite,
  busy,
  onKeep,
  onDelete,
}: Readonly<{
  choice: Choice;
  still: boolean;
  mayWrite: boolean;
  busy: boolean;
  onKeep: () => void;
  onDelete?: () => void;
}>) {
  const c = choice;
  return (
    <motion.div
      whileHover={still ? undefined : { y: -3 }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      className="flex flex-col gap-3.5 rounded-[15px] border border-nb-line bg-[rgba(16,28,60,.65)] p-5"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-nb-line font-mono text-[12px] text-nb-soft">
          {c.letter}
        </span>
        <span className="text-[15px] font-semibold text-nb-ink">
          {c.live ? "Sending right now" : `Ran until ${fmtStamp(c.lastSeen)}`}
        </span>
      </div>

      <dl className="m-0 flex flex-col gap-2.5">
        <Fact label="Ran for" value={daysLabel(c.days)} strong={c.mostHistory} />
        <Fact label="Readings kept" value={readingsLabel(c.readings)} />
        <Fact label="First seen" value={fmtStamp(c.firstSeen)} />
        <Fact label="Last seen" value={fmtStamp(c.lastSeen)} strong={c.latest} />
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {c.mostHistory && <Tag tone="blue">holds the most history</Tag>}
        {c.latest && !c.live && <Tag tone="blue">stopped last</Tag>}
        {c.live && <Tag tone="good">still sending</Tag>}
        {c.role && <Tag tone="warn">a metric reads this one</Tag>}
      </div>

      {mayWrite && (
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="mt-auto h-11 rounded-[10px] bg-nb-blue text-[13.5px] font-semibold text-white transition hover:bg-nb-blueb disabled:opacity-50"
        >
          {busy ? "Saving…" : "This one is the sensor"}
        </button>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] text-nb-faint" title={c.point_id}>
          {c.point_id.slice(0, 8)}…
        </span>
        {/* The third answer, and the only destructive one: this record was never
            a real sensor. Behind its own key, and behind a confirmation that
            says what it destroys. */}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] text-nb-muted underline-offset-2 transition hover:text-nb-crit hover:underline"
          >
            Not a real sensor — delete it
          </button>
        )}
      </div>
    </motion.div>
  );
}

function Fact({ label, value, strong }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-nb-muted">{label}</dt>
      <dd className={`m-0 text-[12.5px] ${strong ? "font-semibold text-nb-ink" : "text-nb-soft"}`}>
        {value}
      </dd>
    </div>
  );
}

function Tag({ tone, children }: Readonly<{ tone: "blue" | "good" | "warn"; children: React.ReactNode }>) {
  const cls = {
    blue: "border-nb-blue/40 bg-nb-blue/10 text-nb-blueb",
    good: "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] text-nb-good",
    warn: "border-nb-warn/40 bg-nb-warn/10 text-nb-warn",
  }[tone];
  return (
    <span className={`rounded-full border px-2 py-[3px] text-[10.5px] ${cls}`}>{children}</span>
  );
}

/** Deleting is not filing away, and the difference is every reading the record
 *  ever produced. It is said in full before it is offered. */
function DeleteConfirm({
  choice,
  busy,
  onCancel,
  onConfirm,
}: Readonly<{ choice: Choice; busy: boolean; onCancel: () => void; onConfirm: () => void }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-[13px] border border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.07)] px-5 py-4"
    >
      <div className="flex items-center gap-2.5">
        <Icon icon="heroicons:exclamation-triangle" className="text-[17px] text-nb-crit" />
        <h4 className="text-[14.5px] font-semibold text-nb-ink">
          Delete record {choice.letter} everywhere?
        </h4>
      </div>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-[1.65] text-nb-soft">
        This removes the record from the gateway <span className="text-nb-ink">and</span> from here,
        and destroys the{" "}
        <span className="text-nb-ink">{readingsLabel(choice.readings)}</span> readings it holds.{" "}
        <span className="text-nb-ink">It cannot be undone.</span> Use it only when this record was
        never a real sensor. If the sensor is simply gone from site, keep it and file it away
        instead — that keeps its history and reverses itself.
      </p>
      <div className="mt-3 flex gap-2.5">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="h-10 rounded-[9px] bg-[#c2410c] px-4 text-[12.5px] font-semibold text-white transition hover:bg-[#ea580c] disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete it and its readings"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-[9px] border border-nb-line px-4 text-[12.5px] text-nb-soft transition hover:border-nb-blue hover:text-nb-blueb"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  );
}
