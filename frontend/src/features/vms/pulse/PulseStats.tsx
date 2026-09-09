"use client";

// The five figures Pulse opens with — the operator's questions, in order:
// how much of the estate is even answering, how many cameras are up, is footage
// being written, how full is the fullest disk, how far back can I go.
//
// The partial banner above them is not decoration. With one recorder unreachable
// "109 / 112" is a lie that looks precise: those 112 are the cameras of the
// recorders that answered, and the unreachable one's cameras are simply absent.
import { Icon } from "@iconify/react";

import type { PulseOverview } from "../types";
import { TONE_TEXT, answeredLabel, pctText, recordingLabel, volumeTone, type Tone } from "./format";

function Stat({
  label,
  value,
  sub,
  tone = "idle",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  icon: string;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <Icon icon={icon} className="text-[13px] text-nb-faint" />
        <p className="truncate text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
          {label}
        </p>
      </div>
      <p className={`mt-1 font-mono text-[19px] leading-none ${TONE_TEXT[tone]}`}>{value}</p>
      {sub && <p className="mt-1 truncate text-[10.5px] text-nb-faint">{sub}</p>}
    </div>
  );
}

export default function PulseStats({ data }: { data: PulseOverview }) {
  const t = data.totals;
  const partial = answeredLabel(data);
  const rec = recordingLabel(t.recording_gap_free, t.cameras_recording);
  const worst = data.storage.worst_used_percent;
  const camerasDown = t.cameras_total - t.cameras_online;

  return (
    <div className="mb-3 shrink-0 space-y-2">
      {partial && (
        <div className="flex items-start gap-2 rounded-[10px] border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.1)] px-3 py-2">
          <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 shrink-0 text-[14px] text-nb-warn" />
          <p className="text-[11.5px] leading-relaxed text-nb-warn">{partial}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Stat
          icon="heroicons:server-stack"
          label="Recorders"
          value={`${t.recorders_answered} / ${t.recorders}`}
          sub={data.partial ? "one or more did not answer" : "all answered"}
          tone={data.partial ? "warn" : "good"}
        />
        <Stat
          icon="heroicons:video-camera"
          label="Cameras online"
          value={`${t.cameras_online} / ${t.cameras_total}`}
          sub={
            data.partial
              ? "of the recorders that answered"
              : camerasDown > 0
                ? `${camerasDown} down`
                : "all up"
          }
          tone={camerasDown > 0 ? "warn" : "good"}
        />
        <Stat
          icon="heroicons:film"
          label="Recording"
          value={String(t.cameras_recording)}
          sub={rec.text}
          tone={rec.tone}
        />
        <Stat
          icon="heroicons:circle-stack"
          label="Fullest volume"
          value={pctText(worst)}
          sub={
            data.storage.volumes_measured < data.storage.volumes_total
              ? `${data.storage.volumes_measured} of ${data.storage.volumes_total} volumes measured`
              : `${data.storage.volumes_total} volume(s)`
          }
          tone={volumeTone(worst)}
        />
        <Stat
          icon="heroicons:clock"
          label="Retention"
          value={
            data.storage.retention_days_min == null ? "—" : `${data.storage.retention_days_min}d`
          }
          sub="shortest default across the estate"
          tone="idle"
        />
      </div>
    </div>
  );
}
