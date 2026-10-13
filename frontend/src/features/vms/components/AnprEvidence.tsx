"use client";

// THE PLATE READ — what an ANPR camera on a paired recorder saw (SCRUM-324, -325).
//
// A plate read lives in the same three evidence panes as any other event, the way
// AutoVu's read tile, XProtect LPR's preview and the recorder's own event panes show
// it: the read's scene in the monitor pane, the plate itself (crop, text, list) at the
// top of the details, and the camera the recorder bound to the ANPR camera, playing at
// the read, in the third pane. Each piece fills the bounded pane it is given and never
// more: a player here is `absolute inset-0`, so every picture box is `relative`.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import { vms } from "../api";
import { fmtTime } from "../eventLib";
import { anprListCls, anprListLabel, anprSceneStill, type AnprOfEvent } from "../anprLib";
import type { EstateCamera, FederatedAnprRead } from "../types";
import ModeButton from "./ModeButton";
import TilePlayback from "./TilePlayback";

const PRE_ROLL_MS = 8_000;
const POST_ROLL_MS = 45_000;

/** The recorder's own record of the read: attributes, the stills it kept, the cameras
 *  it bound. One query per read, shared by the three panes. */
export function useAnprRead(anpr: AnprOfEvent | null) {
  const nodeId = anpr?.nodeId ?? "";
  const readId = anpr?.readId ?? "";
  return useQuery({
    queryKey: ["vms-anpr-read", nodeId, readId],
    queryFn: () => vms.federation.anpr.read(nodeId, readId),
    enabled: !!nodeId && !!readId,
    staleTime: 15_000,
    // The linked frames land a moment after the read: look again once.
    refetchInterval: (q) => (q.state.dataUpdateCount < 2 ? 8_000 : false),
  });
}

const stillUrl = (anpr: AnprOfEvent, kind: string) => vms.federation.anpr.imageUrl(anpr.nodeId, anpr.readId, kind);

/** An image behind the API's Bearer auth: fetched as a blob, shown from an object URL.
 *  It fills its box; the box decides the size. */
export function AuthedImage({ path, alt, cover = false }: Readonly<{ path: string; alt: string; cover?: boolean }>) {
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
    return <div className="flex h-full w-full items-center justify-center text-[10.5px] text-muted">not available</div>;
  }
  if (!src) return <div className="h-full w-full bg-black/60" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={`h-full w-full ${cover ? "object-cover" : "object-contain"}`} />;
}

/** The plate, the way an operator checks it: the camera's crop beside the text it
 *  read, large, with the list it matched. */
