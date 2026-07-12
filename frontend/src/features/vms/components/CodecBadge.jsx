"use client";

// Web-stream codec badge (stream codec policy). Signals whether a camera's SUB
// (web) stream plays DIRECTLY in the browser (H.264, no transcode) or falls back
// to the heavier server-side transcode path (H.265). Driven by two CameraPublic
// fields:
//   web_codec_enforced === true  OR  sub_stream_codec === "H264"
//     → emerald "H.264 web" (direct-play, no transcode)
//   sub_stream_codec === "H265" (and not enforced)
//     → amber "H.265 · transcoded" (plays via the transcode fallback, heavier)
//   unknown / null → nothing (or a subtle "—" when `showDash`)
//
// Rendered wherever cameras are listed/detailed — the CameraTable, the CameraGrid
// card meta line, and the Device/maintenance view. Kept compact + consistent with
// the other inline chips.
import { Icon } from "@iconify/react";

// Resolve the codec policy state from a camera (or a { sub_stream_codec,
// web_codec_enforced } shape). Returns null when unknown.
export function codecPolicyState(camera) {
  if (!camera) return null;
  const enforced = camera.web_codec_enforced === true;
  const sub = (camera.sub_stream_codec || "").toString().toUpperCase();
  if (enforced || sub === "H264" || sub === "H.264") {
    return { kind: "direct", label: "H.264 web", icon: "heroicons:check-circle" };
  }
  if (sub === "H265" || sub === "H.265" || sub === "HEVC") {
    return { kind: "transcoded", label: "H.265 · transcoded", icon: "heroicons:arrow-path-rounded-square" };
  }
  return null;
}

export default function CodecBadge({ camera, showDash = false, className = "" }) {
  const state = codecPolicyState(camera);
  if (!state) {
    return showDash ? <span className="text-[11px] text-muted">—</span> : null;
  }
  const tone =
    state.kind === "direct"
      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
      : "bg-amber-500/10 text-amber-500 border-amber-500/20";
  const title =
    state.kind === "direct"
      ? "Sub-stream is H.264 — browsers play it directly (no transcoding)."
      : "Sub-stream is H.265 — the browser can't decode it directly, so it plays via the server transcode fallback (heavier).";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${tone} ${className}`}
    >
      <Icon icon={state.icon} className="text-[11px]" />
      {state.label}
    </span>
  );
}
