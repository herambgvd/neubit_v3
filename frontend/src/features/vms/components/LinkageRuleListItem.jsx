"use client";

// A single linkage rule row in the master list (left pane). Trigger-preset icon
// with an active-status dot, name + inactive pill, trigger summary. Mirrors
// SiteListItem.
import { Icon } from "@iconify/react";
import { EVENT_TYPE_PRESETS } from "../constants";

export default function LinkageRuleListItem({ rule, selected, onSelect }) {
  const tp = EVENT_TYPE_PRESETS[rule.trigger_event_type] || EVENT_TYPE_PRESETS.system;
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 rounded-[10px] border px-4 py-3 text-left transition ${
          selected
            ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
            : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
        }`}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-blue" />}
        <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${tp.cls}`}>
          <Icon icon={tp.icon} className="text-base" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${
              rule.is_active ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-nb-ink truncate">{rule.name}</span>
            {!rule.is_active && (
              <span className="text-[10px] rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] px-1.5 py-0.5 font-medium text-nb-muted">Inactive</span>
            )}
          </span>
          <span className="block text-xs text-nb-soft truncate">on {tp.label}</span>
        </span>
      </button>
    </li>
  );
}
