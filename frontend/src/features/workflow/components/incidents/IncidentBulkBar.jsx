"use client";

// Bulk-action bar shown when one or more incidents are selected. Pause / Escalate
// / Cancel over the selection + a Clear. Parent owns the selection + the mutation;
// this is presentational.
import { Button } from "@/components/ui/kit";

export default function IncidentBulkBar({ count, pending, onAction, onClear }) {
  if (count === 0) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
      <span className="text-sm font-medium text-foreground">{count} selected</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" onClick={() => onAction("paused")} disabled={pending} className="!px-3 !py-1.5 text-xs">Pause</Button>
        <Button variant="secondary" icon="heroicons-outline:arrow-trending-up" onClick={() => onAction("escalate")} disabled={pending} className="!px-3 !py-1.5 text-xs">Escalate</Button>
        <Button variant="danger" onClick={() => onAction("cancelled")} disabled={pending} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <button onClick={onClear} className="text-xs text-muted hover:text-foreground px-2">Clear</button>
      </div>
    </div>
  );
}
