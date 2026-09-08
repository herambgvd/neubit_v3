"use client";

// Platform console — clubs the platform-administration surfaces into one console
// frame: Config (white-label identity + delivery channels), Email
// Templates, Tags, System Health (monitoring) and License (entitlements). The view
// is chosen by ?view= and the header carries the Platform modtab + the segment
// (see ConsoleStrip).
import type { ComponentType } from "react";
import { useSearchParams } from "next/navigation";

import { ConsolePage, ConsoleScroll } from "@/components/console";
import Config from "@/features/core/config/Config";
import EmailTemplates from "@/features/core/email-templates/EmailTemplates";
import Tags from "@/features/core/tags/Tags";
import Health from "@/features/core/system-health/Health";
import License from "@/features/core/license/License";

/**
 * A view is either a STACK OF CARDS, which scrolls, or a MASTER/DETAIL, which
 * fills the pane and scrolls inside its own panels.
 *
 * They cannot share a wrapper. `ConsoleScroll` is a block, so a `flex-1` grid
 * inside it computes its height from its CONTENT — which is why Templates and
 * Tags stopped two-thirds down the page with the rest of it empty. The frame is
 * chosen per view now instead of applied to all of them.
 */
const SCROLLS = new Set(["config", "health", "license"]);

// Partial: an unknown `?view=` reads as undefined and falls back to Config.
// That fallback is what carries the OLD `?view=branding` and `?view=notifications`
// links, which the merge retired — no alias entries needed, and adding them would
// be dead code that reads as if it were doing the work.
const VIEWS: Partial<Record<string, ComponentType>> = {
  config: Config,
  templates: EmailTemplates,
  tags: Tags,
  health: Health,
  license: License,
};

export default function PlatformConsole() {
  const v = useSearchParams().get("view");
  const key = v && VIEWS[v] ? v : "config";
  const View = VIEWS[key] || Config;
  return (
    <ConsolePage>
      {SCROLLS.has(key) ? (
        <ConsoleScroll>
          <View />
        </ConsoleScroll>
      ) : (
        <View />
      )}
    </ConsolePage>
  );
}
