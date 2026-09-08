// Health formatting shared by the list and the log pane.
import type { ServiceOut } from "../types";

export interface StateLook {
  label: string;
  /** Text colour class. */
  tone: string;
  /** Status dot class. */
  dot: string;
}

/**
 * How one service reads at a glance.
 *
 * A container with NO healthcheck is not unhealthy — most of the estate declares
 * one, a few (nats' sidecars, one-shots) do not, and painting those red would
 * make the page cry wolf. "Running" is the honest word for them.
 */
export function serviceState(s: Pick<ServiceOut, "state" | "health" | "running">): StateLook {
  if (!s.running) {
    const stopped = s.state === "exited" || s.state === "dead";
    return stopped
      ? { label: s.state === "dead" ? "Dead" : "Stopped", tone: "text-nb-crit", dot: "bg-nb-crit shadow-[0_0_8px_#f87171]" }
      : { label: s.state, tone: "text-nb-warn", dot: "bg-nb-warn shadow-[0_0_8px_#fbbf24]" };
  }
  if (s.health === "unhealthy") {
    return { label: "Unhealthy", tone: "text-nb-crit", dot: "bg-nb-crit shadow-[0_0_8px_#f87171]" };
  }
  if (s.health === "starting") {
    return { label: "Starting", tone: "text-nb-warn", dot: "bg-nb-warn shadow-[0_0_8px_#fbbf24]" };
  }
  if (s.health === "healthy") {
    return { label: "Healthy", tone: "text-nb-good", dot: "bg-nb-good shadow-[0_0_8px_#34d399]" };
  }
  return { label: "Running", tone: "text-nb-soft", dot: "bg-nb-soft" };
}

/** True when this service is something an operator should look at now. */
export function needsAttention(s: Pick<ServiceOut, "state" | "health" | "running">): boolean {
  return !s.running || s.health === "unhealthy";
}

/** "3d 4h" / "2h 15m" / "4m" since `iso`, or "—". */
export function uptime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "—";
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Split one docker log line into its RFC3339 timestamp and the message.
 *
 * The agent asks docker for timestamps, so every line begins with one. Kept as a
 * parse rather than a regex at the call site: the viewer polls with `since`, and
 * the timestamp it sends is read back out of the last line it holds — if this
 * drifts, a follow either loops the same lines or skips them.
 */
export function splitLine(line: string): { ts: string | null; text: string } {
  const sp = line.indexOf(" ");
  if (sp <= 0) return { ts: null, text: line };
  const head = line.slice(0, sp);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(head)) return { ts: null, text: line };
  return { ts: head, text: line.slice(sp + 1) };
}

/** Unix SECONDS of the newest line, for the next poll's `since`. 0 when unknown. */
export function sinceOf(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const { ts } = splitLine(lines[i]);
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    // Floor, then step back one second: docker's `since` is second-granular and
    // exclusive-ish, so rounding forward drops every line inside the same second.
    // The overlap it costs is removed by the caller's de-duplication.
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000) - 1;
  }
  return 0;
}

/** A log line's severity, read from the level word the services print. */
export function lineTone(text: string): string {
  if (/\b(ERROR|CRITICAL|FATAL|Traceback)\b/.test(text)) return "text-nb-crit";
  if (/\bWARN(ING)?\b/.test(text)) return "text-nb-warn";
  if (/\bDEBUG\b/.test(text)) return "text-nb-faint";
  return "text-nb-soft";
}
