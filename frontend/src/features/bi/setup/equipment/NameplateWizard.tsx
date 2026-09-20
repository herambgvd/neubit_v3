"use client";

// MACHINE DETAILS — one question at a time, in the words of the machine room.
//
// Two things about a machine are not in its traffic: how much cooling it is
// rated for, and how far the water is supposed to drop. The first is on the
// metal plate bolted to the machine, so this says exactly where to look. The
// second nobody should have to remember: the readings already show it, so the
// range half its running hours sat in is OFFERED and a person says yes — unless
// the machine ran all over the place, which is said plainly, because a number
// nobody could stand behind should not be one press away.
//
// Skipping is a real answer and costs nothing but the one metric that reads it,
// which each question names. Nothing is written until a press, and a press
// writes one machine's facts through core, which keeps every other fact.
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton } from "@/components/console";
import { Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { InfraDesignValue } from "@/lib/types";

import {
  blocksText,
  designWith,
  readBand,
  readNumber,
  stepsOf,
  type Nameplate,
  type Step,
} from "./nameplate";

const fmt = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 1 });

export default function NameplateWizard({
  siteId,
  data,
  designs,
  onClose,
}: Readonly<{
  siteId: string;
  data: Nameplate;
  /** Each machine's facts as core holds them now — a design PUT replaces the set. */
  designs: Record<string, Record<string, InfraDesignValue | null>>;
  onClose: () => void;
}>) {
  const qc = useQueryClient();
  const still = !!useReducedMotion();
  const [steps] = useState<Step[]>(() => stepsOf(data));
  const [at, setAt] = useState(0);
  const [saved, setSaved] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [typing, setTyping] = useState(false);
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [one, setOne] = useState("");
  const [error, setError] = useState<string | null>(null);

  const step = steps[at];

  const next = () => {
    setTyping(false);
    setLow("");
    setHigh("");
    setOne("");
    setError(null);
    setAt((i) => i + 1);
  };

  const save = useMutation({
    mutationFn: (design: Record<string, InfraDesignValue | null>) =>
      siteInfrastructure.setDesign(siteId, step.equipmentId, { design }),
    onSuccess: () => {
      setSaved((n) => n + 1);
      qc.invalidateQueries({ queryKey: ["infra-tree", siteId] });
      qc.invalidateQueries({ queryKey: ["bi-equipment-nameplate", siteId] });
      qc.invalidateQueries({ queryKey: ["bi-plant-live", siteId] });
      next();
    },
    onError: (e) => setError(apiError(e, "Could not save it")),
  });

  const write = (answer: Parameters<typeof designWith>[2]) =>
    save.mutate(designWith(designs[step.equipmentId] ?? {}, step.question, answer));

  const skip = () => {
    setSkipped((n) => n + 1);
    next();
  };

  // ── the summary ──────────────────────────────────────────────────────────
  if (!step) {
    return (
      <Modal open onClose={onClose} title="Machine details" size="md">
        <div className="px-5 py-6 text-center">
          <p className="text-[14px] text-nb-ink">
            {saved > 0 ? `${saved} machine detail${saved === 1 ? "" : "s"} saved.` : "Nothing saved."}
          </p>
          {skipped > 0 && (
            <p className="mt-1.5 text-[12.5px] text-nb-faint">
              {skipped} skipped — they will be here when you have the numbers.
            </p>
          )}
          <div className="mt-5 flex justify-center">
            <ActionButton onClick={onClose}>Close</ActionButton>
          </div>
        </div>
      </Modal>
    );
  }

  const q = step.question;
  const blocked = blocksText(q.blocks);
  const band = q.kind === "band";
  const busy = save.isPending;

  return (
    <Modal open onClose={onClose} title="Machine details" subtitle={`${at + 1} of ${steps.length}`} size="md">
      <div className="px-5 py-5">
        {/* progress, as a line and not a number to decode */}
        <div className="mb-5 h-[3px] overflow-hidden rounded-full bg-white/[.07]">
          <motion.div
            className="h-full rounded-full bg-nb-blue"
            initial={false}
            animate={{ width: `${(at / steps.length) * 100}%` }}
            transition={{ duration: still ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={`${step.equipmentId}:${q.kind}`}
            initial={still ? false : { opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={still ? { opacity: 0 } : { opacity: 0, x: -18 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="text-[11.5px] uppercase tracking-wider text-nb-faint">{step.tag}</p>

            {band && q.observed && !typing ? (
              <>
                <h4 className="mt-1.5 text-[17px] font-semibold leading-snug text-nb-ink">
                  Half its running hours, it cooled the water by{" "}
                  <span className="text-nb-blueb">
                    {fmt(q.observed.low)}–{fmt(q.observed.high)} °C
                  </span>
                  .
                </h4>
                <p className="mt-2 text-[13px] text-nb-soft">
                  {q.observed.hours.toLocaleString("en-GB")} hours of running in the last {q.observed.days} days, most
                  often around {fmt(q.observed.median)} °C. Is that how much it is meant to cool?
                </p>
                {q.observed.wide && (
                  <p className="mt-2 rounded-[9px] border border-nb-warn/30 bg-nb-warn/[.06] px-3 py-2 text-[12.5px] text-nb-warn">
                    It ran all over the place — {fmt(q.observed.spread[0])} to {fmt(q.observed.spread[1])} °C across the
                    window. This is only where it usually sat. If the design sheet is to hand, its numbers are better.
                  </p>
                )}
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <ActionButton disabled={busy} onClick={() => write({ low: q.observed!.low, high: q.observed!.high })}>
                    {busy ? "Saving…" : "Yes, that is normal"}
                  </ActionButton>
                  <QuietButton onClick={() => setTyping(true)}>No — I have the real numbers</QuietButton>
                  <QuietButton onClick={skip}>Not sure · skip</QuietButton>
                </div>
              </>
            ) : band ? (
              <>
                <h4 className="mt-1.5 text-[17px] font-semibold leading-snug text-nb-ink">
                  How much is it meant to cool the water?
                </h4>
                <p className="mt-2 text-[13px] text-nb-soft">
                  {q.observed
                    ? "Give the two ends the design sheet states."
                    : "There are not enough hours of both water readings yet to see it, so it has to be typed — the design sheet for the chiller states it."}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <input
                    aria-label="Smallest drop"
                    inputMode="decimal"
                    value={low}
                    onChange={(e) => setLow(e.target.value)}
                    placeholder="5"
                    className="h-9 w-20 rounded-[9px] border border-white/[.14] bg-transparent px-2.5 text-center font-mono text-[13px] text-nb-ink outline-none focus:border-nb-blue/60"
                  />
                  <span className="text-[13px] text-nb-muted">to</span>
                  <input
                    aria-label="Biggest drop"
                    inputMode="decimal"
                    value={high}
                    onChange={(e) => setHigh(e.target.value)}
                    placeholder="7"
                    className="h-9 w-20 rounded-[9px] border border-white/[.14] bg-transparent px-2.5 text-center font-mono text-[13px] text-nb-ink outline-none focus:border-nb-blue/60"
                  />
                  <span className="text-[13px] text-nb-muted">°C</span>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <ActionButton
                    disabled={busy}
                    onClick={() => {
                      const r = readBand(low, high);
                      if ("error" in r) setError(r.error);
                      else write(r);
                    }}
                  >
                    {busy ? "Saving…" : "Save"}
                  </ActionButton>
                  <QuietButton onClick={skip}>Not sure · skip</QuietButton>
                </div>
              </>
            ) : (
              <>
                <h4 className="mt-1.5 text-[17px] font-semibold leading-snug text-nb-ink">
                  How much cooling is it rated for?
                </h4>
                <p className="mt-2 text-[13px] text-nb-soft">
                  It is on the metal plate bolted to the machine — a number next to{" "}
                  <span className="font-mono text-nb-blueb">{q.unit}</span>. Nothing to work out; copy it as it is.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <input
                    aria-label={q.label ?? "Rated capacity"}
                    inputMode="decimal"
                    value={one}
                    onChange={(e) => setOne(e.target.value)}
                    placeholder="350"
                    className="h-9 w-28 rounded-[9px] border border-white/[.14] bg-transparent px-2.5 text-center font-mono text-[13px] text-nb-ink outline-none focus:border-nb-blue/60"
                  />
                  <span className="text-[13px] text-nb-muted">{q.unit}</span>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <ActionButton
                    disabled={busy}
                    onClick={() => {
                      const v = readNumber(one);
                      if (v === null) setError("That is not a number the plate would carry.");
                      else write(v);
                    }}
                  >
                    {busy ? "Saving…" : "Save"}
                  </ActionButton>
                  <QuietButton onClick={skip}>Not on the plate · skip</QuietButton>
                </div>
              </>
            )}

            {error && <p className="mt-3 text-[12.5px] text-nb-crit">{error}</p>}

            {blocked && (
              <p className="mt-5 border-t border-white/[.06] pt-3 text-[12px] text-nb-faint">
                Skip it and one thing stays off: {blocked}. Everything else keeps working.
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Modal>
  );
}
