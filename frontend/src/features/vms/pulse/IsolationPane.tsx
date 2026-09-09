"use client";

// THE FAULT TRACE — the reason Pulse is worth opening.
//
// A count says something is wrong. This says WHERE: the recorder walks the chain
// it can actually see — camera → network → ingest → decode → storage → display —
// and reports, per stage, what it measured and what it does not instrument at
// all. Its verdict names the attribution, and says explicitly when the recorder
// itself is cleared, which is the sentence that ends the "is it the NVR or the
// network" argument in a control room.
//
// Two rules this pane keeps:
//   * an UNMEASURED stage is grey and says "not instrumented" — never a green
//     tick, which would claim a check nobody ran;
//   * `inconclusive` is rendered as inconclusive. A trace that could not decide
//     must not be shown as a clean bill of health.
import { Icon } from "@iconify/react";

import { LoadingBlock } from "@/components/console";

import type { IsolationStage, IsolationTrace } from "../types";
import { TONE_TEXT, stageTone } from "./format";

const STAGE_ICON: Record<string, string> = {
  camera: "heroicons:video-camera",
  network: "heroicons:signal",
  ingest: "heroicons:arrow-down-on-square",
  decode: "heroicons:cpu-chip",
  storage: "heroicons:circle-stack",
  display: "heroicons:tv",
};

function Stage({ stage }: { stage: IsolationStage }) {
  const tone = stageTone(stage.state, stage.measured);
  return (
    <div
      className={`min-w-[150px] flex-1 rounded-[10px] border px-3 py-2.5 ${
        tone === "bad"
          ? "border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.08)]"
          : tone === "warn"
            ? "border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.08)]"
            : "border-nb-line bg-[rgba(6,11,26,.5)]"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <Icon icon={STAGE_ICON[stage.key] || "heroicons:cube"} className={`text-[13px] ${TONE_TEXT[tone]}`} />
        <p className="truncate text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-faint">
          {stage.label || stage.key}
        </p>
      </div>
      {stage.measured ? (
        <ul className="mt-1.5 space-y-0.5">
          {(stage.evidence || []).map((line, i) => (
            <li
              key={i}
              className={`font-mono text-[10.5px] leading-relaxed ${
                line.tone === "bad"
                  ? "text-nb-crit"
                  : line.tone === "warn"
                    ? "text-nb-warn"
                    : line.tone === "ok"
                      ? "text-nb-soft"
                      : "text-nb-faint"
              }`}
            >
              {line.text}
            </li>
          ))}
        </ul>
      ) : (
        // Not a pass. The recorder is telling us it does not measure this stage.
        <p className="mt-1.5 text-[10.5px] italic text-nb-faint">not instrumented</p>
      )}
    </div>
  );
}

export interface IsolationPaneProps {
  trace?: IsolationTrace;
  loading?: boolean;
  error?: string;
  cameraName?: string;
  onRetest?: () => void;
}

export default function IsolationPane({ trace, loading, error, cameraName, onRetest }: IsolationPaneProps) {
  if (loading) return <LoadingBlock label="Tracing the fault chain…" />;
  if (error) {
    return (
      <div className="p-5">
        <div className="flex items-start gap-2 rounded-[10px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.08)] px-3 py-2.5">
          <Icon icon="heroicons:signal-slash" className="mt-0.5 shrink-0 text-[15px] text-nb-crit" />
          <div className="min-w-0">
            <p className="text-[12.5px] text-nb-crit">Could not trace this camera</p>
            <p className="mt-0.5 break-words font-mono text-[11px] text-nb-faint">{error}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!trace) return null;

  const v = trace.verdict || ({} as IsolationTrace["verdict"]);
  const level = String(v.level || "").toLowerCase();
  const tone = level === "fault" ? "bad" : level === "ok" ? "good" : "idle";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div
        className={`rounded-[10px] border px-3 py-2.5 ${
          tone === "bad"
            ? "border-[rgba(248,113,113,.45)] bg-[rgba(248,113,113,.08)]"
            : tone === "good"
              ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)]"
              : "border-nb-line bg-[rgba(6,11,26,.5)]"
        }`}
      >
        <div className="flex items-center gap-2">
          <Icon
            icon={
              level === "fault"
                ? "heroicons:exclamation-triangle"
                : level === "ok"
                  ? "heroicons:check-circle"
                  : "heroicons:question-mark-circle"
            }
            className={`text-[15px] ${TONE_TEXT[tone]}`}
          />
          <p className={`text-[13px] font-semibold ${TONE_TEXT[tone]}`}>
            {level === "fault"
              ? `Fault isolated: ${(v.attribution || "unknown").toUpperCase()}`
              : level === "ok"
                ? "No fault found"
                : "Inconclusive"}
          </p>
          {v.nvr_cleared && (
            <span className="rounded-full border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] px-2 py-0.5 text-[10px] font-medium text-nb-good">
              recorder cleared
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-nb-muted">
          {v.summary || (cameraName ? `Trace for ${cameraName}` : "")}
        </p>
        {(v.not_instrumented || []).length > 0 && (
          // Said out loud, because a verdict is only as strong as what it could
          // see, and the operator is entitled to know what it could not.
          <p className="mt-1.5 text-[10.5px] text-nb-faint">
            Not measured by this recorder: {(v.not_instrumented || []).join(", ")}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(trace.stages || []).map((s) => (
          <Stage key={s.key} stage={s} />
        ))}
      </div>

      {onRetest && (
        <button
          onClick={onRetest}
          className="mt-3 inline-flex items-center gap-1.5 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-[11.5px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          <Icon icon="heroicons:arrow-path" className="text-[13px]" />
          Re-test now
        </button>
      )}
    </div>
  );
}
