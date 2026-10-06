"use client";

// VMS → Playback: the investigation workspace (playback/PlaybackWorkspace). Every
// camera's footage lives on the recorder that owns it, and plays from there.
//
// Deep-linkable via ?camera=<id>[&t=<iso>] (alarm "watch the recording", the event
// list's Play) — handled inside the workspace.
import { useState } from "react";

import PlaybackWorkspace from "./playback/PlaybackWorkspace";
import ExportDialog from "./components/ExportDialog";
import type { ExportRequest } from "./components/playbackTypes";

export default function PlaybackPage() {
  // Export is raised from the active tile's IN/OUT range.
  const [exportReq, setExportReq] = useState<ExportRequest | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PlaybackWorkspace onExport={setExportReq} />

      <ExportDialog
        open={!!exportReq}
        onClose={() => setExportReq(null)}
        nodeId={exportReq?.nodeId}
        cameraId={exportReq?.cameraId}
        cameraName={exportReq?.cameraName}
        range={exportReq}
      />
    </div>
  );
}
