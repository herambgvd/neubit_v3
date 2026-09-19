"use client";

// Building Intelligence → Setup → UNITS (gate 2): say what each number measures.
//
// ONE WAY TO WORK IT, the same as Duplicates: a question at a time, the
// readings on the screen, the platform doing the checking (`units/unitAsk.ts`).
// It replaced a panel of twenty-one sentence-long pattern chips that mixed
// three different jobs and showed not one reading.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ConsolePage } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { bi } from "../api";
import { MODULE, PERM_READ } from "../constants";
import UnitsWizard from "./units/UnitsWizard";
import type { Catalogue } from "./units/unitAsk";

export default function UnitsSetup() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  // Bumped to hand the walk a fresh queue — "go through the skipped ones".
  const [round, setRound] = useState(0);

  const q = useQuery<Catalogue>({
    queryKey: ["bi-unit-patterns", null, null],
    queryFn: () => bi.unitPatterns({}),
    enabled: mayRead,
  });

  if (!mayRead) {
    return (
      <ConsolePage>
        <p className="mx-auto max-w-[980px] pt-6 text-[12.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <div className="mx-auto w-full max-w-[980px] pt-4">
        {q.isLoading && <p className="py-16 text-center text-[13px] text-nb-faint">Checking every reading…</p>}
        {q.error && (
          <p className="rounded-[10px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)] px-4 py-2.5 text-[12.5px] text-nb-crit">
            {apiError(q.error, "Could not read the units")}
          </p>
        )}
      </div>
      {q.data && <UnitsWizard key={round} catalogue={q.data} onRestart={() => setRound((r) => r + 1)} />}
    </ConsolePage>
  );
}
