"use client";

// The "this chart cannot honestly draw that" panel.
//
// NOT ported — the reference has no counterpart, because its charts never refuse:
// a pie of averages, a gauge with an invented 0–100 scale and a heatmap that
// paints a missing reading as zero all render happily there. Three of the charts
// in this directory refuse instead, and contract §4 is why. A refusal is only
// useful if it says WHAT is wrong and what to change, so this is one component
// rather than three slightly different strings.
//
// It deliberately looks like the widget's other empty states (`ChartWidget`'s
// "No readings in this window") — a refusal is a normal outcome, not an error.

export default function ChartNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] leading-snug text-nb-faint">
      {children}
    </div>
  );
}
