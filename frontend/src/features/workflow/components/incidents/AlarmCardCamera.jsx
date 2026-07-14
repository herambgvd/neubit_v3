"use client";

// AlarmCardCamera — the camera media strip on an alarm card whose incident has an
// associated camera (P5-C). Shows the camera's last snapshot (GET /vms/cameras/{id}/
// snapshot as a blob, since the endpoint is JWT-authed and a plain <img src> can't
// carry the bearer) + a "View recording" button that deep-links Playback to the
// event instant. Graceful: an offline camera / no frame → a placeholder, never a
// crash. Rendered inside AlarmCard only when incCameraId(incident) is truthy.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import { vms } from "@/features/vms/api";

export default function AlarmCardCamera({ cameraId, eventTime }) {
  const [url, setUrl] = useState(null);
  const [state, setState] = useState("loading"); // loading | ok | error

  useEffect(() => {
    if (!cameraId) return undefined;
    let objectUrl = null;
    let cancelled = false;
    setState("loading");
    api
      .get(vms.cameras.snapshotUrl(cameraId), { responseType: "blob" })
      .then((r) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.data);
        setUrl(objectUrl);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cameraId]);

  if (!cameraId) return null;

  const playbackHref =
    `/playback?camera=${encodeURIComponent(cameraId)}` +
    (eventTime ? `&t=${encodeURIComponent(eventTime)}` : "");

  // The card body is itself a <Link> to the incident; stop the click from bubbling
  // so "View recording" navigates to Playback instead.
  const stop = (e) => e.stopPropagation();

  return (
    <div className="mt-1 flex items-center gap-3 rounded-lg border border-card-border bg-hover/30 p-2" onClick={stop}>
      {/* Snapshot thumbnail */}
      <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-black">
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70">
            <Icon icon="svg-spinners:180-ring" className="text-base" />
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center text-white/60">
            <Icon icon="heroicons-outline:video-camera-slash" className="text-lg" />
            <span className="text-[9px]">No frame</span>
          </div>
        )}
        {state === "ok" && url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Camera snapshot" className="h-full w-full object-cover" />
        )}
      </div>

      {/* Actions */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <Icon icon="heroicons-outline:video-camera" className="text-xs" />
          <span className="truncate">Associated camera</span>
        </div>
        <Link
          href={playbackHref}
          onClick={stop}
          className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-card"
        >
          <Icon icon="heroicons-outline:play" className="text-xs" /> View recording
        </Link>
      </div>
    </div>
  );
}
