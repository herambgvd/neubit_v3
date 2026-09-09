"use client";

// Building Intelligence → DASHBOARDS.
//
// The surface itself is `features/dashforge/DashboardsViewer` — one viewer every
// console shares. This page only fixes its CATEGORY: what appears here is the set
// filed under "Building Intelligence", not every dashboard registered on the
// platform. Surveillance has its own page pinned the same way (`/surveillance/
// dashboards`), which is what the category was added for.
//
// The register form and the delete button that used to live here are gone, not
// lost: they are Configurations → Dashboards now. Registration is configuration,
// and a create-and-delete pair beside the frame they act on is how a dashboard
// gets removed by somebody who meant to close it.
import DashboardsViewer from "@/features/dashforge/DashboardsViewer";

export default function BIDashboards() {
  return <DashboardsViewer category="building" crumb="Dashboards" />;
}
