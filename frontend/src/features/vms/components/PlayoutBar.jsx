"use client";

// PlayoutBar — the wall-level DVR transport (mockup: bottom playout dock). A 24h
// timeline of the focused camera's REAL recorded coverage (from the node's segment
// index via /vms/federation/.../timeline), with transport controls and click-to-
// play: clicking a covered instant mints a playback session through the recorder
// and plays the tokenized fmp4 in an overlay.
//
// Data is real — recorded ranges come straight from the recorder's Postgres
// segment index; an empty track means the node genuinely has no footage in the
// window (not a stub). Local (non-federated) cameras aren't wired here yet.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { vms } from "../api";

// Colour per recording trigger (mockup palette).
const TRIGGER_COLOR = {
  continuous: "#34d399",
  motion: "#fbbf24",
  schedule: "#60a5fa",
  manual: "#a78bfa",
};

function Btn({ icon, title, onClick, active = false, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border transition ${
        active
          ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
          : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:border-[rgba(34,211,238,.6)] hover:text-[#22d3ee] disabled:cursor-not-allowed disabled:opacity-40"
      }`}
    >
      <Icon icon={icon} className="text-base" />
    </button>
  );
}

// Seconds-from-midnight for an ISO instant, in LOCAL time (the track is a local day).
function daySeconds(iso) {
  const d = new Date(iso);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

export default function PlayoutBar({ camera, onClose }) {
  const [nowFrac, setNowFrac] = useState(0);
  const [play, setPlay] = useState(null); // { url } — active playback overlay

  const federated = !!camera?.federated;
  const nodeId = camera?.node_id;
  const realId = camera?.real_id;

  // Today's window (local midnight → next midnight) as RFC3339 for the node.
  const win = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, []);

  // Playhead at the current time-of-day. Updates each minute; browser-only.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowFrac((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const tlQ = useQuery({
    queryKey: ["fed-timeline", nodeId, realId, win.from],
    queryFn: () => vms.federation.timeline(nodeId, realId, { from: win.from, to: win.to }),
    enabled: federated && !!nodeId && !!realId,
    refetchInterval: 60_000,
  });
  const ranges = tlQ.data?.ranges || [];

  const hours = useMemo(() => Array.from({ length: 25 }, (_, i) => i), []);

  // Mint a playback session from an ISO instant → play the tokenized fmp4.
  const playFrom = async (fromISO) => {
    if (!federated) return;
    try {
      const s = await vms.federation.playback(nodeId, realId, { from: fromISO, to: win.to });
      if (s?.playback_url) setPlay({ url: s.playback_url, start: s.start });
    } catch {
      /* node unreachable / no footage — track stays; no fake playback */
    }
  };

  // Click a covered instant on the track → play from there.
  const onScrub = (e) => {
    if (!federated) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const at = new Date();
    at.setHours(0, 0, 0, 0);
    at.setSeconds(Math.floor(frac * 86400));
    playFrom(at.toISOString());
  };

  // Play the earliest recorded span of the day.
  const playEarliest = () => {
    if (ranges.length === 0) return;
    const earliest = [...ranges].sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    playFrom(earliest.start);
  };

  return (
    <div className="shrink-0 border-t border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.82)] px-3 py-2 backdrop-blur-sm">
      {/* Transport row */}
      <div className="flex items-center gap-2">
        <Btn icon="heroicons-solid:backward" title="Previous event" disabled />
        <Btn icon="heroicons-solid:play" title="Play earliest recording today" disabled={!federated || ranges.length === 0} onClick={playEarliest} />
        <Btn icon="heroicons-solid:forward" title="Next event" disabled />

        <span className="ml-1 inline-flex items-center gap-1.5 rounded-[8px] border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.14)] px-2.5 py-1.5 text-[11px] font-semibold tracking-[.6px] text-[#f87171]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#f87171]" />
          LIVE
        </span>

        <div className="mx-1 h-6 w-px bg-[rgba(150,180,245,.22)]" />

        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#aec2e8]">
          {camera ? (
            <>
              <Icon icon="heroicons-solid:video-camera" className="mr-1 inline text-sm text-[#22d3ee]" />
              {camera.name}
              {camera.node_name && <span className="ml-1.5 text-[#7e93bf]">· {camera.node_name}</span>}
              {federated && (
                <span className="ml-2 text-[#7e93bf]">
                  {tlQ.isLoading ? "loading…" : `${ranges.length} recorded span${ranges.length === 1 ? "" : "s"} today`}
                </span>
              )}
            </>
          ) : (
            <span className="text-[#7e93bf]">Select a camera on the wall to scrub its recordings</span>
          )}
        </span>

        <button
          type="button"
          onClick={onClose}
          title="Hide transport"
          className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[rgba(248,113,113,.5)] hover:text-[#f87171]"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-base" />
        </button>
      </div>

      {/* 24h timeline */}
      <div
        onClick={onScrub}
        className={`relative mt-2 h-9 overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.15)] bg-[#0b1428] ${federated ? "cursor-pointer" : ""}`}
      >
        {/* Recorded coverage spans (REAL) */}
        {ranges.map((r, i) => {
          const left = (daySeconds(r.start) / 86400) * 100;
          const width = Math.max(0.15, ((r.duration || 0) / 86400) * 100);
          const color = TRIGGER_COLOR[r.trigger_type] || TRIGGER_COLOR.continuous;
          return (
            <div
              key={i}
              className="absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px]"
              style={{ left: `${left}%`, width: `${width}%`, background: color, opacity: 0.8 }}
              title={`${new Date(r.start).toLocaleTimeString()} · ${Math.round(r.duration)}s · ${r.trigger_type || "continuous"}`}
            />
          );
        })}

        {/* Hour gridlines + labels */}
        {hours.map((h) => (
          <div
            key={h}
            className="pointer-events-none absolute top-0 h-full border-l border-[rgba(150,180,245,.08)]"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            {h % 3 === 0 && h < 24 && (
              <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#7e93bf]">
                {String(h).padStart(2, "0")}
              </span>
            )}
          </div>
        ))}

        {/* Empty-state note (only when we KNOW there's no footage) */}
        {federated && !tlQ.isLoading && ranges.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
              No recorded footage today
            </span>
          </div>
        )}
        {!federated && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
              {camera ? "Recorder playback only" : "—"}
            </span>
          </div>
        )}

        {/* Playhead at current time-of-day */}
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-[#22d3ee] shadow-[0_0_6px_#22d3ee]"
          style={{ left: `${nowFrac * 100}%` }}
        >
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#22d3ee]" />
        </div>
      </div>

      {/* Playback overlay — a recorded fmp4 window minted through the node. */}
      {play && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setPlay(null)}
        >
          <div className="relative w-full max-w-4xl overflow-hidden rounded-[12px] border border-[rgba(150,180,245,.3)] bg-black" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-[rgba(150,180,245,.2)] px-3 py-2">
              <Icon icon="heroicons-solid:play" className="text-sm text-[#22d3ee]" />
              <span className="font-mono text-[12px] text-[#d7f7e9]">
                {camera?.name} · playback from {play.start ? new Date(play.start).toLocaleTimeString() : "—"}
              </span>
              <button
                type="button"
                onClick={() => setPlay(null)}
                className="ml-auto rounded-md p-1 text-[#aec2e8] hover:bg-white/10 hover:text-white"
              >
                <Icon icon="heroicons-outline:x-mark" className="text-base" />
              </button>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={play.url} controls autoPlay className="max-h-[70vh] w-full bg-black" />
          </div>
        </div>
      )}
    </div>
  );
}
