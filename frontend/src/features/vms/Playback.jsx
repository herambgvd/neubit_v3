"use client";

// VMS → Playback. ONE unified, synchronized playback workspace (video-wall style):
// recorded cameras (our pooled storage) AND NVR channels (a 3rd-party recorder's
// on-board storage) play back together on a single master timeline. The old
// Single / Multi-camera / NVR-footage tabs are collapsed into this one surface —
// single-camera is just the one-tile case, NVR footage is just another source kind.
//
// Deep-linkable via ?camera=<id>[&t=<iso>] (from the Recordings/Events "Play"
// action) — handled inside UnifiedPlayback.
import { useState } from "react";

import UnifiedPlayback from "./components/UnifiedPlayback";
import ExportDialog from "./components/ExportDialog";

export default function PlaybackPage() {
  // Export is raised from a focused tile: { from, to, cameraId, cameraName }.
  const [exportReq, setExportReq] = useState(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <UnifiedPlayback onExportRange={setExportReq} />

      <ExportDialog
        open={!!exportReq}
        onClose={() => setExportReq(null)}
        cameraId={exportReq?.cameraId}
        cameraName={exportReq?.cameraName}
        range={exportReq}
      />
    </div>
  );
}
