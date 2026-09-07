"use client";

import { Card } from "@/components/ui/kit";
import { useAppearance } from "@/lib/appearance";
import { FONT_OPTIONS, SCALE_OPTIONS, fontStack } from "@/lib/fonts/catalog";

// No "Saved" toast on this card, unlike the rest of the tab. The change applies
// to the whole console the instant it is clicked — that IS the confirmation, and
// a toast per click while an operator tries five faces is just noise.

function tileClass(active: boolean) {
  return [
    "rounded-lg border px-3 py-2.5 text-left transition",
    active
      ? "border-nb-blue bg-nb-blue/10"
      : "border-card-border hover:border-muted/60 hover:bg-hover",
  ].join(" ");
}

export default function AppearanceCard() {
  const { font, scale, setFont, setScale } = useAppearance();

  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-foreground mb-1">Appearance</h2>
      <p className="text-xs text-muted mb-4">
        Applies to this browser straight away, and follows you to a new one.
      </p>

      <div className="text-xs font-medium text-foreground mb-2">Typeface</div>
      <div className="grid gap-2 sm:grid-cols-2">
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

      <div className="text-xs font-medium text-foreground mt-5 mb-2">Text size</div>
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
    </Card>
  );
}
