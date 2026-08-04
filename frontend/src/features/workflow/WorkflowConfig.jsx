"use client";

// Workflow configuration (page entry; a route wrapper re-exports this default).
// Thin orchestrator: renders a navy segmented tab bar + the active tab. Each tab
// (SOPs / Triggers / Forms / Formats / Simulator / Notifications / Threat levels)
// is its own component and fills the bounded console pane, scrolling internally.
import { useState } from "react";
import { Icon } from "@iconify/react";

import SopsTab from "./components/config/SopsTab";
import TriggersTab from "./components/config/TriggersTab";
import FormatsTab from "./components/config/FormatsTab";
import FormsTab from "./components/config/FormsTab";
import NotificationTemplatesTab from "./components/config/NotificationTemplatesTab";
import ThreatLevelsTab from "./components/config/ThreatLevelsTab";
import SimulatorTab from "./components/config/SimulatorTab";

const TABS = [
  { key: "sops", label: "SOPs", icon: "heroicons:rectangle-stack" },
  { key: "triggers", label: "Triggers", icon: "heroicons:bolt" },
  { key: "forms", label: "Forms", icon: "heroicons-outline:clipboard-document-list" },
  { key: "formats", label: "Formats", icon: "heroicons-outline:swatch" },
  { key: "simulator", label: "Simulator", icon: "heroicons-outline:beaker" },
  { key: "notifications", label: "Notifications", icon: "heroicons-outline:bell-alert" },
  { key: "threat", label: "Threat levels", icon: "heroicons-outline:shield-exclamation" },
];

export default function WorkflowConfigPage() {
  const [tab, setTab] = useState("sops");

  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* Segmented navy tab bar */}
      <nav className="mb-3 flex shrink-0 flex-wrap items-center gap-1 rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.5)] p-1">
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-[12.5px] font-medium tracking-[.2px] transition ${
                on
                  ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.1)] text-nb-tealb shadow-[0_0_10px_rgba(34,211,238,.18)]"
                  : "border-transparent text-nb-muted hover:bg-[rgba(96,165,250,.08)] hover:text-nb-ink"
              }`}
            >
              {t.icon && <Icon icon={t.icon} className="text-[15px]" />}
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Active tab — fills the pane, scrolls internally */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "sops" && <SopsTab />}
        {tab === "triggers" && <TriggersTab />}
        {tab === "formats" && <FormatsTab />}
        {tab === "forms" && <FormsTab />}
        {tab === "notifications" && <NotificationTemplatesTab />}
        {tab === "threat" && <ThreatLevelsTab />}
        {tab === "simulator" && <SimulatorTab />}
      </div>
    </div>
  );
}
