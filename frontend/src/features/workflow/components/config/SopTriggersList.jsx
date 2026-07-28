"use client";

// Read-only list of the triggers whose sop_id == this SOP. Shown on the SOP
// builder's "Triggers" sub-tab. Editing happens on the top-level Triggers tab;
// this surface is informational (name, enabled badge, event_type, fire count /
// last-fired).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";
import { asItems, idOf, fmtRelative } from "@/lib/format";
import { workflow as wfApi } from "../../api";

export default function SopTriggersList({ sopId }) {
  const q = useQuery({
    queryKey: ["wf-triggers", { sop_id: sopId }],
    queryFn: () => wfApi.triggers.list({ sop_id: sopId, limit: 200 }),
    enabled: !!sopId,
  });
  const all = asItems(q.data);
  // Defensive: narrow client-side in case the API doesn't filter by sop_id.
  const items = useMemo(() => all.filter((t) => !t.sop_id || t.sop_id === sopId), [all, sopId]);

  return (
    <div className="px-6 py-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-nb-ink">Triggers</h3>
        <p className="text-xs text-nb-faint">
          Triggers that automatically raise an incident from this SOP. Manage them on the top-level <b>Triggers</b> tab.
        </p>
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-nb-faint"><Spinner className="!h-4 !w-4" /> Loading…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-nb-line px-6 py-10 text-center text-sm text-nb-faint">
          No triggers attached to this SOP.
        </div>
      ) : (
        <ul className="rounded-lg border border-nb-line divide-y divide-nb-line">
          {items.map((t) => {
            const enabled = t.enabled !== false;
            return (
              <li key={idOf(t, "id", "trigger_id")} className="flex items-start gap-3 px-4 py-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[rgba(251,191,36,.10)] text-nb-warn shrink-0">
                  <Icon icon="heroicons:bolt" className="text-base" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-nb-ink truncate">{t.name}</span>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${enabled ? "bg-[rgba(52,211,153,.10)] text-nb-good" : "bg-[rgba(96,165,250,.1)] text-nb-faint"}`}>
                      {enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <div className="block text-[11px] text-nb-faint font-mono truncate mt-0.5">
                    {t.event_source ? `${t.event_source}:` : ""}{t.event_type || "any"}
                  </div>
                  <div className="block text-[10px] text-nb-faint/70 truncate">
                    fired {t.fire_count ?? 0}× · last {fmtRelative(t.last_fired_at)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
