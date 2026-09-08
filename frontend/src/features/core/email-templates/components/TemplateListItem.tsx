"use client";

// One row of the template list: what the email is, its current subject, and
// whether this deployment has overridden it.
import { Icon } from "@iconify/react";

import { RowAction } from "@/components/console";
import type { TemplateSummaryOut } from "../../types";
import { TEMPLATE_META, titleCase } from "../constants";

export interface TemplateListItemProps {
  template: TemplateSummaryOut;
  selected: boolean;
  onSelect: () => void;
  /** Only offered where there is something to undo — see below. */
  onRemove?: () => void;
  busy?: boolean;
}

export default function TemplateListItem({
  template,
  selected,
  onSelect,
  onRemove,
  busy,
}: TemplateListItemProps) {
  const meta = TEMPLATE_META[template.name];
  const builtin = template.name in TEMPLATE_META;

  return (
    // A DIV, not a button: the row carries its own action, and a button inside a
    // button is invalid markup that browsers resolve by dropping one of them.
    <div
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-blue bg-nb-blue/10"
          : "border-nb-line hover:border-nb-line2 hover:bg-white/5"
      }`}
    >
      {/* An explicit label: without one the accessible name is the title and the
          subject run together, which reads badly and collides with the row
          action's name in any query. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={titleCase(template.name)}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
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

      {/* Only where something CAN be removed. A built-in with no override has
          nothing to undo, and DELETE 404s on it — a trash icon there would be an
          action that cannot succeed. On a built-in that IS overridden the action
          reverts; on a custom template it deletes, and the icon says which. */}
      {onRemove && template.overridden && (
        <RowAction
          icon={builtin ? "heroicons-outline:arrow-uturn-left" : "heroicons-outline:trash"}
          title={builtin ? `Revert ${titleCase(template.name)} to default` : `Delete ${titleCase(template.name)}`}
          tone={builtin ? "default" : "danger"}
          disabled={busy}
          onClick={onRemove}
        />
      )}
    </div>
  );
}
