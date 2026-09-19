"use client";

// THE GATE STRIP — one component, every layer of Building Intelligence.
//
// The console is one pipeline (`features/bi/gates.ts`): a number ARRIVES, it
// MEANS a quantity, it BELONGS to a place, it BINDS to a role, it RATES, it
// ACTS. This strip is that pipeline rendered, and it rescopes to whatever it is
// put above — the estate on L1 Building, one domain on L2, ONE BUILDING'S domain
// on the same L2 under `?site=`, and it would take an item subject unchanged if
// L3 Plant is ever built.
//
// THE TWO SCOPES ARE NOT INTERCHANGEABLE, and this strip is where that is
// enforced. `/bi/energy` is every building's energy plus the points no building
// owns; `/bi/energy?site=<uuid>` is one building's. A gate that printed the
// first's figure under the second's heading would be the worst thing this
// component can do, so a site subject asks NONE of the three worklist reads —
// they are scoped by category and carry no site — and the gates that depend on
// them say so instead of guessing. See `gates.ts`.
//
// THE RULE THAT GOVERNS EVERY DECISION BELOW: IT MUST RECEDE WHEN HEALTHY.
//
// Every screen in this console was built while the estate was broken, so the
// product is permanently in diagnostic mode — six red panels above the numbers
// they are qualifying. A prospect reads that as a broken product rather than as
// an honest one, and an operator stops reading it at all. So:
//
//   every gate open  → ONE thin faint line. `475 points · units confirmed ·
//                      all placed · all bound · rated · alarms live`. No cards,
//                      no colour, no chrome, nothing to press. It is a receipt,
//                      not a dashboard.
//   something shut   → the six gates appear as a row of small segments, and the
//                      SHUT one expands under them with what is blocking, the
//                      head of its own worklist, and the link that opens it.
//
// ONLY ONE PANEL IS OPEN AT A TIME, and it starts on the EARLIEST shut gate.
// The pipeline has an order: while gate 1 is inflating the counts gate 2 reads,
// sending an operator to gate 2 is sending them to do the work twice. Later shut
// gates stay pressable — the order is a default, not a lock.
//
// THE WAY IN IS AN EXPANSION, NOT A ROUTE. Pressing a shut gate never leaves the
// page: the worklist opens IN CONTEXT, already scoped to the layer you are on,
// so the estate view you were reading is still behind it. Leaving is a second,
// explicit press on the action link. A drawer would have hidden the numbers the
// gate is an annotation on; a routed sub-view would have made the worklist a
// destination beside the estate again, which is exactly the shape this
// restructure removes.
//
// A GATE THAT IS PASSING IS NOT A LINK TO NOWHERE. It renders as a span with a
// tooltip, never as a button and never as an anchor. Gate 3 · BELONGS has no
// worklist in this console at all and never will — placement is one fact, owned
// by the Sites floor plan — so its panel states the blockage and links out to
// the console that owns it, rather than growing a second placing surface here.
//
// THE READS ARE THE ONES THE CONSOLE ALREADY MAKES, under the SAME query keys, so
// a strip above Portfolio costs nothing extra and a collapse on /bi/duplicates
// refreshes the gate that sent you there. A caller without `bi.read` is not
// charged for the worklists at all — the gate still states its blockage, it just
// states it without a door.
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";

import { bi } from "../api";
import { MODULE, PERM_READ } from "../constants";
import {
  allOpen,
  deriveGates,
  quietLine,
  type GateId,
  type GateState,
  type GateSubject,
  type GateView,
} from "../gates";

// The alert window gate 6 reads. Portfolio asks for exactly this, under exactly
// this key, so the two share one request and cannot disagree about it.
const ALERT_HOURS = 24;

/** Per-state segment dressing. `waiting` and `unknown` are deliberately the same
 *  faint grey as a passing gate: neither is a fault, and colouring them would
 *  put six alarms above a console with one problem. */
const SEG_TONE: Record<GateState, string> = {
  pass: "border-nb-line text-nb-faint",
  shut: "border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.08)] text-nb-warn",
  waiting: "border-nb-line text-nb-faint",
  unknown: "border-nb-line text-nb-faint",
};

const SEG_ICON: Record<GateState, string> = {
  pass: "heroicons:check-circle",
  shut: "heroicons:exclamation-triangle",
  waiting: "heroicons:clock",
  unknown: "heroicons:question-mark-circle",
};

