"use client";

// Platform console — clubs the platform-administration surfaces into one console
// frame: Notifications (delivery channels), Branding (white-label), System Health
// (monitoring) and License (entitlements). The view is chosen by ?view= and the
// header carries the Platform modtab + a 4-way segment (see Header).
import { useSearchParams } from "next/navigation";

import { ConsolePage, ConsoleScroll } from "@/components/console";
import Channels from "@/features/core/notifications/Channels";
import Branding from "@/features/core/branding/Branding";
import EmailTemplates from "@/features/core/email-templates/EmailTemplates";
import Tags from "@/features/core/tags/Tags";
import Health from "@/features/core/system-health/Health";
import License from "@/features/core/license/License";

const VIEWS = {
  notifications: Channels,
  branding: Branding,
  templates: EmailTemplates,
  tags: Tags,
  health: Health,
  license: License,
};

export default function PlatformConsole() {
  const v = useSearchParams().get("view");
  const View = VIEWS[v] || Channels;
  return (
    <ConsolePage>
      <ConsoleScroll>
        <View />
      </ConsoleScroll>
    </ConsolePage>
  );
}
