"use client";

// UNIT PATTERNS — the catalogue of tag conventions, and the only bulk path that
// is allowed to exist.
//
// 766 live points, 190 with a confirmed unit. The backlog is real and it is not
// 576 decisions: `1FYC1_IWT`, `4FKC2_IWT` and `1FYorkChiller1_IWT` are one
// decision about one convention. So the server grew a pattern selector, which
// repealed a prohibition `units.py` used to state outright — "a bulk
// confirmation is a list of point ids the operator saw before they pressed the
// button, never a pattern the server expands on its own, because 'apply to
// everything matching `_kw`' evaluated server-side is a guess wearing a human's
// authority."
//
// THE REPEAL IS ONLY SOUND BECAUSE OF THIS SCREEN. The one thing that turns a
// regex back into a human's decision is that the human saw the rows. So the
// apply button does not exist until a DRY RUN has come back and printed
// `would_update` — the actual device/point labels, every one of them, scrollable
// — and it applies exactly the set that preview enumerated. A count-only
// confirmation would make the original objection true again, so there is no code
// path here that posts without `dry_run` having rendered first.
//
// THREE KINDS OF ROW, NEVER FLATTENED:
//   unit       a unit is proposed; this is the only kind that can be applied.
//   state      `OnOff STS`, `Work_Mode`. Not a measurement at all.
//   ambiguous  `KWL1_A` names power and ends in the amps suffix; `Cum_Flow`
//              does not say whether it is a volume or a rate.
// The last two are a deliberate ANSWER, not an error and not an empty state:
// the pattern exists so the collision is visible, and the refusal to guess is
// the feature. They render with their reason and offer nothing to press.
//
// AND `""` IS NOT `null`. An empty unit is power factor's real assertion that
// the quantity is dimensionless; a null one is the catalogue proposing nothing.
// Printing both as a blank would merge a decision with the absence of one.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { ActionButton, LoadingBlock, QuietButton } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { bi } from "../api";
import { PERM_MANAGE } from "../constants";
import NotReportingChallenge, {
  notReportingDetail,
  type NotReportingDetail,
} from "./NotReportingChallenge";

/** What the catalogue proposes, in words. The three states are three different
 *  facts and each one gets its own sentence. */
function Proposal({ p }: Readonly<{ p: any }>) {
  if (p.proposes_unit === false || p.unit === null || p.unit === undefined) {
    return <span className="italic text-nb-faint">no unit proposed</span>;
  }
  if (p.unit === "") {
    // Power factor. The operator's assertion is that there IS no dimension —
    // which is a confirmed answer, not a blank waiting to be filled.
    return <span className="text-nb-ink">dimensionless — a ratio, deliberately no unit</span>;
  }
  return <span className="font-mono text-nb-ink">{p.unit}</span>;
}

const KIND_LABEL: Record<string, string> = {
  unit: "measurement",
  state: "state, not a measurement",
  ambiguous: "ambiguous tag",
};

const KIND_CLS: Record<string, string> = {
  unit: "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] text-nb-good",
  state: "border-nb-line bg-[rgba(6,11,26,.5)] text-nb-soft",
  ambiguous: "border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.07)] text-nb-warn",
};

