"use client";

// SOP state-machine on the incident detail — a read-only SVG diagram that lays the
// states out as boxes with directional arrows drawn between them following the SOP
// transitions (curved bezier connectors with arrowheads), the current state
// highlighted. Mirrors v2's incident-state-machine graphical intent, rethemed to v3
// tokens and adapted to v3 field names (state_id / from_state_id / to_state_id /
// position_x/y / is_initial / is_terminal). The editable canvas lives in sop-designer/.
import { useMemo } from "react";
import { Icon } from "@iconify/react";

// Normalise id/name accessors across possible backend field names.
export const stateId = (s) => s?.id ?? s?.state_id;
export const stateName = (s) => s?.name ?? s?.state_name;

// Box + spacing geometry for the diagram.
const BOX_W = 180;
const BOX_H = 60;
const PAD = 24;

// Lay states out. Prefer stored designer positions (position_x/position_y); fall
// back to an evenly-spaced vertical chain when no positions are present.
function useLayout(states) {
  return useMemo(() => {
    if (!states.length) return { placed: [], byId: new Map(), width: 0, height: 0 };

    const hasPositions = states.some(
      (s) => Number.isFinite(s.position_x) || Number.isFinite(s.position_y),
    );

    let placed;
    if (hasPositions) {
      const xs = states.map((s) => s.position_x ?? 0);
      const ys = states.map((s) => s.position_y ?? 0);
      const minX = Math.min(...xs, 0);
      const minY = Math.min(...ys, 0);
      placed = states.map((s) => ({
        ...s,
        _x: (s.position_x ?? 0) - minX + PAD,
        _y: (s.position_y ?? 0) - minY + PAD,
      }));
    } else {
      placed = states.map((s, i) => ({
        ...s,
        _x: PAD,
        _y: PAD + i * (BOX_H + 40),
      }));
    }

    const width = Math.max(...placed.map((s) => s._x + BOX_W)) + PAD;
    const height = Math.max(...placed.map((s) => s._y + BOX_H)) + PAD;

    const byId = new Map();
    placed.forEach((s) => byId.set(stateId(s), s));

    return { placed, byId, width, height };
  }, [states]);
}

// Cubic-bezier connector from box `a` to box `b`, exiting the bottom / entering the
// top so arrows read as directional (mirrors sop-designer edgePath intent).
function connector(a, b) {
  const x1 = a._x + BOX_W / 2;
  const y1 = a._y + BOX_H;
  const x2 = b._x + BOX_W / 2;
  const y2 = b._y;
  const dy = Math.max(30, Math.abs(y2 - y1) * 0.4);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

export default function StateMachine({ states, transitions, currentStateId, currentStateName }) {
  const layout = useLayout(states);
  const isCurrent = (s) =>
    stateId(s) === currentStateId || stateName(s) === currentStateName;

  return (
    <div className="rounded-xl border border-card-border bg-card">
      <header className="px-5 py-4 border-b border-card-border">
        <h3 className="text-sm font-semibold text-foreground">State machine</h3>
        <p className="text-xs text-muted mt-0.5">
          {states.length} state(s) · {transitions.length} transition(s)
        </p>
      </header>
      <div className="px-5 py-5">
        {states.length === 0 ? (
          <p className="text-sm text-muted">SOP definition not available.</p>
        ) : (
          <div className="overflow-auto">
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="block max-w-full"
            >
              <defs>
                <marker
                  id="sm-arrowhead"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>

              {/* Directional arrows following the SOP transitions. */}
              <g className="text-card-border">
                {transitions.map((t, i) => {
                  const from = t.from_state_id ?? t.from_state;
                  const to = t.to_state_id ?? t.to_state;
                  const a = layout.byId.get(from);
                  const b = layout.byId.get(to);
                  if (!a || !b || a === b) return null;
                  return (
                    <path
                      key={t.transition_id ?? t.id ?? i}
                      d={connector(a, b)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      markerEnd="url(#sm-arrowhead)"
                    />
                  );
                })}
              </g>

              {/* State boxes. */}
              {layout.placed.map((s, i) => {
                const cur = isCurrent(s);
                return (
                  <g key={stateId(s) ?? i} transform={`translate(${s._x},${s._y})`}>
                    <rect
                      width={BOX_W}
                      height={BOX_H}
                      rx={10}
                      className={
                        cur
                          ? "fill-blue-500/10 stroke-blue-500"
                          : s.is_terminal
                            ? "fill-hover stroke-card-border"
                            : "fill-card stroke-card-border"
                      }
                      strokeWidth={cur ? 2 : 1}
                    />
                    <text
                      x={BOX_W / 2}
                      y={cur ? BOX_H / 2 - 4 : BOX_H / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className={
                        cur
                          ? "fill-blue-500"
                          : s.is_terminal
                            ? "fill-muted"
                            : "fill-foreground"
                      }
                      style={{ fontSize: 13, fontWeight: cur ? 600 : 500 }}
                    >
                      {stateName(s)}
                    </text>
                    {cur && (
                      <text
                        x={BOX_W / 2}
                        y={BOX_H - 12}
                        textAnchor="middle"
                        className="fill-blue-500"
                        style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.05em" }}
                      >
                        CURRENT
                      </text>
                    )}
                    {s.is_initial && (
                      <foreignObject x={-8} y={-8} width={20} height={20}>
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-white">
                          <Icon icon="heroicons-solid:play" className="text-[9px]" />
                        </span>
                      </foreignObject>
                    )}
                    {s.is_terminal && (
                      <foreignObject x={BOX_W - 12} y={-8} width={20} height={20}>
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-500 text-white">
                          <Icon icon="heroicons-solid:flag" className="text-[9px]" />
                        </span>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
