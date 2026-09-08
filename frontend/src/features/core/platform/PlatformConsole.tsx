"use client";

// Platform console — clubs the platform-administration surfaces into one console
// frame: Communications (white-label identity + delivery channels), Email
// Templates, Tags, System Health (monitoring) and License (entitlements). The view
// is chosen by ?view= and the header carries the Platform modtab + the segment
// (see ConsoleStrip).
import type { ComponentType } from "react";
import { useSearchParams } from "next/navigation";

import { ConsolePage, ConsoleScroll } from "@/components/console";
import Communications from "@/features/core/communications/Communications";
import EmailTemplates from "@/features/core/email-templates/EmailTemplates";
import Tags from "@/features/core/tags/Tags";
import Health from "@/features/core/system-health/Health";
import License from "@/features/core/license/License";

// Partial: an unknown `?view=` reads as undefined and falls back to Communications.
// That fallback is what carries the OLD `?view=branding` and `?view=notifications`
// links, which the merge retired — no alias entries needed, and adding them would
// be dead code that reads as if it were doing the work.
const VIEWS: Partial<Record<string, ComponentType>> = {
  communications: Communications,
  templates: EmailTemplates,
  tags: Tags,
  health: Health,
  license: License,
};

export default function PlatformConsole() {
  const v = useSearchParams().get("view");
  const View = (v ? VIEWS[v] : undefined) || Communications;
  return (
    <ConsolePage>
      <ConsoleScroll>
        <View />
      </ConsoleScroll>
    </ConsolePage>
  );
}