export function AnprPlateCard({
  anpr,
  read,
  onFindPlate,
}: Readonly<{ anpr: AnprOfEvent; read: FederatedAnprRead | undefined; onFindPlate?: (plate: string) => void }>) {
  const hasCrop = !!read?.images.includes("plate");
  return (
    <div className="m-2 rounded-lg border border-card-border bg-background/40 p-2">
      <div className="flex items-center gap-3">
        <div className="relative h-12 w-28 shrink-0 overflow-hidden rounded bg-black">
          {hasCrop ? (
            <AuthedImage path={stillUrl(anpr, "plate")} alt={`Plate crop — ${anpr.plate || "no plate"}`} />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-muted">
              {read ? "no crop" : ""}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[10.5px] text-muted">Plate</div>
          <div className={`truncate text-[18px] font-semibold tracking-wider ${anpr.noPlate ? "text-muted" : "text-foreground"}`}>
            {anpr.noPlate ? "No plate" : anpr.plate}
          </div>
          <span className={`mt-0.5 inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${anprListCls(anpr.list)}`}>
            {anprListLabel(anpr.list, anpr.listLabel)}
          </span>
        </div>
      </div>
      {onFindPlate && !anpr.noPlate && (
        <button
          type="button"
          onClick={() => onFindPlate(anpr.plate)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:queue-list" className="text-xs" /> Every read of this plate
        </button>
      )}
    </div>
  );
}

/** The monitor pane's Snapshot: the scene the camera saw when it read the plate —
 *  there at once, no stream to open. */
export function AnprSnapshot({
  anpr,
  read,
  loading,
  onPlayRecording,
}: Readonly<{ anpr: AnprOfEvent; read: FederatedAnprRead | undefined; loading: boolean; onPlayRecording: () => void }>) {
  const still = read ? anprSceneStill(read.images) : null;
  if (still) {
    return <AuthedImage key={still} path={stillUrl(anpr, still)} alt={`The read — ${anpr.plate || "no plate"}`} />;
  }
  if (loading) return <div className="h-full w-full bg-black/60" />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[12px] text-muted">
        {read ? "The recorder kept no picture of this read." : "The recorder's pictures for this read are not reachable right now."}
      </p>
      <button
        type="button"
        onClick={onPlayRecording}
        className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11px] text-muted transition hover:text-foreground"
      >
        <Icon icon="heroicons-outline:play" className="text-xs" />
        Play the recording at the read
      </button>
    </div>
  );
}

type LinkedMode = "recording" | "frame";

/** The third pane for a plate read: the camera the recorder bound to the ANPR camera,
 *  at the read — its recording by default, the frame the recorder grabbed one click
 *  away, one chip per bound camera, and Playback with all of them for the long look. */
export function AnprLinkedPane({
  anpr,
  read,
  cameraById,
  occurredAt,
  investigateHref,
}: Readonly<{
  anpr: AnprOfEvent;
  read: FederatedAnprRead | undefined;
  cameraById: Record<string, EstateCamera>;
  occurredAt: string | null | undefined;
  investigateHref: string | null;
}>) {
  const linked = read?.linked?.length
    ? read.linked
    : anpr.linkedCameraIds.map((id) => ({ camera_id: id, camera_name: undefined as string | undefined }));
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<LinkedMode>("recording");
  const current = linked.find((l) => l.camera_id === picked) ?? linked[0];
  const cam = current ? cameraById[current.camera_id] : undefined;
  const nameOf = (l: { camera_id: string; camera_name?: string }) =>
    cameraById[l.camera_id]?.name || l.camera_name || l.camera_id;
  const frame = current && read?.images.includes(`linked-${current.camera_id}`) ? `linked-${current.camera_id}` : null;
  const eventMs = occurredAt ? new Date(occurredAt).getTime() : null;
  const showing: LinkedMode = mode === "frame" && frame ? "frame" : "recording";

  let picture;
  if (!current) {
    picture = <Notice>No camera is bound to this ANPR camera on its recorder.</Notice>;
  } else if (showing === "frame" && frame) {
    picture = <AuthedImage key={frame} path={stillUrl(anpr, frame)} alt={`${nameOf(current)} at the read`} />;
  } else if (cam && eventMs != null) {
    picture = (
      <TilePlayback
        key={`${cam.id}:${eventMs}`}
        camera={cam}
        anchorMs={eventMs - PRE_ROLL_MS}
        anchorSeq={eventMs}
        windowToMs={eventMs + POST_ROLL_MS}
        playing
        muted
        compact
      />
    );
  } else if (frame) {
    picture = <AuthedImage key={frame} path={stillUrl(anpr, frame)} alt={`${nameOf(current)} at the read`} />;
  } else {
    picture = <Notice>This camera is not on this VMS, so its recording cannot be shown here.</Notice>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon icon="heroicons-outline:video-camera" className="text-sm text-sky-400" />
        <span className="shrink-0 text-[12px] font-semibold text-foreground">Linked camera</span>
        {linked.length === 1 && current && (
          <span className="truncate text-[11px] text-muted">{nameOf(current)}</span>
        )}
        {investigateHref && (
          <Link
            href={investigateHref}
            title="Open the ANPR camera and every camera bound to it in Playback, at the read"
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-sky-400 transition hover:text-sky-300"
          >
            Playback <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-xs" />
          </Link>
        )}
      </header>
      {linked.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-card-border px-2 py-1">
          {linked.map((l) => (
            <button
              key={l.camera_id}
              type="button"
              aria-pressed={l.camera_id === current?.camera_id}
              onClick={() => setPicked(l.camera_id)}
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] transition ${
                l.camera_id === current?.camera_id
                  ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                  : "border-card-border text-muted hover:text-foreground"
              }`}
            >
              {nameOf(l)}
            </button>
          ))}
        </div>
      )}
      <div className="relative min-h-0 w-full flex-1 bg-black">{picture}</div>
      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
        <ModeButton active={showing === "recording"} onClick={() => setMode("recording")} icon="heroicons-outline:play">
          Recording
        </ModeButton>
        {frame && (
          <ModeButton active={showing === "frame"} onClick={() => setMode("frame")} icon="heroicons-outline:photo">
            Frame at the read
          </ModeButton>
        )}
        {eventMs != null && (
          <span className="ml-auto font-mono text-[10.5px] text-muted">read {fmtTime(occurredAt)}</span>
        )}
      </div>
    </div>
  );
}

function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-muted">{children}</div>
  );
}
