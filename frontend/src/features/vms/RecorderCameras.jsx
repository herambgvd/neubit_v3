"use client";

// Recorder Cameras — the federated live grid. Lists the cameras OWNED by each
// registered recorder (NVR) node (via /vms/federation/cameras) and plays them live
// THROUGH the node: click a tile → mint a node-issued live token
// (/vms/federation/.../live) → attach the HLS stream with hls.js. Proves the
// end-to-end federation pipeline (NVR-owned cameras + live streaming in the VMS).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Spinner } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "./api";

function HlsTile({ cam }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  async function play() {
    if (busy || playing) return;
    setBusy(true);
    setErr("");
    try {
      const s = await vms.federation.live(cam.node_id, cam.id, "sub");
      const url = s.hls_url;
      if (!url) throw new Error("no stream url");
      const video = videoRef.current;
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari — native HLS.
        video.src = url;
      } else {
        const Hls = (await import("hls.js")).default;
        if (!Hls.isSupported()) throw new Error("HLS not supported");
        const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setErr("stream error");
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hlsRef.current = hls;
      }
      await video.play().catch(() => {});
      setPlaying(true);
    } catch (e) {
      setErr(e.message || "failed");
      toast.error(apiError(e, "Live failed"));
    } finally {
      setBusy(false);
    }
  }

  const dot =
    cam.status === "online"
      ? "bg-nb-good shadow-[0_0_5px_#34d399]"
      : cam.status === "offline"
        ? "bg-nb-crit"
        : "bg-nb-faint";

  return (
    <div className="group relative overflow-hidden rounded-[12px] border border-nb-line bg-black">
      <div className="relative aspect-video w-full">
        <video ref={videoRef} muted playsInline className="h-full w-full bg-black object-contain" />
        {!playing && (
          <button
            onClick={play}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[rgba(6,11,26,.5)] text-nb-muted transition hover:text-nb-tealb"
          >
            <Icon icon={busy ? "svg-spinners:180-ring" : "heroicons-solid:play"} className="text-[34px]" />
            <span className="text-[11px] tracking-[.5px]">{busy ? "Connecting…" : err || "Play live"}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-nb-line px-3 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-nb-ink">{cam.name}</span>
        <span className="shrink-0 rounded-[5px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] px-1.5 py-px font-mono text-[9px] text-nb-blueb">
          {cam.node_name}
        </span>
      </div>
    </div>
  );
}

export default function RecorderCameras() {
  const q = useQuery({
    queryKey: ["federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });
  const cams = q.data?.items || [];
  const unreachable = q.data?.unreachable || [];

  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Icon icon="heroicons-outline:video-camera" className="text-sm text-nb-blueb" />
        <span className="text-[11px] font-semibold uppercase tracking-[1.4px] text-nb-muted">Recorder Cameras</span>
        <span className="font-mono text-[11px] text-nb-faint">{cams.length}</span>
        <span className="ml-1 text-[11px] text-nb-faint">
          from {q.data?.nodes ?? 0} recorder{(q.data?.nodes ?? 0) === 1 ? "" : "s"}
        </span>
        {unreachable.length > 0 && (
          <span className="ml-2 rounded-[5px] border border-[rgba(251,146,60,.4)] bg-[rgba(251,146,60,.1)] px-1.5 py-px text-[10px] text-nb-warn">
            {unreachable.length} node unreachable
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-nb-soft"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : q.isError ? (
          <div className="py-10 text-center text-sm text-nb-crit">{apiError(q.error, "Failed to load recorder cameras")}</div>
        ) : cams.length === 0 ? (
          <div className="py-16 text-center">
            <Icon icon="heroicons-outline:video-camera-slash" className="mx-auto text-2xl text-nb-faint" />
            <div className="mt-2 text-sm font-medium text-nb-ink">No recorder cameras</div>
            <div className="text-xs text-nb-faint">Register a recorder (Fleet) and onboard cameras on it — they federate up here.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 pb-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cams.map((c) => (
              <HlsTile key={`${c.node_id}:${c.id}`} cam={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
