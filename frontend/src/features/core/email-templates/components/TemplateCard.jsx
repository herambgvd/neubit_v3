"use client";

// One template tile in the grid — icon + title + "when sent" blurb, a
// Customized/Default badge, the current subject, and Preview / Edit actions.
import { Icon } from "@iconify/react";

import { Badge, Button, Card } from "@/components/ui/kit";
import { TEMPLATE_META, titleCase } from "../constants";

export default function TemplateCard({ template, onPreview, onEdit }) {
  const meta = TEMPLATE_META[template.name] || {
    icon: "heroicons-outline:envelope",
    desc: "Transactional email.",
  };

  return (
    <Card className="p-5 flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 shrink-0 rounded-lg bg-hover border border-card-border flex items-center justify-center text-muted">
            <Icon icon={meta.icon} className="text-lg" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground truncate">{titleCase(template.name)}</h3>
            <p className="text-xs text-muted line-clamp-2">{meta.desc}</p>
          </div>
        </div>
        <Badge color={template.overridden ? "green" : "slate"}>
          {template.overridden ? "Customized" : "Default"}
        </Badge>
      </div>

      <div className="mt-4 rounded-lg border border-card-border bg-hover px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted mb-0.5">
          Subject
        </div>
        <code className="block font-mono text-xs text-foreground break-all">
          {template.subject || "—"}
        </code>
      </div>

      <div className="mt-4 pt-4 border-t border-card-border flex items-center gap-2">
        <Button variant="secondary" icon="heroicons-outline:eye" onClick={onPreview}>
          Preview
        </Button>
        <Button
          variant="secondary"
          icon="heroicons-outline:pencil-square"
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
    </Card>
  );
}
