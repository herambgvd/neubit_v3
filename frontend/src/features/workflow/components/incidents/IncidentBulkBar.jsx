"use client";

// Bulk-action bar shown when one or more incidents are selected. Pause / Escalate
// / Cancel over the selection + a Clear. Parent owns the selection + the mutation;
// this is presentational.
import { Button } from "@/components/ui/kit";

export default function IncidentBulkBar({ count, pending, onAction, onClear }) {
  if (count === 0) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-[13px] border border-[rgba(34,211,238,.35)] bg-[rgba(34,211,238,.08)] px-3 py-2 backdrop-blur-xs">
      <span className="font-mono text-sm font-semibold text-[#67e8f9]">{count} selected</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" onClick={() => onAction("paused")} disabled={pending} className="!px-3 !py-1.5 text-xs">Pause</Button>
        <Button variant="secondary" icon="heroicons-outline:arrow-trending-up" onClick={() => onAction("escalate")} disabled={pending} className="!px-3 !py-1.5 text-xs">Escalate</Button>
        <Button variant="danger" onClick={() => onAction("cancelled")} disabled={pending} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <button onClick={onClear} className="px-2 text-xs text-[#aec2e8] hover:text-[#67e8f9]">Clear</button>
      </div>
    </div>
  );
}
