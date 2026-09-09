"use client";

// One line of "what needs me", in the rail. The backend ranks them (a recorder
// nobody can reach outranks a full disk, because while it is unreachable every
// other number about it is unknown too); this renders that order without
// re-sorting it.
//
// A row is CLICKABLE when it leads somewhere: an offline camera opens its fault
// trace, a recorder item opens that recorder's board. A row with nowhere to go —
// a volume warning, say — is still worth reading and is rendered as text, not as
// a button that does nothing when pressed.
import { Icon } from "@iconify/react";

import type { PulseAttentionItem } from "../types";
import { SEVERITY_TONE, TONE_TEXT } from "./format";

const ICON: Record<string, string> = {
  recorder_unreachable: "heroicons:signal-slash",
  recorder_down: "heroicons:exclamation-circle",
  recorder_degraded: "heroicons:exclamation-triangle",
  recording_gaps: "heroicons:film",
  volume_full: "heroicons:circle-stack",
  volume_high: "heroicons:circle-stack",
  volume_unreadable: "heroicons:question-mark-circle",
  camera_offline: "heroicons:video-camera-slash",
};

export interface AttentionRowProps {
  item: PulseAttentionItem;
  selected: boolean;
  onSelect?: () => void;
}

export default function AttentionRow({ item, selected, onSelect }: AttentionRowProps) {
  const tone = SEVERITY_TONE[item.severity] ?? "idle";
  const body = (
    <>
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.6)] ${TONE_TEXT[tone]}`}
      >
        <Icon icon={ICON[item.kind] || "heroicons:exclamation-circle"} className="text-[14px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-nb-ink">{item.item}</span>
        <span className="block truncate font-mono text-[10px] text-nb-faint">
          {[item.where, item.detail].filter(Boolean).join(" · ") || "—"}
        </span>
      </span>
    </>
  );

  if (!onSelect) {
    return (
      <div className="flex w-full items-start gap-2.5 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-left">
        {body}
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-[rgba(96,165,250,.6)] bg-[rgba(96,165,250,.1)]"
          : "border-nb-line bg-[rgba(6,11,26,.5)] hover:border-[rgba(150,180,245,.42)]"
      }`}
    >
      {body}
    </button>
  );
}