/** What the state means, in words, on hover. An abbreviation or a colour never
 *  carries a fact on its own. */
const SEG_TITLE: Record<GateState, string> = {
  pass: "open",
  shut: "shut — press to see what is blocking it",
  waiting: "waiting on an earlier gate — nothing is wrong here",
  unknown: "not answered — this is not the same as open",
};

export interface GateStripProps {
  subject: GateSubject;
  className?: string;
}

export default function GateStrip({ subject, className = "" }: Readonly<GateStripProps>) {
  const { can, hasModule } = useAuth();
  // The same pair every /bi route is gated on. A caller without it is never sent
  // to a worklist and is never charged for its request either, which is why the
  // gate sits on the queries rather than only on the links.
  const mayBi = can(PERM_READ) && hasModule(MODULE);
  const [opened, setOpened] = useState<GateId | null>(null);

  const category = subject.kind === "domain" ? subject.category : undefined;
  // A SITE subject asks none of the three worklists, and that is not an
  // optimisation. They take a `category` and nothing else, so an answer fetched
  // here would be the domain's answer rendered under one building's name —
  // which is the single thing a two-scope console must never do. The site gates
  // read `summary.sites`, which the estate already fetched under this key.
  const wantsWorklists = mayBi && subject.kind !== "site";

  const summaryQ = useQuery<any>({
    queryKey: ["bi-summary"],
    queryFn: () => bi.summary(),
    refetchInterval: 30_000,
  });
  const ghostsQ = useQuery<any>({
    queryKey: ["bi-ghosts", category ?? ""],
    queryFn: () => bi.ghosts(category ? { category } : undefined),
    enabled: wantsWorklists,
  });
  const patternsQ = useQuery<any>({
    queryKey: ["bi-unit-patterns", category ?? null],
    queryFn: () => bi.unitPatterns({ category }),
    enabled: wantsWorklists,
  });
  const orphansQ = useQuery<any>({
    queryKey: ["bi-role-orphans"],
    queryFn: () => bi.roleOrphans(),
    enabled: wantsWorklists,
  });
  const alertsQ = useQuery<any>({
    queryKey: ["bi-alerts", ALERT_HOURS],
    queryFn: () => bi.alerts({ hours: ALERT_HOURS, limit: 50 }),
    refetchInterval: 30_000,
  });

  const gates = deriveGates({
    subject,
    summary: summaryQ.data,
    ghosts: ghostsQ.data,
    patterns: patternsQ.data,
    orphans: orphansQ.data,
    alerts: alertsQ.data,
    may: { bi: mayBi, sites: can("sites.read") },
  });

  // Nothing is claimed before the estate has answered. "Six gates, all open" on
  // a store that has not replied yet would be the one lie this strip exists to
  // prevent.
  if (summaryQ.isLoading) {
    return (
      <p className={`flex items-center gap-2 text-[11px] text-nb-faint ${className}`}>
        <Icon icon="svg-spinners:180-ring" className="text-[13px] text-nb-blueb" />
        checking the six gates…
      </p>
    );
  }

  // ── HEALTHY: one thin line, and it does not shout ──────────────────────────
  if (allOpen(gates)) {
    return (
      <p
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-nb-faint ${className}`}
        title="Every number here arrived once, means a quantity, belongs to a place, binds to a role, rates and can raise work."
      >
        <Icon icon="heroicons:check-circle" className="text-[13px] text-nb-good" />
        <span className="text-nb-soft">{quietLine(gates)}</span>
        <span>· six gates, all open</span>
      </p>
    );
  }

  // WHAT CAN BE OPENED, and what opens BY ITSELF, are two different sets and
  // the difference is the "recede when healthy" rule.
  //
  //   openable  shut OR unknown. An unknown gate already carries the sentence
  //             saying why it cannot answer — it used to be a grey chip with
  //             that sentence unreachable behind it, which is a fact hidden by
  //             the component whose rule is that silence is not health.
  //   default   the earliest SHUT gate, and only ever a shut one. An unknown
  //             gate is not a fault and must not open a panel over a console
  //             nobody asked to diagnose.
  const openable = gates.filter((g) => g.state === "shut" || g.state === "unknown");
  const openId = openable.some((g) => g.id === opened)
    ? opened
    : (gates.find((g) => g.state === "shut")?.id ?? null);
  const panel = gates.find((g) => g.id === openId) ?? null;

  return (
    <section className={`rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.45)] ${className}`}>
      <div className="nav-scroll flex items-center gap-1 overflow-x-auto px-2 py-1.5">
        {gates.map((g) => (
          <Segment
            key={g.id}
            gate={g}
            open={g.id === openId}
            onOpen={g.state === "shut" || g.state === "unknown" ? () => setOpened(g.id) : undefined}
          />
        ))}
      </div>
      {panel && <GatePanel gate={panel} subject={subject} />}
    </section>
  );
}

/** One gate in the row. Shut or unknown → a button, because pressing it does
 *  something: it states what is blocking, or why this gate cannot answer at this
 *  scope. Passing or waiting → a span: a gate that is fine is not a link to
 *  nowhere. */
function Segment({
  gate,
  open,
  onOpen,
}: Readonly<{ gate: GateView; open: boolean; onOpen?: () => void }>) {
  const body = (
    <>
      <Icon icon={SEG_ICON[gate.state]} className="text-[12px]" />
      <span className="font-mono">{gate.n}</span>
      <span className="tracking-[.6px]">{gate.verb}</span>
      {gate.count != null && <span className="font-mono">{gate.count}</span>}
    </>
  );
  const cls = `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2 py-1 text-[10.5px] ${
    SEG_TONE[gate.state]
  } ${open ? "ring-1 ring-[rgba(251,191,36,.45)]" : ""}`;

  if (!onOpen) {
    return (
      <span className={cls} title={`${gate.verb} — ${gate.label}. ${SEG_TITLE[gate.state]}`}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      title={`${gate.verb} — ${gate.label}. ${SEG_TITLE[gate.state]}`}
      className={`${cls} transition hover:border-[rgba(251,191,36,.7)]`}
    >
      {body}
    </button>
  );
}

/** The shut gate's worklist, in context and already scoped. The rows are the
 *  EVIDENCE — the actual duplicated registers, the actual stranded assertions —
 *  not a count of them, because a count an operator cannot check is a count they
 *  cannot act on. The head of the list only: settling them is the console the
 *  action link opens. */
function GatePanel({ gate, subject }: Readonly<{ gate: GateView; subject: GateSubject }>) {
  return (
    <div className="border-t border-nb-line/60 px-3 py-2.5">
      {/* An UNKNOWN gate is not a fault and must not be dressed as one. Same
          anatomy, the amber reserved for something that is actually shut. */}
      <p
        className={`text-[11px] font-semibold uppercase tracking-[1.2px] ${
          gate.state === "shut" ? "text-nb-warn" : "text-nb-muted"
        }`}
      >
        <Icon icon={gate.icon} className="mr-1.5 inline text-[13px]" />
        Gate {gate.n} · {gate.verb} — {gate.label}
      </p>
      <p className="mt-1 max-w-4xl text-[11.5px] leading-relaxed text-nb-soft">{gate.blocking}</p>

      {gate.rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {gate.rows.map((r) => (
            <li
              key={r.key}
              className="flex flex-wrap items-baseline gap-x-2 rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-1 text-[11px]"
            >
              <span className="font-mono text-nb-ink">{r.title}</span>
              <span className="text-nb-faint">{r.meta}</span>
            </li>
          ))}
        </ul>
      )}

      {gate.action ? (
        <Link
          href={gate.action.href}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-nb-blueb transition hover:underline"
        >
          {gate.action.label}
          <Icon icon="heroicons:arrow-up-right" className="text-[11px]" />
        </Link>
      ) : (
        // No link is the honest answer in two cases and they are one sentence
        // apart: nothing on this platform opens the gate, or the caller may not
        // reach what does. Either way the blockage is still stated above — a
        // count without its action is worse than a count with a door shut.
        <p className="mt-2 text-[10.5px] italic text-nb-faint">
          Nothing you can reach from here opens this gate.
        </p>
      )}

      {subject.kind === "domain" && (
        <p className="mt-2 text-[10.5px] text-nb-faint">
          Scoped to {subject.label}. The estate-wide count is on Building.
        </p>
      )}

      {subject.kind === "site" && (
        // The footnote a two-scope console cannot do without: which scope this
        // is, and where the other one is. Without it an operator reading a
        // deferred gate has no way to tell a building's silence from an
        // estate's.
        <p className="mt-2 text-[10.5px] text-nb-faint">
          Scoped to {subject.label} — one building. Nothing here is the estate&apos;s figure.
        </p>
      )}
    </div>
  );
}
