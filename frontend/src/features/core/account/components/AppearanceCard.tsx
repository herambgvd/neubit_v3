"use client";

import { Icon } from "@iconify/react";

import { Card } from "@/components/ui/kit";
import { useAppearance } from "@/lib/appearance";
import { FONT_OPTIONS, SCALE_OPTIONS, fontStack } from "@/lib/fonts/catalog";
import { THEME_OPTIONS, type Theme } from "@/lib/theme";

// No "Saved" toast on this card, unlike the rest of the tab. The change applies
// to the whole console the instant it is clicked — that IS the confirmation, and
// a toast per click while an operator tries five faces is just noise.

function tileClass(active: boolean) {
  return [
    "rounded-lg border px-3 py-2.5 text-left transition",
    active ? "border-nb-blue bg-nb-blue/10" : "border-card-border hover:border-muted/60 hover:bg-hover",
  ].join(" ");
}

/** A miniature console drawn in `theme` — top bar, a side list, a card with a
 *  meter and two video tiles — so each option shows what it looks like before it
 *  is picked. aria-hidden: it illustrates, it says nothing. */
function ThemePreview({ theme }: Readonly<{ theme: Theme }>) {
  return (
    <div data-theme={theme} aria-hidden className="bg-background p-2.5">
      <div className="flex h-20 overflow-hidden rounded-md border border-card-border bg-background">
        <div className="w-1/4 space-y-1.5 border-r border-card-border bg-card p-1.5">
          <div className="h-1.5 w-3/4 rounded-full bg-foreground/80" />
          <div className="h-1.5 w-full rounded-full bg-nb-blue" />
          <div className="h-1.5 w-2/3 rounded-full bg-muted/50" />
          <div className="h-1.5 w-3/4 rounded-full bg-muted/50" />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-1.5">
          <div className="flex items-center justify-between">
            <div className="h-1.5 w-1/3 rounded-full bg-foreground/80" />
            <div className="h-2.5 w-7 rounded-sm bg-nb-blue" />
          </div>
          <div className="flex flex-1 flex-col gap-1.5 rounded-sm border border-card-border bg-card p-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
              <div className="h-full w-3/5 rounded-full bg-nb-good" />
            </div>
            <div className="flex flex-1 gap-1">
              <div className="flex-1 rounded-sm bg-black" />
              <div className="flex-1 rounded-sm bg-black" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AppearanceCard() {
  const { theme, font, scale, setTheme, setFont, setScale } = useAppearance();

  return (
    // A CONTAINER query, not a viewport one: this card is the full width of My
    // account and a third of the pane inside Config's channel grid, and `sm:`
    // measures the window, so it would put cramped columns in the narrow one.
    <Card className="@container p-6">
      <h2 className="text-sm font-semibold text-foreground mb-1">Appearance</h2>
      <p className="text-xs text-muted mb-4">Applies to this browser straight away, and follows you to a new one.</p>

      <div className="text-xs font-medium text-foreground mb-2">Theme</div>
      <div role="radiogroup" aria-label="Theme" className="grid max-w-[54rem] gap-3 @lg:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const active = theme === option.key;
          return (
            <label
              key={option.key}
              className={`cursor-pointer overflow-hidden rounded-lg border transition focus-within:ring-2 focus-within:ring-nb-blue ${
                active ? "border-nb-blue" : "border-card-border hover:border-muted/60"
              }`}
            >
              <input
                type="radio"
                name="console-theme"
                value={option.key}
                checked={active}
                onChange={() => setTheme(option.key)}
                className="sr-only"
              />
              <ThemePreview theme={option.key} />
              <div className="flex items-start justify-between gap-2 border-t border-card-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-foreground">{option.label}</div>
                  <div className="text-[11px] text-muted mt-0.5">{option.note}</div>
                </div>
                <Icon
                  icon="heroicons-solid:check-circle"
                  aria-hidden
                  className={`mt-0.5 shrink-0 text-base text-nb-blue ${active ? "" : "invisible"}`}
                />
              </div>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-muted mt-2 mb-5">Video always stays on black.</p>

      <div className="grid gap-x-8 gap-y-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <div className="text-xs font-medium text-foreground mb-2">Typeface</div>
          <div className="grid gap-2 @md:grid-cols-2">
            {FONT_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={font === option.key}
                onClick={() => setFont(option.key)}
                className={tileClass(font === option.key)}
              >
                {/* Rendered in the face it offers, so the choice is visible before it is made. */}
                <div className="text-sm text-foreground" style={{ fontFamily: fontStack(option.key) }}>
                  {option.label}
                </div>
                <div className="text-[11px] text-muted mt-0.5">{option.note}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-foreground mb-2">Text size</div>
          <div className="flex flex-wrap gap-2">
            {SCALE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={scale === option.key}
                onClick={() => setScale(option.key)}
                className={`${tileClass(scale === option.key)} px-3 py-1.5`}
              >
                <span className="text-xs text-foreground">{option.label}</span>
                <span className="text-[11px] text-muted ml-1.5">{option.px}px</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2">
            This is the root size — spacing scales with it, not just the letters.
          </p>
        </div>
      </div>
    </Card>
  );
}
