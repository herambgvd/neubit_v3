"use client";

// Threat levels tab — set a per-site (or deployment-wide) posture and list the
// current register. Scope select + reason use the shared Field; the level picker
// grid and posture list are bespoke.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Spinner } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { workflow as wfApi } from "../../api";

// Threat posture levels (mirrors backend ThreatLevelValue).
const THREAT_LEVELS = ["normal", "elevated", "high", "critical"];
const THREAT_COLOR = {
  normal: "bg-[rgba(52,211,153,.10)] text-nb-good",
  elevated: "bg-[rgba(96,165,250,.10)] text-nb-blueb",
  high: "bg-[rgba(251,191,36,.10)] text-nb-warn",
  critical: "bg-[rgba(248,113,113,.10)] text-nb-crit",
};

export default function ThreatLevelsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wf-threat-levels"], queryFn: () => wfApi.threatLevels.list() });
  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }) });
  const levels = asItems(q.data);
  const sites = asItems(sitesQ.data);
  const siteName = (sid) => sites.find((s) => s.site_id === sid)?.name || sid || "Deployment-wide";

  const [siteId, setSiteId] = useState("");
  const [level, setLevel] = useState("normal");
  const [reason, setReason] = useState("");

  const set = useMutation({
    mutationFn: (body) => wfApi.threatLevels.set(body),
    onSuccess: () => { toast.success("Threat level set"); qc.invalidateQueries({ queryKey: ["wf-threat-levels"] }); setReason(""); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    set.mutate({ site_id: siteId || null, level, reason: reason.trim() || null });
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[22rem_1fr]">
      <form onSubmit={submit} className="rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] p-5 space-y-4 h-fit">
        <h3 className="text-sm font-semibold text-nb-ink">Set threat level</h3>
        <Field
          as="select"
          label="Scope"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          options={[{ value: "", label: "Deployment-wide" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
        />
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-nb-faint">Level</label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {THREAT_LEVELS.map((lv) => (
              <button key={lv} type="button" onClick={() => setLevel(lv)} className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition ${level === lv ? `${THREAT_COLOR[lv]} border-transparent` : "border-nb-line text-nb-faint hover:bg-[rgba(96,165,250,.06)]"}`}>{lv}</button>
            ))}
          </div>
        </div>
        <Field
          as="textarea"
          rows={2}
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional context for the change"
        />
        <button type="submit" disabled={set.isPending} className="w-full inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 py-2 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)] disabled:opacity-50">{set.isPending ? "Setting…" : "Set threat level"}</button>
      </form>

      <div className="flex min-h-0 flex-col rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] overflow-hidden">
        <header className="shrink-0 px-5 py-4 border-b border-nb-line">
          <h3 className="text-sm font-semibold text-nb-ink">Current posture</h3>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-themed">
        {q.isLoading ? (
          <div className="px-5 py-8 flex items-center gap-2 text-sm text-nb-faint"><Spinner className="!h-4 !w-4" /> Loading…</div>
        ) : levels.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-nb-faint">No threat levels set. Everything is at normal posture.</div>
        ) : (
          <ul className="divide-y divide-nb-line">
            {levels.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3">
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${THREAT_COLOR[r.level] || "bg-[rgba(10,18,40,.65)] text-nb-faint"}`}>{r.level}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-nb-ink">{siteName(r.site_id)}</span>
                  {r.reason && <span className="block text-[11px] text-nb-soft">{r.reason}</span>}
                  <span className="block text-[11px] text-nb-faint/70">{r.set_by ? `by ${r.set_by} · ` : ""}{r.set_at ? new Date(r.set_at).toLocaleString() : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>
    </div>
  );
}
