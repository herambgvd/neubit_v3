"use client";

// Operator console for one wall — /wall/[id]. Reads the wall id from the route
// and hands it to the WallConsole cockpit.
import { useParams } from "next/navigation";

import WallConsole from "@/features/videowall/WallConsole";

export default function WallConsolePage() {
  const params = useParams();
  return <WallConsole wallId={params?.id} />;
}
