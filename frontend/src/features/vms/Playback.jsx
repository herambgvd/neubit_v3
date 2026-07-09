"use client";

// VMS → Playback (P4-C). Recorded-video playback across three modes:
//   • Single    — one camera on a timeline scrub bar (coverage + gaps), with a
//                 transport (play/pause, speed, frame-step), snapshot + export.
//   • Multi-cam — 2–4 cameras synchronized on one shared timeline + transport.
//   • NVR       — browse & play footage stored on an onboarded 3rd-party NVR.
//
// Deep-linkable via ?camera= (opened from the Recordings "Play" action).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader, Select } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import PlaybackPlayer from "./components/PlaybackPlayer";
import MultiPlayback from "./components/MultiPlayback";
import NvrFootage from "./components/NvrFootage";
import ExportDialog from "./components/ExportDialog";

const TABS = [
  { key: "single", label: "Single camera", icon: "heroicons-outline:play" },
  { key: "multi", label: "Multi-camera", icon: "heroicons-outline:squares-2x2" },
  { key: "nvr", label: "NVR footage", icon: "heroicons:server-stack" },
];

export default function PlaybackPage() {
  const [tab, setTab] = useState("single");
  const [cameraId, setCameraId] = useState("");
  const [exportRange, setExportRange] = useState(null); // { from, to } or null
  const [seekTo, setSeekTo] = useState(null); // ISO string from ?t= (jump-to-recording)

  // Deep-link ?camera=<id>[&t=<iso>] → open Single-camera on that camera, and (with
  // ?t=) seek the scrub bar to that instant. Read from window.location to sidestep
  // the useSearchParams Suspense rule (same pattern as Streaming). Handled once on mount.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || typeof window === "undefined") return;
    deepLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const camera = params.get("camera");
    const t = params.get("t");
    if (camera) {
      setCameraId(camera);
      setTab("single");
      if (t) setSeekTo(t);
    }
  }, []);

  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "playback-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const cameraName = useMemo(
    () => cameras.find((c) => c.id === cameraId)?.name,
    [cameras, cameraId],
  );

  const cameraOptions = [
    { value: "", label: cameras.length ? "Select a camera…" : "No cameras" },
    ...cameras.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div className="pb-8">
      <PageHeader
        title="Playback"
        subtitle="Scrub recorded footage, play cameras back in sync, and pull footage from onboarded NVRs."
      />

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5" />

      {tab === "single" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
            <div className="w-64">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Camera</label>
              <Select
                value={cameraId}
                onChange={(e) => {
                  setCameraId(e.target.value);
                  setSeekTo(null); // manual camera switch drops the deep-link seek
                }}
                options={cameraOptions}
                className="!h-9 !py-1.5"
              />
            </div>
          </div>

          {cameraId ? (
            <PlaybackPlayer
              key={cameraId}
              cameraId={cameraId}
              cameraName={cameraName}
              initialSeek={seekTo}
              onExportRange={(range) => setExportRange(range)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-20 text-center text-muted">
              <span className="mb-1 font-medium text-foreground">Select a camera</span>
              <span className="text-sm">Pick a camera above to scrub its recorded footage.</span>
            </div>
          )}
        </div>
      )}

      {tab === "multi" && <MultiPlayback />}
      {tab === "nvr" && <NvrFootage />}

      <ExportDialog
        open={!!exportRange}
        onClose={() => setExportRange(null)}
        cameraId={cameraId}
        cameraName={cameraName}
        range={exportRange}
      />
    </div>
  );
}
