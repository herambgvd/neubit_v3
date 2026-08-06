"use client";

// One template tile in the grid — icon + title + "when sent" blurb, a
// Customized/Default badge, the current subject, and Preview / Edit actions.
import { Icon } from "@iconify/react";

import { QuietButton, SectionCard } from "@/components/console";
import { Badge } from "@/components/ui/kit";
import { TEMPLATE_META, titleCase } from "../constants";

export default function TemplateCard({ template, onPreview, onEdit }) {
  const meta = TEMPLATE_META[template.name] || {
    icon: "heroicons-outline:envelope",
    desc: "Transactional email.",
  };

  return (
    <SectionCard className="flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-nb-line bg-white/5 text-nb-blueb">
            <Icon icon={meta.icon} className="text-lg" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
              {titleCase(template.name)}
            </div>
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-nb-faint">{meta.desc}</p>
          </div>
        </div>
        <Badge color={template.overridden ? "green" : "slate"}>
          {template.overridden ? "Customized" : "Default"}
        </Badge>
      </div>

      <div className="mt-3 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2">
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
          Subject
        </div>
        <code className="block font-mono text-xs text-nb-ink break-all">
          {template.subject || "—"}
        </code>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-nb-line pt-3">
        <QuietButton icon="heroicons-outline:eye" onClick={onPreview}>
          Preview
        </QuietButton>
        <QuietButton icon="heroicons-outline:pencil-square" onClick={onEdit}>
          Edit
        </QuietButton>
      </div>
    </SectionCard>
  );
}
