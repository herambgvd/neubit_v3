// Pure geometry + layout math for the SOP canvas — node dimensions, bezier edge
// paths, a point-on-curve helper (for label + arrowhead placement), and the
// fit-to-view computation. No React, no DOM.

export const NODE_W = 190;
export const NODE_H = 76;
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 2.5;
export const DEFAULT_COLOR = "#6366F1";

export const nodeCenter = (s) => ({
  x: (s.position_x ?? 0) + NODE_W / 2,
  y: (s.position_y ?? 0) + NODE_H / 2,
});

// Bezier control points between two node centers — mirrors v2's transitionGeometry
// (drops a little so parallel edges separate and the curve reads as directional).
export function edgePath(from, to) {
  const a = nodeCenter(from);
  const b = nodeCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ox = dx * 0.3;
  const oy = dy * 0.3;
  const c1 = { x: a.x + ox, y: a.y + oy + 30 };
  const c2 = { x: b.x - ox, y: b.y - oy - 30 };
  return { a, b, c1, c2 };
}

// Point at t on the cubic bezier (for label placement + arrowhead angle).
export function bezierPoint(a, c1, c2, b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

export function computeFit(states, w, h) {
  if (!states.length || !w || !h) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of states) {
    const x = s.position_x ?? 0;
    const y = s.position_y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const scale = Math.max(MIN_SCALE, Math.min((w - 100) / bw, (h - 100) / bh, 1.2));
  return {
    scale,
    offset: {
      x: (w - bw * scale) / 2 - minX * scale,
      y: (h - bh * scale) / 2 - minY * scale,
    },
  };
}
