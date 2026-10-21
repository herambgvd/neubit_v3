"use client";

// A live screen — /live-display/[screen] (SCRUM-336). At the TOP LEVEL, beside
// /wall-display, so it inherits the root layout's <Providers> (auth, queries,
// toasts) but not the (app) chrome or its alarm notifier: the main console raises
// alarms once, not once per monitor. See features/vms/LiveScreen.
import { useParams } from "next/navigation";

import LiveScreen from "@/features/vms/LiveScreen";

export default function LiveScreenPage() {
  const params = useParams();
  return <LiveScreen screenKey={params?.screen} />;
}
