// The console's icon registry — every glyph, compiled into the bundle.
//
// WHY THIS FILE EXISTS
// --------------------
// `@iconify/react` resolves an icon name it does not already hold by FETCHING it
// from https://api.iconify.design at runtime. Nothing in this app had ever
// registered an offline collection, so all 1,200-odd icon references in the
// console were network calls. On a restricted or air-gapped network — which is
// where a building-management console usually lives — every icon silently
// renders as empty space. No error, no fallback, no console message: Iconify
// treats an unresolvable name as "not ready yet" forever.
//
// `addCollection` puts the icon data in the bundle, so a name resolves
// synchronously from memory and the network is never involved. The sibling
// gateway console (conflux `web/components/common/Icon.tsx`) solved the same
// problem by hand-transcribing SVG paths; this uses the published collections
// instead, so the artwork cannot drift from what the call sites expect and a
// newly-used icon needs no transcription.
//
// WHOLE COLLECTIONS, NOT A SCANNED SUBSET. Several call sites build an icon name
// at runtime (`iconForType(device.device_type)`, the map pin builder, the
// video-wall empty state), so a build-time scan of string literals would miss
// them and reintroduce exactly the failure this file removes — invisibly, and
// only for some devices. The heroicons sets cost a few hundred KB and are worth
// it against a class of bug that cannot be seen in review.
//
// IMPORTED FOR SIDE EFFECT, ONCE, from `src/components/Providers.tsx`, which
// every page mounts under. Registration must happen before the first <Icon>
// renders; importing it from the provider tree guarantees that ordering without
// each of the 232 call sites having to know about it.

import { addCollection } from "@iconify/react";

// v2 ("heroicons:*"), and the v1 sets the older screens still address.
import heroicons from "@iconify-json/heroicons/icons.json";
import heroiconsOutline from "@iconify-json/heroicons-outline/icons.json";
import heroiconsSolid from "@iconify-json/heroicons-solid/icons.json";
import svgSpinners from "@iconify-json/svg-spinners/icons.json";

import type { IconifyJSON } from "@iconify/types";

// ── heroicons-mini: a prefix that never existed ──────────────────────────────
// 48 call sites address `heroicons-mini:*`. There is NO `heroicons-mini` set in
// Iconify — https://api.iconify.design/heroicons-mini.json returns 404 — so
// those icons have never rendered, online or off. Heroicons' 16px solid glyphs
// live in the v2 set as `<name>-16-solid`.
//
// Rather than rewrite 48 call sites (and leave the next person to rediscover the
// same trap), the prefix is SYNTHESIZED here from those glyphs. Every mini name
// the console uses resolves; anything with no 16px counterpart simply is not in
// the collection, which is the honest outcome.
const MINI_SUFFIX = "-16-solid";

function buildMiniCollection(source: IconifyJSON): IconifyJSON {
  const icons: IconifyJSON["icons"] = {};
  for (const [name, icon] of Object.entries(source.icons)) {
    if (name.endsWith(MINI_SUFFIX)) {
      icons[name.slice(0, -MINI_SUFFIX.length)] = icon;
    }
  }
  return {
    prefix: "heroicons-mini",
    icons,
    width: source.width,
    height: source.height,
  };
}

// ── mdi: three icons, not seven thousand ─────────────────────────────────────
// The full Material Design Icons set is ~7,500 glyphs and several megabytes; the
// console uses three. They are inlined rather than pulled in wholesale.
//
// ADDING AN MDI ICON: add it here too, or it will not render. Copy the `body`
// from https://api.iconify.design/mdi.json?icons=<name> — the whole point of
// this file is that nothing is fetched at runtime, so an unlisted name is a
// blank space. Prefer a heroicons equivalent where one exists.
const mdiSubset: IconifyJSON = {
  prefix: "mdi",
  width: 24,
  height: 24,
  icons: {
    "crop-free": {
      body: '<path fill="currentColor" d="M19 3h-4v2h4v4h2V5a2 2 0 0 0-2-2m0 16h-4v2h4a2 2 0 0 0 2-2v-4h-2M5 15H3v4a2 2 0 0 0 2 2h4v-2H5M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2"/>',
    },
    "fit-to-screen-outline": {
      body: '<path fill="currentColor" d="M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3zm9-8v4H8v-4zm2-2H6v8h12z"/>',
    },
    leaf: {
      body: '<path fill="currentColor" d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66l.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8"/>',
    },
  },
};

// Order does not matter — each collection owns its own prefix.
addCollection(heroicons as IconifyJSON);
addCollection(heroiconsOutline as IconifyJSON);
addCollection(heroiconsSolid as IconifyJSON);
addCollection(svgSpinners as IconifyJSON);
addCollection(buildMiniCollection(heroicons as IconifyJSON));
addCollection(mdiSubset);
