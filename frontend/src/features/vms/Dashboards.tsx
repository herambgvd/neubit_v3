"use client";

// Surveillance → DASHBOARDS. The same viewer Building Intelligence uses, pinned
// to the `vms` category — the reason a category exists at all: a surveillance
// operator gets the surveillance dashboards, not the building-energy ones with
// theirs somewhere in the middle of the strip.
//
// Registration lives in Configurations → Dashboards, for every category at once.
import DashboardsViewer from "@/features/dashforge/DashboardsViewer";

export default function VmsDashboards() {
  return <DashboardsViewer category="vms" crumb="Dashboards" />;
}
