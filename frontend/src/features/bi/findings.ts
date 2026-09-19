// GATE 6 · ACTS — which findings are work, and which are just readings.
//
// The store hands back every outcome it computed for a building's equipment,
// plus the alerts the gateway raised. Most of them are not work.
//
// THE RULE, AND WHY IT IS NOT "status !== ok". A metric's `status` is NOT a
// pass mark. `ok` means the metric COMPUTED — the registry has no threshold that
// says a value is bad, and none was invented here. So a chiller running a
// perfectly healthy ΔT comes back `ok`, and offering to raise work about it
// would be inventing a fault. What IS work:
//
//   * a REFUSAL (`status` anything but `ok`) — the number could not be produced
//     and the reason names what is missing: a slot with no point, a design band
//     nobody recorded, a unit nobody confirmed. Each is a real task with a real
//     door, and it is the operator's call whether it deserves a ticket;
//   * a DATA FAULT — a bound sensor that has gone silent, or a tag two live
//     points answer to. The binding is right and the data is not;
//   * an UNACKNOWLEDGED ALERT — the gateway itself said something is wrong.
//
// An acknowledged alert is already somebody's; it is listed, not offered.
import type { OpenWork } from "@/features/workflow/types";

/** The incident body a finding would raise, exactly as the store composed it.
 *  The console adds the procedure and nothing else — it never writes evidence,
 *  because evidence it composed would be evidence nobody measured. */
export interface FindingWork {
  source_key: string;
  name: string;
  description: string;
  site_id: string | null;
  trigger_data: Record<string, unknown>;
}

export interface Finding {
  source_key: string;
  kind: "equipment_metric" | "data_fault" | "alert";
  status: string;
  equipment_id?: string | null;
  equipment_tag?: string | null;
  title: string;
  summary?: string | null;
  evidence?: Record<string, unknown> | null;
  work: FindingWork;
}

/** An alert row as `/bi/alerts` returns it, in the one shape gate 6 reads. */
export interface AlertLike {
  alert_id: string;
  ts: string;
  severity?: string | null;
  alert_type?: string | null;
  device_tag?: string | null;
  message?: string | null;
  acked?: boolean | null;
  source_key?: string | null;
  work?: FindingWork | null;
}

export const isRefusal = (f: { status?: string | null }) => !!f.status && f.status !== "ok";

/** Work, or a reading? See the rule above. */
export function isActionable(f: Finding): boolean {
  if (f.kind === "data_fault") return true;
  if (f.kind === "alert") return f.status !== "acked";
  return isRefusal(f);
}

/** The findings an operator could raise work about, worst kind first: a fault in
 *  the data, then a refusal, then what the gateway itself raised. */
export function actionable(findings: Finding[]): Finding[] {
  const rank: Record<Finding["kind"], number> = { data_fault: 0, equipment_metric: 1, alert: 2 };
  return findings
    .filter(isActionable)
    .slice()
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title));
}

/** An alert becomes a finding only when the store gave it a key and a body. An
 *  alert older than the wire change has neither, and inventing one here would
 *  let two consoles disagree about what a key means. */
export function alertFindings(alerts: AlertLike[]): Finding[] {
  return alerts
    .filter((a) => !!a.source_key && !!a.work)
    .map((a) => ({
      source_key: a.source_key as string,
      kind: "alert" as const,
      status: a.acked ? "acked" : "open",
      equipment_id: null,
      equipment_tag: a.device_tag ?? null,
      title: a.work?.name || a.message || `Alert on ${a.device_tag ?? "an unnamed device"}`,
      summary: a.message ?? null,
      evidence: null,
      work: a.work as FindingWork,
    }));
}

export interface WorkSplit {
  withWork: { finding: Finding; work: OpenWork }[];
  withoutWork: Finding[];
}

/** Split an actionable set by whether work is already open about it.
 *  A key the lookup has not answered for counts as WITHOUT work only when the
 *  lookup answered at all — an unread lookup returns `null`, so a caller prints
 *  "not known" rather than offering to raise a second ticket. */
export function splitByWork(
  findings: Finding[],
  open: Record<string, OpenWork> | null | undefined,
): WorkSplit | null {
  if (!open) return null;
  const withWork: WorkSplit["withWork"] = [];
  const withoutWork: Finding[] = [];
  for (const f of findings) {
    const w = open[f.source_key];
    if (w) withWork.push({ finding: f, work: w });
    else withoutWork.push(f);
  }
  return { withWork, withoutWork };
}

/** Every key gate 6 asks the workflow service about, de-duplicated and capped at
 *  the 500 the route accepts — a 501st key is a 422 for the whole call. */
export const MAX_KEYS = 500;
export const keysOf = (findings: Finding[]): string[] =>
  Array.from(new Set(findings.map((f) => f.source_key))).slice(0, MAX_KEYS);
