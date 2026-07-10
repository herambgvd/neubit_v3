"use client";

// Live-video modal for a single camera — the P2-D replacement for the P1
// SnapshotModal "Live — P2" stand-in. Opened from the Cameras grid/table
// "Go live" action and reused inside the camera-detail Live tab. Mounts a
// LivePlayer (WebRTC + HLS fallback); the session is released automatically on
// unmount (the player owns the useLiveSession lifecycle).
import { useState } from "react";

import { Button, Modal, Select } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import LivePlayer from "./LivePlayer";
import PtzOverlay from "./PtzOverlay";
import { isPtzCapable } from "../formUtils";

const PROFILE_OPTIONS = [
  { value: "sub", label: "Sub-stream (low latency)" },
  { value: "main", label: "Main stream (full quality)" },
];

export default function LivePlayerModal({ camera, onClose }) {
  const [profile, setProfile] = useState("sub");
  const { can } = useAuth();
  const ptz = isPtzCapable(camera);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Live — ${camera.name}`}
      wide
      footer={
        <>
          <div className="mr-auto w-56">
            <Select value={profile} onChange={(e) => setProfile(e.target.value)} options={PROFILE_OPTIONS} />
          </div>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-card-border bg-black">
        <LivePlayer
          key={`${camera.id}:${profile}`}
          cameraId={camera.id}
          cameraName={camera.name}
          profile={profile}
          className="h-full"
        />
        {ptz && (
          <div className="absolute bottom-3 left-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))]">
            <PtzOverlay cameraId={camera.id} canControl={can("vms.ptz.control")} />
          </div>
        )}
      </div>
    </Modal>
  );
}
