"use client";

// System console — the /general page frame. Two views selected by ?view=: an
// Assurance posture dashboard (read-only aggregate) and the platform Settings form.
// The header carries the System modtab + Assurance/Settings segment (see Header).
import { useSearchParams } from "next/navigation";

import { ConsolePage, ConsoleScroll } from "@/components/console";
import SystemAssurance from "./SystemAssurance";
import SettingsGeneral from "./SettingsGeneral";

export default function SystemPage() {
  const view = useSearchParams().get("view") === "settings" ? "settings" : "assurance";
  return (
    <ConsolePage>
      {/* Settings owns its own fill-the-pane layout (its cards stretch), so it is not
          wrapped — Assurance is a long card stack and scrolls like Platform/Security. */}
      {view === "settings" ? (
        <SettingsGeneral />
      ) : (
        <ConsoleScroll>
          <SystemAssurance />
        </ConsoleScroll>
      )}
    </ConsolePage>
  );
}
