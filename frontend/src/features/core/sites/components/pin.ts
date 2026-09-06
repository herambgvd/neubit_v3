// The site map pin, shared by both map providers (Google and the offline
// MapLibre basemap) so a site looks identical whichever one a tenant runs.
//
// Drawn as an SVG rather than a provider symbol so it can carry a ground shadow,
// a gradient body and a white "hole" — the flat Material teardrop read as just
// another POI dot. Authored in a 44×52 box with the tip at (22,44); everything
// else scales off those three numbers.
export const PIN_W = 44;
export const PIN_H = 52;
export const PIN_TIP_Y = 44;

// Rendered at 0.9× normally, 1.15× for the selected site.
export const PIN_SCALE = 0.9;
export const PIN_SCALE_SELECTED = 1.15;

export function pinSvg(color, selected) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_W}" height="${PIN_H}" viewBox="0 0 ${PIN_W} ${PIN_H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".35"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <ellipse cx="22" cy="46.5" rx="${selected ? 7.5 : 6}" ry="${selected ? 3 : 2.4}" fill="#0f172a" opacity=".3"/>
  <path d="M22 4c-7.73 0-14 6.27-14 14 0 9.9 11.9 24.6 12.9 25.9a1.4 1.4 0 0 0 2.2 0C24.1 42.6 36 27.9 36 18c0-7.73-6.27-14-14-14z"
        fill="${color}" stroke="#ffffff" stroke-width="${selected ? 3 : 2.5}" stroke-linejoin="round"/>
  <path d="M22 4c-7.73 0-14 6.27-14 14 0 9.9 11.9 24.6 12.9 25.9a1.4 1.4 0 0 0 2.2 0C24.1 42.6 36 27.9 36 18c0-7.73-6.27-14-14-14z"
        fill="url(#g)"/>
  <circle cx="22" cy="18" r="5.6" fill="#ffffff"/>
  <circle cx="22" cy="18" r="2.4" fill="${color}" opacity=".85"/>
</svg>`;
}
