"use client";

// Workflow configuration (page entry; a route wrapper re-exports this default).
// Thin orchestrator: renders the shared TabBar + the active tab. Each tab
// (SOPs / Triggers / Forms / Notifications / Threat levels) is its own component.
import { useState } from "react";

import { TabBar } from "@/components/common";
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
      className="-mx-6 lg:-mx-8 -my-6 min-h-full px-6 lg:px-8 py-6 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-4" />

      {tab === "sops" && <SopsTab />}
      {tab === "triggers" && <TriggersTab />}
      {tab === "formats" && <FormatsTab />}
      {tab === "forms" && <FormsTab />}
      {tab === "notifications" && <NotificationTemplatesTab />}
      {tab === "threat" && <ThreatLevelsTab />}
      {tab === "simulator" && <SimulatorTab />}
    </div>
  );
}