export default function UnitPatterns({ category }: Readonly<{ category?: string }>) {
  const { can } = useAuth();
  const mayWrite = can(PERM_MANAGE);

  // The dry run, keyed by the pattern it previewed. One at a time: a second
  // preview replaces the first, so the rows on screen and the set the apply
  // button would write can never belong to different patterns.
  const [preview, setPreview] = useState<{ key: string; res: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<NotReportingDetail | null>(null);
  const [challengeMsg, setChallengeMsg] = useState<string | null>(null);

  const q = useQuery<any>({
    queryKey: ["bi-unit-patterns", category ?? null],
    queryFn: () => bi.unitPatterns({ category }),
  });

  const patterns: any[] = q.data?.patterns ?? [];
  const totals = q.data?.totals;

  const dry = useMutation({
    mutationFn: (key: string) =>
      bi.confirmUnitPattern({ pattern: key, category, dry_run: true }),
    onSuccess: (res: any, key) => {
      setErr(null);
      setDone(null);
      setChallenge(null);
      setPreview({ key, res });
    },
    onError: (e) => {
      setPreview(null);
      setErr(apiError(e, "Could not preview this pattern"));
    },
  });

  const apply = useMutation({
    mutationFn: ({ key, acknowledge }: { key: string; acknowledge?: boolean }) =>
      bi.confirmUnitPattern({
        pattern: key,
        category,
        dry_run: false,
        acknowledge_not_reporting: acknowledge,
      }),
    onSuccess: (res: any) => {
      setErr(null);
      setChallenge(null);
      setChallengeMsg(null);
      setPreview(null);
      setDone(
        `${res.updated} point(s) recorded as “${res.unit === "" ? "dimensionless (a ratio)" : res.unit}”` +
          (res.skipped_already_confirmed_count
            ? ` · ${res.skipped_already_confirmed_count} left alone because a person had already ruled on them`
            : ""),
      );
      // The catalogue's own numbers move, and so does every units read beside it.
      q.refetch();
    },
    onError: (e) => {
      setDone(null);
      const detail = notReportingDetail(e);
      if (detail) {
        setErr(null);
        setChallenge(detail);
        setChallengeMsg(apiError(e, "Not stored"));
        return;
      }
      setChallenge(null);
      setErr(apiError(e, "Could not apply this pattern"));
    },
  });

  if (q.isLoading) return <LoadingBlock label="Loading tag conventions…" />;
  if (q.error) {
    return (
      <p className="text-[12px] text-nb-crit">
        {apiError(q.error, "Could not load the pattern catalogue")}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
          Tag conventions
        </div>
        {totals && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-soft">
              {totals.matched} points a pattern claims
            </span>
            <span className="rounded-[6px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)] px-2 py-0.5 text-nb-warn">
              {totals.eligible} still to confirm
            </span>
            <span className="rounded-[6px] border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] px-2 py-0.5 text-nb-good">
              {totals.already_confirmed} a person already ruled on
            </span>
            <span
              className="rounded-[6px] border border-nb-line px-2 py-0.5 text-nb-faint"
              title="Tags no convention reads. They stay one-by-one work in the list below."
            >
              {totals.unmatched} no pattern reads
            </span>
          </div>
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-nb-faint">
        A convention is not evidence and nothing here is applied by being displayed. Confirming one
        shows you every point it would change, by name, before anything is written — and writes
        exactly that set, in the unit the catalogue proposed.
      </p>

      {!patterns.length ? (
        <p className="py-4 text-center text-[11.5px] text-nb-faint">
          No tag convention matches anything in this view.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {patterns.map((p) => {
            // The preview, only when it belongs to THIS pattern. Held as the
            // object rather than a boolean so the rows on screen and the set the
            // apply button writes are one value.
            const pv = preview && preview.key === p.key ? preview : null;
            const appliable = p.kind === "unit" && p.proposes_unit !== false;
            return (
              <li
                key={p.key}
                className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[12.5px] font-medium text-nb-ink">{p.label}</span>
                  <span className="font-mono text-[10.5px] text-nb-faint">{p.key}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${KIND_CLS[p.kind] || KIND_CLS.state}`}
                  >
                    {KIND_LABEL[p.kind] || p.kind}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-nb-soft">
                    <Proposal p={p} />
                  </span>
                </div>

                <p className="mt-1 text-[10.5px] leading-relaxed text-nb-faint">{p.basis}</p>

                {/* Three counts, never summed. 40 matched / 40 confirmed is
                    finished work; 40 / 0 is forty points of backlog. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px]">
                  <span className="text-nb-soft">{p.matched} matched</span>
                  <span className="text-nb-warn">{p.eligible} to confirm</span>
                  <span className="text-nb-good">{p.already_confirmed} already stated</span>
                  {p.sample_tags?.length ? (
                    <span className="truncate text-nb-faint">
                      e.g. {p.sample_tags.slice(0, 4).join(", ")}
                    </span>
                  ) : null}
                </div>

                {/* The deliberate refusal. Not an error, not an empty state —
                    the answer this pattern exists to give. */}
                {!appliable && (
                  <p className="mt-1.5 rounded-[8px] border border-dashed border-nb-line px-2.5 py-1.5 text-[10.5px] leading-relaxed text-nb-soft">
                    Nothing is proposed for this convention and it cannot be applied in bulk —{" "}
                    {p.kind === "state"
                      ? "these tags are a state, not a measurement, so there is no unit to write."
                      : "the tag names one quantity and carries another's suffix, so which one it measures is a question a person answers."}{" "}
                    Settle these points one at a time in the list below.
                  </p>
                )}

                {appliable && mayWrite && p.eligible > 0 && !pv && (
                  <div className="mt-2">
                    <QuietButton
                      onClick={() => dry.mutate(p.key)}
                      disabled={dry.isPending}
                    >
                      {dry.isPending && dry.variables === p.key
                        ? "Resolving…"
                        : `Show the ${p.eligible} point(s) this would change`}
                    </QuietButton>
                  </div>
                )}

                {appliable && mayWrite && p.eligible === 0 && (
                  <p className="mt-1.5 text-[10.5px] text-nb-faint">
                    Nothing left to confirm under this convention.
                  </p>
                )}

                {pv && (
                  <PatternPreview
                    pattern={p}
                    res={pv.res}
                    busy={apply.isPending}
                    onApply={() => {
                      setChallenge(null);
                      setChallengeMsg(null);
                      apply.mutate({ key: p.key });
                    }}
                    onCancel={() => setPreview(null)}
                  />
                )}

                {pv && challenge && (
                  <div className="mt-2">
                    <NotReportingChallenge
                      detail={challenge}
                      message={challengeMsg || undefined}
                      busy={apply.isPending}
                      onAssertAnyway={() => apply.mutate({ key: p.key, acknowledge: true })}
                      onCancel={() => {
                        setChallenge(null);
                        setChallengeMsg(null);
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {q.data?.unmatched_sample?.length ? (
        <p className="text-[10.5px] leading-relaxed text-nb-faint">
          No convention reads{" "}
          <span className="font-mono text-nb-soft">
            {q.data.unmatched_sample.slice(0, 6).join(", ")}
          </span>
          . Those are one-by-one work, and saying so is the honest report.
        </p>
      ) : null}

      {done && <p className="text-[11.5px] text-nb-good">{done}</p>}
      {err && <p className="text-[11.5px] text-nb-crit">{err}</p>}
      {!mayWrite && (
        <p className="text-[11px] text-nb-faint">
          Confirming a convention needs <span className="font-mono">bi.manage</span>. You can read
          what each one holds and what a person has already decided.
        </p>
      )}
    </div>
  );
}

/** The dry run, on screen. The rows — not the count — are what makes the apply
 *  button a human's decision, so they are rendered in full and the button lives
 *  inside this block and nowhere else. */
function PatternPreview({
  pattern,
  res,
  busy,
  onApply,
  onCancel,
}: Readonly<{
  pattern: any;
  res: any;
  busy?: boolean;
  onApply: () => void;
  onCancel: () => void;
}>) {
  const rows: any[] = res?.would_update ?? [];
  const skipped: any[] = res?.skipped_already_confirmed ?? [];
  const notReporting: any[] = res?.confirmed_not_reporting ?? [];
  const unitText = pattern.unit === "" ? "dimensionless (a ratio)" : pattern.unit;

  return (
    <div className="mt-2 space-y-2 rounded-[10px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.07)] px-3 py-2.5">
      <p className="text-[11.5px] text-nb-ink">
        Nothing has been written. These are the {res?.would_update_count ?? rows.length} point(s)
        that would be recorded as <span className="font-mono">{unitText}</span>.
      </p>

      {rows.length === 0 ? (
        <p className="text-[11px] text-nb-warn">
          The preview came back empty — the set moved between the catalogue read and this call.
          Reload before applying anything.
        </p>
      ) : (
        <ul className="scroll-themed max-h-56 space-y-0.5 overflow-y-auto rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2.5 py-1.5">
          {rows.map((r) => (
            <li key={r.point_id} className="font-mono text-[11px] text-nb-soft">
              {r.label}
            </li>
          ))}
        </ul>
      )}

      {skipped.length > 0 && (
        <p className="text-[10.5px] leading-relaxed text-nb-good">
          {skipped.length} point(s) are left alone because a person already stated their unit —{" "}
          <span className="font-mono">{skipped.slice(0, 4).map((s) => s.point_tag).join(", ")}</span>
          . A pattern never overrules a person.
        </p>
      )}

      {notReporting.length > 0 && (
        <p className="text-[10.5px] leading-relaxed text-nb-warn">
          <Icon icon="heroicons:exclamation-triangle" className="mr-1 inline text-[12px]" />
          {notReporting.length} of them are carrying no readings. A unit asserted on an address that
          has produced no number is a fact no rating can use — the server will refuse, and say so.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ActionButton onClick={onApply} disabled={busy || rows.length === 0}>
          {busy ? "Saving…" : `Confirm these ${rows.length} point(s) as “${unitText}”`}
        </ActionButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    </div>
  );
}
