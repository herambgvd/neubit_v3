# NeuBit shared design tokens — canonical spec

Source of truth: `neubit_v3/frontend` (`tailwind.config.js` + `src/styles/theme.css`
+ `src/app/layout.js`). This file is the ONE definition. Do not re-derive values
from the source project — copy from here, so three codebases cannot drift.

Target: conflux/web, dashboard/frontend-next, neubit_v3/frontend all render the
same palette, type and elevation.

---

## 1. Semantic tokens (light = default, dark = the NeuBit navy console)

These are the tokens components should use. Light is Vercel-derived; dark is NOT
near-black — it is the navy command console the VMS mockups use, so app chrome
reads as one continuous surface instead of black bars.

```css
:root {
  --background:   #ffffff;
  --foreground:   #000000;
  --card:         #ffffff;
  --card-border:  #eaeaea;
  --muted:        #666666;
  --hover:        #f5f5f5;
  --field-border: #e2e2e2;
}

.dark {
  --background:   #0c1530;
  --foreground:   #f2f6ff;
  --card:         #0b1228;
  --card-border:  #24325c;
  --muted:        #aec2e8;
  --hover:        rgba(150, 180, 245, 0.08);
  --field-border: #24325c;
}
```

## 2. NeuBit console palette (`nb.*`)

Fixed hexes — they do not flip with the theme. Accents and status colours.

```
nb-bg      #0c1530     nb-ink     #f2f6ff     nb-teal    #22d3ee
nb-bg2     #0a1024     nb-muted   #cfd0f2     nb-tealb   #67e8f9
nb-panel   #0e1734     nb-soft    #aec2e8     nb-violet  #a78bfa
nb-field   #0b1228     nb-faint   #9a92c8     nb-violetb #c4b5fd
                                              nb-blue    #60a5fa
nb-line    rgba(160,150,245,.2)               nb-blueb   #93c5fd
nb-line2   rgba(150,180,245,.42)
nb-good    #34d399     nb-warn    #fbbf24     nb-crit    #f87171
```

## 3. Colour scales (50–900)

```
primary   50 #F6F8FF · 100 #EDF0FF · 200 #D1DAFE · 300 #B4C2FD · 400 #8092FF
          500 #4669fa · 600 #3F5EDF · 700 #2A3F96 · 800 #203071 · 900 #151F49
secondary 50 #F9FAFB · 100 #F4F5F7 · 200 #E5E7EB · 300 #D2D6DC · 400 #9FA6B2
          500 #A0AEC0 · 600 #475569 · 700 #334155 · 800 #1E293B · 900 #0F172A
danger    50 #FFF7F7 · 100 #FEEFEF · 200 #FCD6D7 · 300 #FABBBD · 400 #F68B8D
          500 #F1595C · 600 #D75052 · 700 #913638 · 800 #6D292A · 900 #461A1B
warning   50 #FFFAF8 · 100 #FFF4F1 · 200 #FEE4DA · 300 #FDD2C3 · 400 #FCB298
          500 #FA916B · 600 #DF8260 · 700 #965741 · 800 #714231 · 900 #492B20
info      50 #F3FEFF · 100 #E7FEFF · 200 #C5FDFF · 300 #A3FCFF · 400 #5FF9FF
          500 #0CE7FA · 600 #00B8D4 · 700 #007A8D · 800 #005E67 · 900 #003F42
```

```
success   50 #F3FEF8 · 100 #E7FDF1 · 200 #C5FBE3 · 300 #A3F9D5 · 400 #5FF5B1
          500 #50C793 · 600 #3F9A7A · 700 #2E6D61 · 800 #1F4B47 · 900 #0F2A2E
```

## 4. Typography

- Font: **Geist Sans**, loaded via the `geist` npm package
  (`import { GeistSans } from "geist/font/sans"`), applied as
  `GeistSans.className` on `<body>`. NOT Inter — the `fontFamily.inter` entry in
  neubit_v3's Tailwind config is vestigial and unused for body text.
- **Root font-size is 14px**, set on `<html style={{ fontSize: "14px" }}>`.
  Everything rem-based scales down from it; this is what makes the UI compact.
  A project that hard-codes px sizes will look larger than the others — that is
  the single most likely way these three drift visually.
- `antialiased` on `<body>`.

## 5. Elevation

```
shadow-base     0px 0px 1px rgba(40,41,61,.08), 0px 0.5px 2px rgba(96,97,112,.16)
shadow-base2    0px 2px 4px rgba(40,41,61,.04), 0px 8px 16px rgba(96,97,112,.16)
shadow-base3    16px 10px 40px rgba(15,23,42,.22)
shadow-deep     -2px 0px 8px rgba(0,0,0,.16)
shadow-dropdown 0px 4px 8px rgba(0,0,0,.08)
```

