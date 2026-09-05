"use client";

// THE CHALLENGE — what an operator sees instead of a silent success.
//
// The server refuses a unit or a role asserted on a point that is carrying no
// readings (POINT_NOT_REPORTING, backend/reading-writer/app/api/intake.py). This
// renders that refusal: which points, what state they are in, when they last
// carried a value, and — the part that would have caught the real mistake — the
// points on the SAME device that ARE reporting, so the spelling that works is on
// screen beside the spelling that does not.
//
// It does NOT offer to fix it. Clicking a sibling tag does nothing, because
// rebinding to the tag that looks closest is the guess this whole subsystem
// refuses to make on a human's behalf. The operator retypes their selection.
//
// "Assert anyway" resends the SAME request with `acknowledge_not_reporting`.
// That flag is a second, different statement — it exists so a real address on a
// device that is merely offline stays confirmable, and it is per request so it
// cannot be switched on once and forgotten.
import { ActionButton, QuietButton } from "@/components/console";

export interface NotReportingDetail {
  what?: string;
  requested?: number;
  challenged?: number;
  thresholds?: { first_reading_grace_minutes?: number; silent_after_hours?: number };
  points?: {
    point_id: string;
    device_tag?: string | null;
    point_tag?: string | null;
    state: string;
    last_reading_at?: string | null;
    reporting_siblings?: string[];
  }[];
}

/** The refusal's `details`, or null when the error was something else. */
export function notReportingDetail(error: unknown): NotReportingDetail | null {
  const body = (error as any)?.response?.data?.error;
  if (!body || body.code !== "POINT_NOT_REPORTING") return null;
  return (body.details || {}) as NotReportingDetail;
}

export default function NotReportingChallenge({
  detail,
  message,
  onAssertAnyway,
  onCancel,
  busy,
}: {
  detail: NotReportingDetail;
  message?: string;
  onAssertAnyway: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const points = detail.points || [];
  const silentHours = detail.thresholds?.silent_after_hours ?? 24;
  return (
    <div className="space-y-2 rounded-[12px] border border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.07)] px-3 py-2.5">
      <div className="text-[11.5px] text-nb-warn">
        {message ||
          `Not stored: ${points.length} of the selected point(s) are carrying no readings.`}
      </div>

      <div className="overflow-x-auto rounded-[8px] border border-nb-line">
        <table className="w-full min-w-[620px] text-left">
          <thead>
            <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
              <th className="px-3 py-1.5 font-semibold">Point</th>
              <th className="px-3 py-1.5 font-semibold">State</th>
              <th className="px-3 py-1.5 font-semibold">Last reading</th>
              <th className="px-3 py-1.5 font-semibold">Reporting on the same device</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.point_id} className="border-t border-nb-line/50">
                <td className="px-3 py-1.5 font-mono text-[11.5px] text-nb-ink">
                  <span className="text-nb-soft">{p.device_tag} / </span>
                  {p.point_tag}
                </td>
                <td className="px-3 py-1.5 text-[11px] text-nb-warn">
                  {p.state === "never_reported"
                    ? "never reported — this address has produced no value, ever"
                    : `silent — nothing for over ${silentHours}h`}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-nb-faint">
                  {p.last_reading_at ? p.last_reading_at.replace("T", " ").slice(0, 19) : "never"}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-nb-soft">
                  {p.reporting_siblings?.length ? (
                    p.reporting_siblings.join(", ")
                  ) : (
                    <span className="italic text-nb-faint">nothing on this device is reporting</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10.5px] leading-relaxed text-nb-faint">
        A tag on the right that resembles the one on the left is the usual cause: the device was
        re-tagged and the old address stopped publishing. Nothing here rebinds anything — reselect
        the point you meant. If the address IS right and the device is simply offline, assert it
        anyway; the confirmation is recorded as yours either way.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <ActionButton onClick={onAssertAnyway} disabled={busy}>
          {busy ? "Saving…" : "Assert anyway — I know these are not reporting"}
        </ActionButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    </div>
  );
}
