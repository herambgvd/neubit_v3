"use client";

// THE PLATE READ — what an ANPR camera on a paired recorder saw (SCRUM-324).
//
// A plate read is answered by pictures, not by facts: is that the plate, and what
// was the vehicle doing. So this strip shows the recorder's own plate crop and scene,
// then every camera the recorder bound to the ANPR camera — the frame it grabbed at
// the read and the recording around it — the way XProtect LPR and AutoVu put the
// context camera beside the plate. The binding is the recorder's: the VMS only shows
// what the recorder kept.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import { vms } from "../api";
import { anprListCls, anprListLabel, anprStills, confidencePct, type AnprOfEvent } from "../anprLib";
import type { EstateCamera } from "../types";
import TilePlayback from "./TilePlayback";

const PRE_ROLL_MS = 8_000;
const POST_ROLL_MS = 45_000;

const STILL_LABEL: Record<string, string> = {
  plate: "Plate",
  scene: "Full scene",
  vehicle: "Vehicle",
  evidence: "Camera evidence",
};

/** An image behind the API's Bearer auth: fetched as a blob, shown from an object URL. */
function AuthedImage({ path, alt, contain }: Readonly<{ path: string; alt: string; contain?: boolean }>) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    api
      .get<Blob>(path, { responseType: "blob" })
      .then((r) => {
        if (!alive) return;
        url = URL.createObjectURL(r.data);
        setSrc(url);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (failed) {
    return <div className="flex aspect-video items-center justify-center bg-black text-[10.5px] text-muted">not available</div>;
  }
  if (!src) return <div className="aspect-video animate-pulse bg-black/60" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={`aspect-video w-full bg-black ${contain ? "object-contain" : "object-cover"}`} />;
}

/** A linked camera's picture: its recording at the read, else the frame the recorder
 *  grabbed, else why there is neither. */
function LinkedPicture({
  camera,
  eventMs,
  stillPath,
}: Readonly<{ camera: EstateCamera | undefined; eventMs: number | null; stillPath: string | null }>) {
  if (camera && eventMs != null) {
    return (
      <TilePlayback
        key={`${camera.id}:${eventMs}`}
        camera={camera}
        anchorMs={eventMs - PRE_ROLL_MS}
        anchorSeq={eventMs}
        windowToMs={eventMs + POST_ROLL_MS}
        playing
        muted
        compact
      />
    );
  }
  if (stillPath) return <AuthedImage path={stillPath} alt="Linked camera at the read" />;
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-muted">
      This camera is not visible to this VMS.
    </div>
  );
}

export default function AnprEvidence({
  anpr,
  cameraId,
  occurredAt,
  cameraById,
}: Readonly<{
  anpr: AnprOfEvent;
  cameraId: string;
  occurredAt: string | null | undefined;
  cameraById: Record<string, EstateCamera>;
}>) {
  const readQ = useQuery({
    queryKey: ["vms-anpr-read", anpr.nodeId, anpr.readId],
    queryFn: () => vms.federation.anpr.read(anpr.nodeId, anpr.readId),
    enabled: !!anpr.nodeId && !!anpr.readId,
    staleTime: 15_000,
    // The linked frames land a moment after the read: look again once.
    refetchInterval: (q) => (q.state.dataUpdateCount < 2 ? 8_000 : false),
  });
  const read = readQ.data;
  const eventMs = occurredAt ? new Date(occurredAt).getTime() : null;
  const stills = read ? anprStills(read.images) : [];
  const linked = read?.linked?.length
    ? read.linked
    : anpr.linkedCameraIds.map((id) => ({ camera_id: id, camera_name: undefined as string | undefined }));
  const imageUrl = (kind: string) => vms.federation.anpr.imageUrl(anpr.nodeId, anpr.readId, kind);

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-card-border bg-card p-3 lg:flex-row">
      {/* the plate */}
      <div className="flex shrink-0 flex-col gap-2 lg:w-[22rem]">
        <div className="flex items-center gap-2">
          <Icon icon="heroicons-outline:identification" className="text-base text-sky-400" />
          <span className="text-[12px] font-semibold text-foreground">Plate read</span>
          <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${anprListCls(anpr.list)}`}>
            {anprListLabel(anpr.list, anpr.listLabel)}
          </span>
        </div>
        <div className={`text-2xl font-semibold tracking-wider ${anpr.noPlate ? "text-muted" : "text-foreground"}`}>
          {anpr.noPlate ? "No plate" : anpr.plate}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>Confidence {confidencePct(anpr.confidence)}</span>
          {read?.vehicle_type && <span>{[read.vehicle_color, read.vehicle_type].filter(Boolean).join(" ")}</span>}
          {read?.direction && <span>{read.direction}</span>}
          {read?.country && <span>{read.country}</span>}
        </div>
        {readQ.isError ? (
          <p className="text-[11px] text-muted">The recorder&apos;s stills for this read are not reachable right now.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {stills.map((k) => (
              <figure key={k} className="overflow-hidden rounded-md border border-card-border">
                <AuthedImage path={imageUrl(k)} alt={`${STILL_LABEL[k] ?? k} — ${anpr.plate || "no plate"}`} contain={k === "plate"} />
                <figcaption className="px-1.5 py-0.5 text-[10px] text-muted">{STILL_LABEL[k] ?? k}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      {/* the cameras bound to it */}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-2">
          <Icon icon="heroicons-outline:video-camera" className="text-sm text-muted" />
          <span className="text-[12px] font-semibold text-foreground">Linked cameras</span>
          <span className="text-[11px] text-muted">bound to the ANPR camera on its recorder</span>
        </div>
        {linked.length === 0 ? (
          <p className="text-[11.5px] text-muted">
            No camera is bound to this ANPR camera. Bind the cameras that watch the lane on the recorder (ANPR → ANPR cameras).
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {linked.map((l) => {
              const cam = cameraById[l.camera_id];
              const still = read?.images.includes(`linked-${l.camera_id}`) ? `linked-${l.camera_id}` : null;
              return (
                <div key={l.camera_id} className="overflow-hidden rounded-md border border-card-border">
                  <div className="truncate px-2 py-1 text-[11.5px] text-foreground" title={cam?.name || l.camera_name || l.camera_id}>
                    {cam?.name || l.camera_name || l.camera_id}
                  </div>
                  <div className="aspect-video bg-black">
                    <LinkedPicture camera={cam} eventMs={eventMs} stillPath={still ? imageUrl(still) : null} />
                  </div>
                  {still && cam && (
                    <details className="border-t border-card-border">
                      <summary className="cursor-pointer px-2 py-1 text-[10.5px] text-muted">Frame at the read</summary>
                      <AuthedImage path={imageUrl(still)} alt="Linked camera at the read" />
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {cameraId && !cameraById[cameraId] && (
          <p className="mt-2 text-[11px] text-muted">The ANPR camera itself is not in this VMS&apos;s camera list.</p>
        )}
      </div>
    </div>
  );
}
