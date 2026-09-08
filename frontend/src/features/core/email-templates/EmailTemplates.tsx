"use client";

// Email Templates — the transactional emails this platform sends.
//
// A 30:70 master/detail, like every other library screen in the console: the list
// on the left, one template open on the right with Edit and Preview as two views
// of it rather than two dialogs. It was a grid of tiles that opened a modal to
// edit and a second modal to preview, so comparing what you wrote with what it
// renders as meant closing one and opening the other.
//
// THERE IS NO "NEW TEMPLATE", and that is not an omission. The set is fixed by the
// code that SENDS these emails (messaging/templates.py). A template nothing sends
// is not a template — the operations here are read, override, and revert.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ConsoleGrid,
  ConsolePanel,
  EmptyPane,
  PanelHeader,
  PanelList,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { api } from "@/lib/api";
import type { TemplateSummaryOut } from "../types";
import TemplateDetail from "./components/TemplateDetail";
import TemplateListItem from "./components/TemplateListItem";

export default function EmailTemplatesPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["messaging-templates"],
    queryFn: () => api.get<TemplateSummaryOut[]>("/messaging/templates").then((r) => r.data),
  });

  const items = templates.data || [];
  // Open the first template rather than an empty pane: there are three of them and
  // one is always what you came for.
  const openName = selected && items.some((t) => t.name === selected) ? selected : items[0]?.name;
  const overridden = items.filter((t) => t.overridden).length;

  // No ConsolePage here: PlatformConsole already provides the page frame, the
  // same way Tags does inside it.
  return (
    <ConsoleGrid cols="lg:grid-cols-[25%_1fr]">
      <ConsolePanel>
        <PanelHeader
          icon="heroicons-outline:envelope"
          title="Templates"
          count={items.length}
          actions={
            overridden > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] text-nb-soft" title="Customised">
                <span className="h-1.5 w-1.5 rounded-full bg-nb-teal shadow-[0_0_5px_#22d3ee]" />
                {overridden} customised
              </span>
            )
          }
        />
        <PanelList
          loading={templates.isLoading}
          // A failed load must never read as "no templates" — the set is fixed,
          // so an empty list is always a fault, never a fresh deployment.
          error={templates.isError ? apiError(templates.error, "Couldn't load templates") : undefined}
          empty={items.length === 0}
          emptyText="No templates"
        >
          {items.map((t) => (
            <TemplateListItem
              key={t.name}
              template={t}
              selected={t.name === openName}
              onSelect={() => setSelected(t.name)}
            />
          ))}
        </PanelList>
      </ConsolePanel>

      <ConsolePanel>
        {openName ? (
          // Keyed on the name so switching templates remounts the pane: the
          // editor holds draft state, and carrying one template's unsaved body
          // into another is the worst thing this screen could do.
          <TemplateDetail key={openName} name={openName} />
        ) : (
          <EmptyPane
            icon="heroicons-outline:envelope"
            title="No template selected"
            subtitle="Pick one from the list to read, customise or revert it."
          />
        )}
      </ConsolePanel>
    </ConsoleGrid>
  );
}
