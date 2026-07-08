"use client";

// MapMarker — a single incident pin rendered inside the floor SVG (so it lives in
// the floor's image-pixel coordinate space and scales with the viewBox). Color =
// priority. A count badge is shown when several incidents share one point (zone
// cluster). Clicking selects/opens the incident via the parent handler.

import { sev } from "./lib";

export default function MapMarker({ x, y, priority, count = 1, selected, onClick, title }) {
  const s = sev(priority);
  const r = 13;
  return (
    <g
      transform={`translate(${x} ${y})`}
      onClick={onClick}
      style={{ cursor: "pointer" }}
      role="button"
      aria-label={title}
    >
      <title>{title}</title>
      {/* pulse halo */}
      <circle r={r + 7} fill={s.fill} opacity={selected ? 0.28 : 0.14} />
      <circle
        r={r}
        fill={s.fill}
        stroke={selected ? "#ffffff" : "rgba(0,0,0,0.35)"}
        strokeWidth={selected ? 3 : 2}
      />
      {count > 1 ? (
        <text textAnchor="middle" dy="4.5" fontSize="13" fontWeight="700" fill="#0b0b0f">
          {count}
        </text>
      ) : (
        <circle r="4" fill="#0b0b0f" opacity="0.85" />
      )}
    </g>
  );
}
