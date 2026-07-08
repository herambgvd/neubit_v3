"use client";

// Workflow configuration (page entry; a route wrapper re-exports this default).
// Thin orchestrator: renders the shared TabBar + the active tab. Each tab
// (SOPs / Triggers / Forms / Notifications / Threat levels) is its own component.
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@iconify/react";

import { PageHeader } from "@/components/ui/kit";
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
  { key: "formats", label: "Formats", icon: "heroicons-outline:swatch" },
  { key: "forms", label: "Forms", icon: "heroicons-outline:clipboard-document-list" },
  { key: "notifications", label: "Notifications", icon: "heroicons-outline:bell-alert" },
  { key: "threat", label: "Threat levels", icon: "heroicons-outline:shield-exclamation" },
  { key: "simulator", label: "Simulator", icon: "heroicons-outline:beaker" },
];

export default function WorkflowConfigPage() {
  const [tab, setTab] = useState("sops");

  return (
    <div>
      <PageHeader
        title="Workflow configuration"
        subtitle="Define SOPs, their state machines, and the triggers that raise incidents."
        actions={
          <Link
            href="/workflow"
            className="inline-flex items-center gap-2 rounded-md border border-card-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-hover"
          >
            <Icon icon="heroicons-outline:arrow-left" className="text-base" />
            Incidents
          </Link>
        }
      />

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
