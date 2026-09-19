"use client";

// THE CORRELATIONS LANE — the one thing on this console a single-domain BMS
// cannot produce, and the reason it sits ABOVE the domains on L1.
//
// A domain count is table stakes. Every building management system ships one,
// because every one of them owns a domain and can count what is inside it. A
// CROSS-DOMAIN answer — "the chiller's draw tracks the outside air", "the
// after-hours load does not follow the badge" — is structurally unavailable to a
// product that owns HVAC while the badge reader lives in somebody else's. That
// is the pitch, so it is the lane, and the domain cards below it are inventory.
//
// WHAT THE SERVER HANDS US (`GET /api/v1/bi/correlations`, `bi.read`): seven
// seeded questions, each declaring the signals it needs, each resolved against
// THIS estate over the window the coefficient would be computed over. Per signal
// it says satisfied or not, and when not, the KIND of gap, what is gating it in
// this estate's own numbers, the remedy and the console that closes it.
//
// ── THE NUMBER THIS SCREEN EXISTS TO PRINT, AND THE WAY IT CAN LIE ──────────
//
// `needs_new_hardware` is a TRI-STATE and the headline rests on it:
//
//   true   somebody has to buy and install something.
//   false  the customer already owns everything; what is missing is an
//          assertion, a binding, a switched-on module or a typed fact.
//   null   UNDETERMINED from the reading store. NOT "no".
//
// So the headline is THREE numbers and never two. "Zero need new hardware" over
// an estate with an undetermined gap would be the console claiming, on the
// strength of something it does not know, that there is nothing to buy — which
// is precisely the fabrication every other screen here refuses. `totals` already
// carries the three buckets separately for this reason, and this component reads
// them rather than deriving them: a client that counted `correlations` itself
// would be free to get the fold wrong, and this is the one number on the screen
// that has to be trustworthy.
//
// Nothing here is arithmetic on the client. Every figure printed is a `totals`
// lookup; the cards read their own `state`, `signals` and `blocking_gap`.
//
// ── DENSITY ─────────────────────────────────────────────────────────────────
//
// The API hands back four sentences per gap. They are all true and none of them
// is dropped, but a paragraph beside every card is the wall of text this console
// was just rebuked for: what renders is the KIND and the DOOR, at label density,
// with the summary, the remedy and this estate's own gating figure on the
// element's `title`. See components/Reason.tsx for the same trade elsewhere.
//
// ── NO DOOR IS INVENTED ─────────────────────────────────────────────────────
//
// A gap's `where` is a console in words ("Configurations → Integrations"). It is
// rendered as a LINK only where this app actually has that route; otherwise it
// is printed as the surface's name and nothing is pressable. A link to a page
// that does not exist is worse than a sentence naming the room.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { SectionHead, LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { bi } from "../api";
import { MODULE, PERM_READ, categoryMeta } from "../constants";
import { taskHref } from "../setup/routes";

/** The gap kinds, at label density. The server's own `summary`/`remedy` stay
 *  reachable on hover; this is what the eye lands on. An unknown kind prints its
 *  own key rather than being dropped — a gap nobody labelled is still a gap. */
const KIND_LABEL: Record<string, string> = {
  unit_unconfirmed: "unit unconfirmed",
  unit_wrong_dimension: "unit is the wrong quantity",
  role_unbound: "role unbound",
  signal_silent: "sensor gone quiet",
  point_absent: "no sensor for it",
  module_unpopulated: "module publishing nothing",
  module_population_unknown: "module not visible here",
  site_fact_unrecorded: "site fact not recorded",
  site_fact_uncited: "site fact uncited",
};

export const kindLabel = (kind: string) => KIND_LABEL[kind] || kind;

/** `where` is a console named in words. It becomes a link only where this app
 *  has the route; everything else prints as the room's name. */
const WHERE_HREF: Record<string, string> = {
  "Building Intelligence → Units": taskHref("units"),
  "Building Intelligence → Roles": taskHref("roles"),
  // The server still names the room its site facts USED to be typed in. They
  // are recorded in BI → Setup → Building facts now, so the words stay the
  // server's and the link goes where the fact can actually be recorded.
  "Configurations → Sites": taskHref("facts"),
};

/** The tri-state, in the one vocabulary this console uses for it. `null` is a
 *  THIRD answer and never the second: folding it into "nothing to buy" is the
 *  single mistake this lane is built to prevent. */
export function hardwareVerdict(needs: boolean | null | undefined): {
  text: string;
  tone: string;
  title: string;
} {
  if (needs === true) {
    return {
      text: "needs new hardware",
      tone: "text-nb-crit",
      title: "Closing this gap means buying and installing something.",
    };
  }
  if (needs === false) {
    return {
      text: "nothing to buy",
      tone: "text-nb-good",
      title:
        "The customer already owns everything this needs. What is missing is an assertion, a binding, a switched-on module or a typed fact.",
    };
  }
  return {
    text: "undetermined",
    tone: "text-nb-warn",
    title:
      "Undetermined, and that is not the same as no. The fact that would settle whether this costs money is in a database the reading store is not allowed to open.",
  };
}

