"use client";

// SOP canvas edges (SVG, drawn inside the transformed <g>). CanvasEdge is a
// committed transition: bezier + fat invisible hit path + arrowhead + a centered
// label chip, selectable/editable. PendingEdge is the dashed rubber-band shown
// while dragging a new connection from a node's handle to the cursor.
import { edgePath, bezierPoint, nodeCenter } from "./lib/canvasGeometry";

export default function CanvasEdge({ from, to, label, selected, onSelect, onEdit }) {
  const { a, b, c1, c2 } = edgePath(from, to);
  const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
  const mid = bezierPoint(a, c1, c2, b, 0.5);
  // Arrowhead: end tangent from c2→b.
  const ang = Math.atan2(b.y - c2.y, b.x - c2.x);
  const ah = 11;
  const stroke = selected ? "var(--foreground)" : "var(--muted)";
  const p1 = { x: b.x - Math.cos(ang - Math.PI / 7) * ah, y: b.y - Math.sin(ang - Math.PI / 7) * ah };
  const p2 = { x: b.x - Math.cos(ang + Math.PI / 7) * ah, y: b.y - Math.sin(ang + Math.PI / 7) * ah };
  const charW = 6.4;
  const chipW = Math.max(28, (label || "").length * charW + 16);

  return (
    <g className="pointer-events-auto" style={{ cursor: "pointer" }}
       onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}
       onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
      {/* fat invisible hit area */}
      <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
      <path d={d} stroke={stroke} strokeWidth={selected ? 2.5 : 2} fill="none" />
      <path d={`M ${b.x} ${b.y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`} fill={stroke} />
      {label && (
        <>
          <rect
            x={mid.x - chipW / 2}
            y={mid.y - 11}
            width={chipW}
            height={22}
            rx={11}
            fill="var(--card)"
            stroke={selected ? "var(--foreground)" : "var(--card-border)"}
          />
          <text x={mid.x} y={mid.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="var(--foreground)">
            {label}
          </text>
        </>
      )}
    </g>
  );
}

export function PendingEdge({ from, to }) {
  const a = nodeCenter(from);
  const dx = to.x - a.x;
  const dy = to.y - a.y;
  const c1 = { x: a.x + dx * 0.3, y: a.y + dy * 0.3 + 30 };
  const c2 = { x: to.x - dx * 0.3, y: to.y - dy * 0.3 - 30 };
  const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
  return <path d={d} stroke="var(--foreground)" strokeWidth={2} strokeDasharray="5 4" fill="none" opacity={0.7} />;
}
