"use client";

// One recorder's System-Monitor board, as the recorder reports it.
//
// The recorder is the only party that can measure any of this — it holds the
// stream, the segment index and the disk — so the VMS relays rather than
// recomputes. Two of its honesty flags decide what renders here:
//
//   `sensors_reported: false` — the box gave no usable hardware sample and the
//   system block is zeros. Printing "0% CPU · 0°C" for a machine nobody measured
//   is the exact failure this whole surface exists to avoid, so the strip says
//   "no hardware sample" instead.
//
//   `raid_supported: false` — an empty RAID list means "no arrays here" on Linux
//   and "we never had a source to read" everywhere else. The node sends the flag
//   and its reason; both are shown.
import { Icon } from "@iconify/react";

import { LoadingBlock } from "@/components/console";

import type { NodeSysmon, PulseVolume } from "../types";
import { TONE_BAR, TONE_TEXT, recordingLabel, verdictTone, volumeLabel, volumeTone } from "./format";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The recorder's hardware sample names its fields `cpu_percent` / `mem_percent`
 *  (nvr `hwstat.SysUsage`). Read the recorder's spelling first and accept the
 *  shorter one as a fallback rather than pinning to a single string: a board that
 *  renamed a field would otherwise render "—" for a machine it did measure, which
 *  is the same lie as printing 0 — just quieter. */
function sysNum(system: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = num(system[k]);
    if (v != null) return v;
  }
  return null;
}

/** A percentage, or "—" when the box reported no usable sample. Never 0. */
function metric(sensors: boolean, pct: number | null): string {
  return sensors && pct != null ? `${Math.round(pct)}%` : "—";
}

function Metric({ label, value, tone = "idle" }: { label: string; value: string; tone?: keyof typeof TONE_TEXT }) {
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">{label}</p>
      <p className={`mt-1 font-mono text-[15px] leading-none ${TONE_TEXT[tone]}`}>{value}</p>
    </div>
  );
}

function VolumeBar({ volume }: { volume: PulseVolume }) {
  const pct = volume.used_percent;
  const tone = volumeTone(pct);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] text-nb-ink">{volume.name || volume.path || "volume"}</span>
        <span className={`shrink-0 font-mono text-[11px] ${TONE_TEXT[tone]}`}>{volumeLabel(volume)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[rgba(10,18,40,.8)]">
        {/* No bar at all when there is no reading — a zero-width bar and a
            zero-percent bar look identical, and one of them is a claim. */}
        {pct != null && (
          <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${Math.min(100, pct)}%` }} />
        )}
      </div>
      <p className="mt-0.5 truncate font-mono text-[10px] text-nb-faint">
        {volume.usage_error || volume.path || volume.pool_type || ""}
      </p>
    </div>
  );
}

export interface RecorderBoardProps {
  board?: NodeSysmon;
  loading?: boolean;
  error?: string;
  /** Open one camera's fault trace. */
  onIsolate?: (cameraId: string) => void;
}

export default function RecorderBoard({ board, loading, error, onIsolate }: RecorderBoardProps) {
  if (loading) return <LoadingBlock label="Reading the recorder…" />;
  if (error) {
    return (
      <div className="p-5">
        <div className="flex items-start gap-2 rounded-[10px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.08)] px-3 py-2.5">
          <Icon icon="heroicons:signal-slash" className="mt-0.5 shrink-0 text-[15px] text-nb-crit" />
          <div className="min-w-0">
            <p className="text-[12.5px] text-nb-crit">The recorder did not answer</p>
            <p className="mt-0.5 break-words font-mono text-[11px] text-nb-faint">{error}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!board) return null;

  const verdict = board.verdict || {};
  const tone = verdictTone(verdict.level);
  const cameras = (board.cameras || {}) as Record<string, unknown>;
  const system = (board.system || {}) as Record<string, unknown>;
  const sensors = board.sensors_reported !== false;
  const volumes = (board.volumes || []) as PulseVolume[];
  const rows = (cameras.items || []) as Record<string, unknown>[];
  const rec = recordingLabel(
    (cameras.recording_gap_free as boolean | null) ?? null,
    Number(cameras.recording_active || 0),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {/* the recorder's own verdict, in its own words */}
      <div className={`rounded-[10px] border px-3 py-2.5 ${
        tone === "bad"
          ? "border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.08)]"
          : tone === "warn"
            ? "border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)]"
            : "border-nb-line bg-[rgba(6,11,26,.5)]"
      }`}>
        <p className={`text-[13px] font-semibold ${TONE_TEXT[tone]}`}>
          {verdict.headline || "No verdict reported"}
        </p>
        {verdict.detail && <p className="mt-0.5 text-[11.5px] text-nb-muted">{verdict.detail}</p>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Cameras online" value={`${cameras.online ?? 0} / ${cameras.total ?? 0}`} />
        <Metric label="Recording" value={String(cameras.recording_active ?? 0)} tone={rec.tone} />
        <Metric label="CPU" value={metric(sensors, sysNum(system, "cpu_percent", "cpu_pct"))} />
        <Metric label="Memory" value={metric(sensors, sysNum(system, "mem_percent", "mem_pct"))} />
      </div>
      {!sensors && (
        <p className="mt-1.5 text-[10.5px] text-nb-faint">
          This recorder reported no hardware sample — CPU, memory and temperature are unknown, not
          zero.
        </p>
      )}
      <p className="mt-1.5 text-[10.5px] text-nb-faint">Recording: {rec.text}</p>

      {volumes.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            Storage
          </h3>
          <div className="space-y-2.5">
            {volumes.map((v, i) => (
              <VolumeBar key={`${v.name}-${i}`} volume={v} />
            ))}
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            Cameras
          </h3>
          <div className="space-y-1">
            {rows.map((c) => {
              const online = String(c.status || "").toLowerCase() === "online";
              const id = String(c.id || "");
              return (
                <button
                  key={id}
                  onClick={() => onIsolate?.(id)}
                  title="Trace this camera's fault chain"
                  className="flex w-full items-center gap-2 rounded-[8px] border border-transparent px-2 py-1.5 text-left transition hover:border-[rgba(150,180,245,.35)] hover:bg-[rgba(96,165,250,.06)]"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-nb-good" : c.enabled === false ? "bg-nb-faint" : "bg-nb-crit"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-nb-ink">
                    {String(c.name || id)}
                  </span>
                  {c.recording_active ? (
                    <Icon icon="heroicons:film" className="shrink-0 text-[12px] text-nb-good" title="recording" />
                  ) : null}
                  <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">
                    {String(c.status || "unknown")}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
