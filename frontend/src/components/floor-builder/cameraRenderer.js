"use client";

// Canvas renderer for a device placement on the floor plan.
// Ported from neubit_v2's camera-renderer.js. Drawn in screen space (post
// worldToScreen). Renders, per device_type:
//   • camera            → FoV cone (honoring rotation/fov/coverage_radius) + body
//                          + camera glyph + rotate handle when selected.
//   • access_control    → shield glyph (an access controller / panel).
//   • door              → door glyph.
//   • nvr / panel       → server / flame glyphs (kept from v2 for when VMS/fire land).
//   • other             → plain dot.
// Labels get a white halo + dark fill so they stay legible over dark floorplans
// (mirrors the zone-label treatment in floor-plan-canvas.jsx).

export function drawCameraPlacement({ ctx, device, isSelected, scale, worldToScreen }) {
  const x = device.x ?? 0;
  const y = device.y ?? 0;
  const rotationDeg = device.rotation ?? 0;
  const fovDeg = device.fov ?? 70;
  const coverage = device.coverage_radius ?? 60;
  const color = device.color || "#2563eb";
  const deviceType = String(device.device_type || device.type || "camera").toLowerCase();
  const isCamera = deviceType === "camera";
  const isNvr = deviceType === "nvr";
  const isPanel = deviceType === "panel";
  const isAccess = deviceType === "access_control";
  const isDoor = deviceType === "door";

  const [sx, sy] = worldToScreen(x, y);
  const half = (fovDeg / 2) * (Math.PI / 180);
  const facing = (rotationDeg - 90) * (Math.PI / 180); // 0deg = up

  if (isCamera) {
    // FoV cone
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, coverage * scale, facing - half, facing + half);
    ctx.closePath();
    const grad = ctx.createRadialGradient(sx, sy, 4 * scale, sx, sy, coverage * scale);
    grad.addColorStop(0, hexToRgba(color, 0.5));
    grad.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, isSelected ? 0.9 : 0.5);
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.stroke();
  }

  // Body
  ctx.beginPath();
  ctx.arc(sx, sy, 9, 0, Math.PI * 2);
  ctx.fillStyle = isSelected ? color : "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  const iconColor = isSelected ? "#ffffff" : color;

  if (isCamera) {
    // Camera glyph
    ctx.strokeStyle = iconColor;
    ctx.fillStyle = iconColor;
    ctx.lineWidth = 1.4;

    ctx.beginPath();
    ctx.roundRect(sx - 4.8, sy - 2.8, 7.8, 5.6, 1.2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sx + 2.8, sy - 2.2);
    ctx.lineTo(sx + 6.2, sy - 4.2);
    ctx.lineTo(sx + 6.2, sy + 4.2);
    ctx.lineTo(sx + 2.8, sy + 2.2);
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sx - 1.1, sy, 0.85, 0, Math.PI * 2);
    ctx.fill();
  } else if (isAccess) {
    // Shield glyph for access controllers.
    ctx.strokeStyle = iconColor;
    ctx.fillStyle = iconColor;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 5);
    ctx.lineTo(sx + 4, sy - 3);
    ctx.lineTo(sx + 4, sy + 0.5);
    ctx.quadraticCurveTo(sx + 4, sy + 4, sx, sy + 5.2);
    ctx.quadraticCurveTo(sx - 4, sy + 4, sx - 4, sy + 0.5);
    ctx.lineTo(sx - 4, sy - 3);
    ctx.closePath();
    ctx.stroke();
  } else if (isDoor) {
    // Door glyph — a panel with a knob.
    ctx.strokeStyle = iconColor;
    ctx.fillStyle = iconColor;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.roundRect(sx - 3.4, sy - 5, 6.8, 10, 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx + 1.6, sy + 0.4, 0.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (isNvr) {
    // Server/rack glyph for NVR devices.
    ctx.strokeStyle = iconColor;
    ctx.fillStyle = iconColor;
    ctx.lineWidth = 1.3;

    ctx.beginPath();
    ctx.roundRect(sx - 5.2, sy - 5, 10.4, 10, 1.8);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sx - 3.8, sy - 1.8);
    ctx.lineTo(sx + 3.8, sy - 1.8);
    ctx.moveTo(sx - 3.8, sy + 0.2);
    ctx.lineTo(sx + 3.8, sy + 0.2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sx - 3.8, sy + 3.1, 0.7, 0, Math.PI * 2);
    ctx.arc(sx - 1.8, sy + 3.1, 0.7, 0, Math.PI * 2);
    ctx.fill();
  } else if (isPanel) {
    // Flame glyph for fire panels.
    const flameColor = isSelected ? "#ffffff" : "#dc2626";
    ctx.fillStyle = flameColor;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 5);
    ctx.bezierCurveTo(sx + 4.5, sy - 1, sx + 3.2, sy + 4, sx, sy + 4.5);
    ctx.bezierCurveTo(sx - 3.2, sy + 4, sx - 4.5, sy - 1, sx, sy - 5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx, sy - 0.5);
    ctx.bezierCurveTo(sx + 2.2, sy + 1, sx + 1.6, sy + 3.6, sx, sy + 4);
    ctx.bezierCurveTo(sx - 1.6, sy + 3.6, sx - 2.2, sy + 1.4, sx, sy - 0.5);
    ctx.closePath();
    ctx.fillStyle = isSelected ? "#dc2626" : "#fca5a5";
    ctx.fill();
  } else {
    // Fallback device dot.
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? color : "#64748b";
    ctx.fill();
  }

  // Label (always visible) — white halo + dark fill so it reads on any floorplan.
  ctx.font = "11px system-ui";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.strokeText(device.label || device.name || "device", sx, sy + 22);
  ctx.fillStyle = "rgba(15,23,42,0.9)";
  ctx.fillText(device.label || device.name || "device", sx, sy + 22);
  ctx.textAlign = "start";

  if (isSelected && isCamera) {
    // Rotate handle (above the camera, facing UP relative to rotation).
    const handleR = 28; // px
    const hx = sx + Math.cos(facing - Math.PI / 2) * handleR;
    const hy = sy + Math.sin(facing - Math.PI / 2) * handleR;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(hx, hy, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "#2563eb");
  if (!m) return `rgba(37,99,235,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
