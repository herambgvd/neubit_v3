// The DOM behind the estate map's markers, kept out of the canvas component.
//
// MapLibre wants real nodes, and there are two kinds: a CLUSTER bubble (how many
// sites are folded into this dot, and how bad the worst of them is) and a SITE
// pin (the teardrop both map providers share, with an ops badge when the site is
// carrying alarms or dark cameras).
//
// Written as plain DOM rather than React portals because there is one node per
// visible feature and they are rebuilt on every pan: 300 portals re-rendering on
// a drag is what made the older marker layer stutter.
import { PIN_H, PIN_SCALE, PIN_SCALE_SELECTED, PIN_TIP_Y, PIN_W, pinSvg } from "./pin";

/** Colour by what an operator should do about it, not by the threat level a
 *  human set months ago. Matches `opsSeverity` in ../estateRollup. */
export const SEVERITY_COLOR: Record<number, string> = {
  0: "#38bdf8", // normal — the console's blue
  1: "#fbbf24", // a camera is dark
  2: "#f87171", // unacknowledged alarms
};

export function severityColor(rank: number | undefined): string {
  return SEVERITY_COLOR[rank ?? 0] || SEVERITY_COLOR[0];
}

export interface ClusterInfo {
  count: number;
  /** Worst `SEVERITY_RANK` among the sites folded in. */
  severity: number;
  alarms: number;
  offline: number;
}

/** The bubble a cluster of sites renders as. Size grows with the count, slowly:
 *  a linear radius makes a 200-site cluster cover a city. */
export function clusterElement(info: ClusterInfo): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "site-cluster";
  paintCluster(el, info);
  return el;
}

export function paintCluster(el: HTMLDivElement, info: ClusterInfo): void {
  const size = Math.min(56, 30 + Math.log2(Math.max(info.count, 2)) * 6);
  const color = severityColor(info.severity);
  el.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "border-radius:9999px",
    "cursor:pointer",
    "font-weight:700",
    `font-size:${size > 44 ? 13 : 12}px`,
    "color:#04122b",
    `background:${color}`,
    `border:2px solid rgba(255,255,255,.85)`,
    `box-shadow:0 0 0 6px ${color}33, 0 4px 14px rgba(3,8,22,.55)`,
  ].join(";");
  el.textContent = String(info.count);
  const trouble = [
    info.alarms ? `${info.alarms} alarm${info.alarms === 1 ? "" : "s"}` : null,
    info.offline ? `${info.offline} camera${info.offline === 1 ? "" : "s"} offline` : null,
  ].filter(Boolean);
  el.title = `${info.count} sites${trouble.length ? ` · ${trouble.join(" · ")}` : ""}`;
}

export interface PinInfo {
  name: string;
  /** Threat colour — still the pin body, so a lockdown site stays recognisable. */
  color: string;
  label: string;
  selected: boolean;
  alarms: number;
  offline: number;
  showLabel: boolean;
}

const LABEL_MAX = 26;

/** A site pin: the shared teardrop, its name, and an ops badge when it has one. */
export function pinElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "site-pin";
  // NO `position` here. MapLibre's `.maplibregl-marker` supplies `position:
  // absolute`, and an inline `position: relative` beats it — the markers then
  // stack in document flow, each pushed below the last regardless of zoom.
  el.style.cssText = "cursor:pointer";
  el.appendChild(Object.assign(document.createElement("div"), { className: "site-pin-art" }));
  el.appendChild(Object.assign(document.createElement("span"), { className: "site-marker-label" }));
  el.appendChild(Object.assign(document.createElement("span"), { className: "site-pin-badge" }));
  return el;
}

/** Repaint an existing pin in place. Returns the offset MapLibre should use so
 *  the tip — not the box bottom — sits on the coordinate. */
export function paintPin(el: HTMLElement, info: PinInfo): [number, number] {
  const scale = info.selected ? PIN_SCALE_SELECTED : PIN_SCALE;
  el.title = `${info.name} · ${info.label}`;
  el.style.width = `${PIN_W * scale}px`;
  el.style.height = `${PIN_H * scale}px`;
  el.style.zIndex = info.selected ? "3" : info.alarms ? "2" : "1";

  const art = el.querySelector(".site-pin-art") as HTMLDivElement;
  art.innerHTML = pinSvg(info.color, info.selected);
  const svg = art.firstElementChild as SVGElement;
  svg.setAttribute("width", `${PIN_W * scale}`);
  svg.setAttribute("height", `${PIN_H * scale}`);
  svg.style.display = "block";

  const caption = el.querySelector(".site-marker-label") as HTMLSpanElement;
  caption.textContent =
    info.name.length > LABEL_MAX ? `${info.name.slice(0, LABEL_MAX - 1)}…` : info.name;
  caption.style.display = info.showLabel ? "" : "none";

  // The badge carries the number that would make someone click: alarms first,
  // then dark cameras. No badge at all when there is nothing to report — a "0"
  // on every pin is noise that hides the one pin with a 3 on it.
  const badge = el.querySelector(".site-pin-badge") as HTMLSpanElement;
  if (info.alarms > 0) {
    badge.style.display = "";
    badge.style.background = SEVERITY_COLOR[2];
    badge.textContent = String(info.alarms);
    badge.title = `${info.alarms} unacknowledged alarm${info.alarms === 1 ? "" : "s"}`;
  } else if (info.offline > 0) {
    badge.style.display = "";
    badge.style.background = SEVERITY_COLOR[1];
    badge.textContent = String(info.offline);
    badge.title = `${info.offline} camera${info.offline === 1 ? "" : "s"} offline`;
  } else {
    badge.style.display = "none";
  }

  // The artwork has 8px of shadow below the tip.
  return [0, (PIN_H - PIN_TIP_Y) * scale];
}
