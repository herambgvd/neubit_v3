"use client";

// PlayoutBar — the wall-level DVR transport (mockup: bottom playout dock). A
// 24-hour timeline with transport controls, LIVE pill, speed, and (eventually)
// recording segments + bookmarks scrubbed across the wall's focused camera.
//
// SCAFFOLD: the transport chrome + 24h track are real, but the segment/bookmark
// data comes from each node's recording index (federation playback) which is
// wired in a later phase. We show an HONEST empty track ("no footage indexed")
// rather than painting fake segments. The playhead sits at the current hour.
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";

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

export default function PlayoutBar({ camera, onClose }) {
  const [live, setLive] = useState(true);
  const [nowFrac, setNowFrac] = useState(0); // 0..1 across the 24h day

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

  const hours = useMemo(() => Array.from({ length: 25 }, (_, i) => i), []);

  return (
    <div className="shrink-0 border-t border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.82)] px-3 py-2 backdrop-blur-sm">
      {/* Transport row */}
      <div className="flex items-center gap-2">
        <Btn icon="heroicons-solid:backward" title="Previous event" disabled />
        <Btn icon="heroicons-solid:play" title="Play" active={!live} onClick={() => setLive(false)} />
        <Btn icon="heroicons-solid:forward" title="Next event" disabled />

        <button
          type="button"
          onClick={() => setLive(true)}
          className={`inline-flex h-[30px] items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-semibold tracking-[.6px] transition ${
            live
              ? "border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.14)] text-[#f87171]"
              : "border-[rgba(150,180,245,.22)] text-[#aec2e8] hover:text-[#67e8f9]"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[#f87171]" : "bg-[#7e93bf]"}`} />
          LIVE
        </button>

        <span className="ml-1 inline-flex items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 py-1 font-mono text-[11px] text-[#aec2e8]">
          1×
        </span>

        <div className="mx-1 h-6 w-px bg-[rgba(150,180,245,.22)]" />

        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#aec2e8]">
          {camera ? (
            <>
              <Icon icon="heroicons-solid:video-camera" className="mr-1 inline text-sm text-[#22d3ee]" />
              {camera.name}
              {camera.node_name && <span className="ml-1.5 text-[#7e93bf]">· {camera.node_name}</span>}
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
      <div className="relative mt-2 h-9 overflow-hidden rounded-[9px] border border-[rgba(150,180,245,.15)] bg-[#0b1428]">
        {/* Hour gridlines + labels */}
        {hours.map((h) => (
          <div
            key={h}
            className="absolute top-0 h-full border-l border-[rgba(150,180,245,.08)]"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            {h % 3 === 0 && h < 24 && (
              <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#7e93bf]">
                {String(h).padStart(2, "0")}
              </span>
            )}
          </div>
        ))}

        {/* Empty-state note — no recording index wired yet (honest). */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[10px] tracking-[.6px] text-[#7e93bf]">
            {camera ? "No recorded footage indexed for this camera yet" : "—"}
          </span>
        </div>

        {/* Playhead at current time-of-day */}
        <div
          className="absolute top-0 h-full w-px bg-[#22d3ee] shadow-[0_0_6px_#22d3ee]"
          style={{ left: `${nowFrac * 100}%` }}
        >
          <span className="absolute -top-0 left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#22d3ee]" />
        </div>
      </div>
    </div>
  );
}
