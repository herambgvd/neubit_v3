"use client";

// One row of the template list: what the email is, its current subject, and
// whether this deployment has overridden it.
import { Icon } from "@iconify/react";

import type { TemplateSummaryOut } from "../../types";
import { TEMPLATE_META, titleCase } from "../constants";

export interface TemplateListItemProps {
  template: TemplateSummaryOut;
  selected: boolean;
  onSelect: () => void;
}

export default function TemplateListItem({ template, selected, onSelect }: TemplateListItemProps) {
  const meta = TEMPLATE_META[template.name];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-blue bg-nb-blue/10"
          : "border-nb-line hover:border-nb-line2 hover:bg-white/5"
      }`}
    >
      <Icon
        icon={meta?.icon || "heroicons-outline:envelope"}
        className="mt-0.5 shrink-0 text-base text-nb-blueb"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-nb-ink">{titleCase(template.name)}</span>
          {template.overridden && (
            // A dot, not a word: the list is scanned, and "which of these have we
            // changed" is the only question it has to answer at a glance.
            <span
              title="Customised for this deployment"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-nb-teal shadow-[0_0_5px_#22d3ee]"
            />
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-nb-faint">{template.subject}</span>
      </span>
    </button>
  );
}
