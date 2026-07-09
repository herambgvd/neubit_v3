"use client";

// Display-client kiosk route — /wall-display/[id]/[mid]. Deliberately placed at
// the TOP LEVEL (a sibling of the (app) group) so it inherits the root layout's
// <Providers> (auth + TanStack Query) but NOT the (app) header/footer/section-tab
// chrome — the physical wall screen gets a clean, full-bleed surface. Each
// monitor's browser opens its own URL here; it renders only that monitor's cells,
// live and read-only, auto-syncing to the wall's shared state via the wall SSE.
import { useParams } from "next/navigation";

import WallKiosk from "@/features/videowall/WallKiosk";

export default function WallKioskPage() {
  const params = useParams();
  return <WallKiosk wallId={params?.id} monitorId={params?.mid} />;
}
