"use client";

// Workflow configuration (page entry; a route wrapper re-exports this default).
// Thin orchestrator: renders the active tab. Each tab (SOPs / Triggers / Forms /
// Formats / Simulator / Notifications / Threat levels) is its own component and fills
// the bounded console pane, scrolling internally.
//
// The tab SEGMENT is not here — like every other console (Platform, Security, System,
// Sites) this one is driven by ?view= and its segment lives in the global header bar
// (ConsoleStrip), built from the same WORKFLOW_VIEWS list. Keeping the view in the URL
// is what lets the header own it, and it makes a tab linkable and refresh-proof.
import { useSearchParams } from "next/navigation";

import { ConsolePage } from "@/components/console";

import SopsTab from "./components/config/SopsTab";
import TriggersTab from "./components/config/TriggersTab";
import FormatsTab from "./components/config/FormatsTab";
import FormsTab from "./components/config/FormsTab";
import NotificationTemplatesTab from "./components/config/NotificationTemplatesTab";
import ThreatLevelsTab from "./components/config/ThreatLevelsTab";
import SimulatorTab from "./components/config/SimulatorTab";
import { WORKFLOW_VIEWS } from "./constants";

const VIEWS = {
  sops: SopsTab,
  triggers: TriggersTab,
  forms: FormsTab,
  formats: FormatsTab,
  simulator: SimulatorTab,
  notifications: NotificationTemplatesTab,
  threat: ThreatLevelsTab,
};

export default function WorkflowConfigPage() {
  const v = useSearchParams().get("view");
  const View = VIEWS[v] || VIEWS[WORKFLOW_VIEWS[0].key];

  return (
    <ConsolePage>
      {/* Active tab — fills the pane, scrolls internally */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <View />
      </div>
    </ConsolePage>
  );
}
