"use client";

// SOP canvas toolbar — Add state, an inline hint, and the zoom out / % / zoom in /
// fit controls. Presentational; the parent supplies the handlers + current scale.
import { Icon } from "@iconify/react";
import { Button } from "@/components/ui/kit";

function ToolBtn({ icon, title, onClick }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-nb-line bg-[rgba(8,15,34,.5)] text-nb-muted hover:bg-[rgba(96,165,250,.1)] hover:text-nb-ink transition"
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

export default function CanvasToolbar({ scale, onAddState, onZoomIn, onZoomOut, onFit }: any) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-nb-line px-3 py-2 bg-[rgba(8,15,34,.5)]">
      <Button variant="success" icon="heroicons-outline:plus" onClick={onAddState} className="!px-2.5 !py-1 text-xs">
        Add state
      </Button>
      <span className="text-[11px] text-nb-muted hidden sm:inline">
        Drag a node to move · drag the <Icon icon="heroicons-outline:arrow-right-circle" className="inline align-[-2px] text-xs" /> handle to connect
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ToolBtn icon="heroicons-outline:minus" title="Zoom out" onClick={onZoomOut} />
        <span className="text-[11px] text-nb-muted w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <ToolBtn icon="heroicons-outline:plus" title="Zoom in" onClick={onZoomIn} />
        <ToolBtn icon="heroicons-outline:viewfinder-circle" title="Fit to view" onClick={onFit} />
      </div>
    </div>
  );
}