## 6. Theme switching

Dark is applied as **`class="dark"` on `<html>`**, and it is the DEFAULT in
neubit_v3. Projects using a different mechanism (conflux uses
`[data-theme="dark"]`) must support the `.dark` class as well so a shared
component behaves the same in all three; keeping the existing selector working
alongside it is fine and is the lower-risk change.

## 7. Motion

```css
@keyframes fade-in    { from { opacity: 0 } to { opacity: 1 } }
@keyframes modal-in   { from { opacity: 0; transform: translateY(8px) scale(.98) }
                        to   { opacity: 1; transform: translateY(0) scale(1) } }
.animate-fade-in  { animation: fade-in 0.15s ease-out }
.animate-modal-in { animation: modal-in 0.18s cubic-bezier(.16,1,.3,1) }
```

---

## 8. Tailwind 4 gotcha — `@theme static`

Tailwind 4 TREE-SHAKES `@theme` variables that no utility class references.
Declaring the `nb-*` palette, the 50–900 scales and the shadow scale in a plain
`@theme` block emits NOTHING for the ones nothing happens to use yet — and the
build passes, so the loss is silent. Use `@theme static` for those blocks.

Verify it rather than assuming: fetch the compiled stylesheet from the running
dev server and grep for `--color-nb-teal`, `--color-primary-500` and
`--shadow-base2`. If they are absent, the block was shaken out.

## Rules for whoever applies this

1. **Copy the values from this file.** Do not open neubit_v3 and re-derive them.
2. **Do not restyle screens.** This is a token swap, not a redesign. If a screen
   looks wrong afterwards, report it — do not start moving layout around.
3. **Status colours keep their meaning** everywhere: good/warn/crit are semantic
   and must not be re-mapped per project.
4. If a project already has an equivalent token under a different name, alias it
   rather than renaming every call site. `--bg` → `--background` is a one-line
   alias; a global find-and-replace across 300 files is a different risk.

---

## 9. Navy is the ONLY theme in conflux and dashforge

Added after the first pass shipped: the light palette is removed from both,
not merely defaulted away from. neubit_v3 is NOT covered by this — leave its
theme handling alone.

Requirement: there must be no path, cookie, preference or toggle that renders a
white surface.

How to do it without a 300-call-site rewrite:

1. **Keep whatever selector the `dark:` variant matches on.** conflux has 2
   `dark:` utilities, dashboard has 303. Removing `.dark` from `<html>` would
   silently fall 303 utilities back to their light base styles. So the class /
   attribute STAYS applied permanently — what goes is the ability to remove it.
2. **Collapse the light block into the dark values** rather than deleting it, so
   an element that somehow escapes the selector still lands on navy instead of
   white. Belt and braces: no white anywhere in the emitted CSS.
3. **Narrow the allowed values, don't just change the default.** A user with a
   `theme_mode=light` cookie from before this change must be coerced to dark.
   Dashboard's boot script already validates against the values list
   (`values.indexOf(value) >= 0 ? value : defaultValue`), so shrinking the list
   to `["dark"]` migrates stale cookies for free.
4. **Remove the switcher UI**, don't just hide it.

Theme PRESETS (dashboard: default / brutalist / soft-pop / tangerine) recolour
`primary` to red, violet and orange. That contradicts one navy identity — keep
`default` only, which is the preset carrying these tokens.

## 10. Product name

Both conflux and dashforge are the product **Conflux**. neubit_v3 stays NeuBit.

Rename user-visible branding ONLY. These are identifiers on a wire or in a
running system and must NOT be renamed — they are spelled the same but they are
not the brand:

- `module dashforge` and its ~511 import paths — pure churn, no visible effect
- `POSTGRES_DB` / `POSTGRES_USER` = `dashforge`, docker volume names — live data
- `dashforge_cdc` — the Postgres LISTEN channel name; renaming breaks any
  already-deployed CDC publication
- `text/dashforge-widget` — internal drag-and-drop MIME type
- `_dashforge-challenge` — DNS TXT record label the backend actually emits
- `admin@dashforge.local` — the seeded superadmin login

Two backend strings ARE user-visible but carry state; rename them and say so in
the commit rather than treating them as ordinary prose:

- `twofa.go` `Issuer: "DashForge"` — shows as the account label in existing
  users' authenticator apps. Existing TOTP codes keep working (the shared secret
  is unchanged), but already-enrolled users will still see the old label until
  they re-enrol.
- `WEBAUTHN_RP_DISPLAY_NAME` default — display only. The RP *ID* is what binds a
  passkey, and that is not being touched, so existing passkeys are unaffected.
