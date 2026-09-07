"use client";

// The System console (/system). ONE page, two bands.
//
// It used to be two screens behind `?view=assurance` / `?view=settings`, and both
// were mostly empty: Assurance is four tiles and Settings is four cards, each
// stranded on its own full-height screen with a segment control to swap between
// them. They are also the same subject read two ways — what the platform's
// posture IS, and which of it you can change here — so splitting them made the
// operator click to compare a figure with the setting that produces it.
//
//   POSTURE   read-only, links out to where each thing is configured
//   SETTINGS  the handful that ARE edited here, behind settings.manage
//
// Both are bento grids on the same six columns, so the two bands line up rather
// than reading as two unrelated pages stacked.
import { ConsolePage } from "@/components/console";
import { useAuth } from "@/lib/auth";

import SystemAssurance from "./SystemAssurance";
import SettingsGeneral from "./SettingsGeneral";

export default function SystemPage() {
  const { can } = useAuth();

  return (
    <ConsolePage>
      {/* NOTHING is forced to fit, because forcing it is what clipped the Maps
          group. Both bands take their natural height and the PAGE scrolls if the
          two together exceed the pane — a scrollbar is a worse outcome than a
          tight fit, and a far better one than a form cut off mid-field.
          The posture band is dense enough (see SystemAssurance) that on a normal
          console window there is nothing to scroll. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
        <SystemAssurance />
        {/* Not merely hidden by nav: this band writes platform settings, so it is
            gated on the permission that authorises the write. */}
        {can("settings.manage") && <SettingsGeneral />}
      </div>
    </ConsolePage>
  );
}
