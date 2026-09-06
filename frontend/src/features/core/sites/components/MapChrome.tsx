"use client";

// Provider-neutral map chrome. Lives apart from both canvases so SitesMap can
// show a spinner without statically importing either of them — each canvas drags
// in a heavyweight SDK (Google's JS loader / MapLibre GL) and is code-split.
import { Spinner } from "@/components/ui/kit";

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-nb-muted">
      <Spinner className="!h-4 !w-4" /> Loading map…
    </div>
  );
}