/** One signal, as a chip. Satisfied or gapped, and the gap's four sentences on
 *  hover rather than under it. */
function SignalChip({ signal }: Readonly<{ signal: any }>) {
  const gap = signal.gap;
  const ok = !!signal.satisfied;
  const title = ok
    ? `${signal.label} — supplied by this estate.${signal.unlocks ? ` It carries ${signal.unlocks}.` : ""}`
    : [gap?.summary, gap?.gate, gap?.remedy].filter(Boolean).join(" ");
  return (
    <span
      title={title}
      className={`flex shrink-0 items-center gap-1 rounded-[6px] border px-1.5 py-0.5 text-[10.5px] ${
        ok
          ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] text-nb-good"
          : "border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.07)] text-nb-warn"
      }`}
    >
      <Icon
        icon={ok ? "heroicons:check-circle" : "heroicons:exclamation-triangle"}
        className="text-[11px]"
      />
      {signal.label}
    </span>
  );
}

/** One question, and which half of it the estate can already answer. */
function CorrelationCard({ row }: Readonly<{ row: any }>) {
  const live = row.state === "live";
  const gap = row.blocking_gap;
  // The blocking gap names a signal by KEY; the label is on the signal itself,
  // and a card must print what an operator would recognise rather than the key.
  const blockedSignal = (row.signals || []).find((s: any) => s.key === gap?.signal);
  const verdict = hardwareVerdict(gap?.needs_new_hardware);

  return (
    <article
      aria-label={row.name}
      className={`flex min-w-[268px] flex-1 flex-col rounded-[12px] border p-3.5 transition ${
        live
          ? "border-[rgba(52,211,153,.45)] bg-[rgba(52,211,153,.06)]"
          : "border-nb-line bg-[rgba(8,15,34,.5)]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-nb-ink">{row.name}</div>
          {/* The question IS the product. One line, and the whole of it on
              hover — never a paragraph under every card. */}
          <div className="truncate text-[11px] text-nb-faint" title={row.question}>
            {row.question}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-[6px] border px-1.5 py-0.5 text-[10px] uppercase tracking-[1px] ${
            live
              ? "border-[rgba(52,211,153,.45)] text-nb-good"
              : "border-[rgba(251,191,36,.45)] text-nb-warn"
          }`}
          title={row.unlocks}
        >
          {live ? "live" : "blocked"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {(row.domains || []).map((d: string) => (
          <span
            key={d}
            className="rounded-[5px] border border-nb-line px-1.5 py-0.5 text-[10px] text-nb-soft"
          >
            {categoryMeta(d).label}
          </span>
        ))}
      </div>

      {/* WHICH HALF IS ANSWERABLE, at a glance. Each signal carries its own
          satisfied/gap state, so a reader sees that the load axis is there and
          the outside-air axis is not, without opening anything. */}
      <div className="mt-2 flex flex-wrap gap-1">
        {(row.signals || []).map((s: any) => (
          <SignalChip key={s.key} signal={s} />
        ))}
      </div>

      <div className="mt-auto pt-2.5">
        {live ? (
          <p className="text-[10.5px] text-nb-good" title={row.unlocks}>
            Every signal is supplied — this question is being asked.
          </p>
        ) : gap ? (
          // THE ACTION, NOT THE PARAGRAPH. Blocking signal and kind on one
          // line, the tri-state verdict and the door on the next; `summary`,
          // `gate` and `remedy` on the `title` rather than under the card.
          <>
            <p
              className="text-[11px] leading-snug text-nb-warn"
              title={[gap.summary, gap.gate, gap.remedy].filter(Boolean).join(" ")}
            >
              {blockedSignal?.label ?? gap.signal} — {kindLabel(gap.kind)}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
              <span className={verdict.tone} title={verdict.title}>
                {verdict.text}
              </span>
              {gap.where ? (
                WHERE_HREF[gap.where] ? (
                  <Link
                    href={WHERE_HREF[gap.where]}
                    className="inline-flex items-center gap-1 text-nb-blueb transition hover:underline"
                    title={gap.remedy}
                  >
                    {gap.where}
                    <Icon icon="heroicons:arrow-up-right" className="text-[10px]" />
                  </Link>
                ) : (
                  // Named, not linked: this app has no route for that surface,
                  // and a door that 404s is worse than the room's name.
                  <span className="text-nb-faint" title={gap.remedy}>
                    {gap.where}
                  </span>
                )
              ) : (
                <span className="italic text-nb-faint" title={gap.remedy}>
                  No console closes this one.
                </span>
              )}
            </p>
          </>
        ) : (
          <p className="text-[10.5px] italic text-nb-faint">
            Blocked, and the server named no blocking gap for it.
          </p>
        )}
      </div>
    </article>
  );
}

export default function Correlations({ className = "" }: Readonly<{ className?: string }>) {
  const { can, hasModule } = useAuth();
  // The same pair every /bi route is gated on. A caller who may not read this is
  // not merely hidden from the lane — the request is never made.
  const mayBi = can(PERM_READ) && hasModule(MODULE);

  const q = useQuery<any>({
    queryKey: ["bi-correlations"],
    queryFn: () => bi.correlations(),
    enabled: mayBi,
    refetchInterval: 120_000,
  });

  if (!mayBi) return null;

  const t = q.data?.totals;
  const rows: any[] = q.data?.correlations ?? [];
  // One example gap per kind, taken from the payload, so a kind chip can carry
  // the server's own sentence on hover instead of a gloss written here.
  const kindTitle: Record<string, string> = {};
  for (const r of rows) {
    const g = r.blocking_gap;
    if (g && !kindTitle[g.kind]) kindTitle[g.kind] = [g.summary, g.remedy].filter(Boolean).join(" ");
  }

  return (
    <section className={className}>
      <SectionHead
        icon="heroicons-outline:arrows-right-left"
        title="Questions that need two domains at once"
        hint={
          q.data
            ? `Resolved over the last ${q.data.hours} hours — the same window the coefficient would be computed over. A signal counts as present because it produced readings inside it, never because a row exists.`
            : "Cross-domain questions, resolved against this estate."
        }
      />

      {q.isLoading ? (
        <LoadingBlock label="Resolving the cross-domain questions…" />
      ) : q.error ? (
        <p className="text-[11.5px] text-nb-crit">
          {apiError(q.error, "Could not read the cross-domain registry")}
        </p>
      ) : !t ? (
        // Never a zero: a registry that has not answered has not said the estate
        // has no questions.
        <p className="text-[11.5px] text-nb-faint">
          The registry did not answer, so nothing here knows which questions this estate can ask.
        </p>
      ) : (
        <>
          {/* ── THE PITCH, IN ONE GLANCE ────────────────────────────────────
              The hero is `needs_new_hardware`, and it ships with the other two
              buckets beside it because it is only true in the company of them.
              All three are `totals` reads. */}
          <div className="mt-2 flex flex-wrap items-stretch gap-2">
            <div className="flex min-w-[210px] flex-1 items-center gap-3 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2.5">
              <span className="font-mono text-[26px] leading-none text-nb-ink">
                {t.correlations}
              </span>
              <span className="text-[11px] text-nb-faint">
                cross-domain questions
                <span className="mt-0.5 block text-nb-soft">
                  <span className={t.live ? "text-nb-good" : "text-nb-faint"}>{t.live} live</span> ·{" "}
                  <span className={t.blocked ? "text-nb-warn" : "text-nb-faint"}>
                    {t.blocked} blocked
                  </span>
                </span>
              </span>
            </div>

            <div className="flex min-w-[300px] flex-[2] items-center gap-3 rounded-[10px] border border-[rgba(52,211,153,.35)] bg-[rgba(52,211,153,.06)] px-3 py-2.5">
              <span className="font-mono text-[26px] leading-none text-nb-good">
                {t.needs_new_hardware}
              </span>
              <span className="text-[11px] text-nb-faint">
                of the {t.blocked} blocked need new hardware bought
                <span className="mt-0.5 block">
                  <span className="text-nb-good" title="The customer already owns what these need.">
                    {t.no_new_hardware_needed} need nothing bought
                  </span>{" "}
                  ·{" "}
                  {/* THE TRI-STATE, PRINTED. Undetermined is never folded into
                      "needs nothing", so it gets its own figure and its own
                      colour even when it is the only one that is not zero. */}
                  <span
                    className={t.hardware_undetermined ? "text-nb-warn" : "text-nb-faint"}
                    title="Undetermined is not 'no'. The fact that would settle whether these cost money is in a database the reading store is not allowed to open."
                  >
                    {t.hardware_undetermined} undetermined
                  </span>
                </span>
              </span>
            </div>
          </div>

          {/* What kind of thing is missing, straight off `blocking_gaps_by_kind`.
              One gap per blocked question — never mixed with `signal_gaps_*`,
              which counts a bigger population. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(t.blocking_gaps_by_kind ?? {})
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(([kind, n]) => (
                <span
                  key={kind}
                  title={kindTitle[kind]}
                  className="rounded-[6px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-0.5 text-[10.5px] text-nb-soft"
                >
                  <span className="font-mono text-nb-ink">{String(n)}</span> {kindLabel(kind)}
                </span>
              ))}
          </div>

          {/* The lane scrolls sideways rather than wrapping, for the reason the
              Domains lane does: a wrap is two rows tall on one viewport and one
              on another, and everything below moves for no reason a reader can
              see. */}
          <div className="mt-2 flex gap-3 overflow-x-auto pb-0.5">
            {rows.map((row: any) => (
              <CorrelationCard key={row.key} row={row} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
