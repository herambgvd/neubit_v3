"use client";

// SOP canvas toolbar — Add state, an inline hint, and the zoom out / % / zoom in /
// fit controls. Presentational; the parent supplies the handlers + current scale.
import { Icon } from "@iconify/react";
import { Button } from "@/components/ui/kit";

function ToolBtn({ icon, title, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border bg-card text-muted hover:bg-hover hover:text-foreground transition"
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

export default function CanvasToolbar({ scale, onAddState, onZoomIn, onZoomOut, onFit }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-card-border px-3 py-2 bg-card">
      <Button variant="success" icon="heroicons-outline:plus" onClick={onAddState} className="!px-2.5 !py-1 text-xs">
        Add state
      </Button>
      <span className="text-[11px] text-muted hidden sm:inline">
        Drag a node to move · drag the <Icon icon="heroicons-outline:arrow-right-circle" className="inline align-[-2px] text-xs" /> handle to connect
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ToolBtn icon="heroicons-outline:minus" title="Zoom out" onClick={onZoomOut} />
        <span className="text-[11px] text-muted w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <ToolBtn icon="heroicons-outline:plus" title="Zoom in" onClick={onZoomIn} />
        <ToolBtn icon="heroicons-outline:viewfinder-circle" title="Fit to view" onClick={onFit} />
      </div>
    </div>
  );
}
