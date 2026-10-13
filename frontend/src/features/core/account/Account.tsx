"use client";

// My account — tabbed page (Profile · Security · Sessions · Preferences). Thin
// orchestrator: owns the active-tab state and renders the shared TabBar plus the
// selected panel. Each tab is a self-contained component owning its own queries.
import { useState } from "react";
import { useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { TABS } from "./constants";
import ProfileTab from "./components/ProfileTab";
import SecurityTab from "./components/SecurityTab";
import SessionsTab from "./components/SessionsTab";
import PreferencesTab from "./components/PreferencesTab";

export default function AccountPage() {
  // ?tab= opens a tab directly — the top bar's Alerts menu links to Preferences.
  const asked = useSearchParams()?.get("tab");
  const [tab, setTab] = useState(() => (TABS.some((t) => t.key === asked) ? (asked as string) : "profile"));

  return (
    <div>
      <PageHeader title="My account" subtitle="Manage your profile, security and preferences." />

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-6" />

      {tab === "profile" && <ProfileTab />}
      {tab === "security" && <SecurityTab />}
      {tab === "sessions" && <SessionsTab />}
      {tab === "preferences" && <PreferencesTab />}
    </div>
  );
}
