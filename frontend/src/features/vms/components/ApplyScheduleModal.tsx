"use client";

// APPLY A SCHEDULE TO CAMERAS — a fan-out, and the honest reporting of one.
//
// Three things this dialog refuses to let you assume:
//
//   * THAT IT IS ALL-OR-NOTHING. The recorder answers per camera (applied |
//     skipped | failed) and those counts are the only record of a write nobody
//     watched. One camera the credential may not touch must not cost the other
//     thirty-nine, and the result has to say which was which.
//   * THAT A SCHEDULE MEANS FOOTAGE. A camera in `manual` mode holds its week and
//     ignores it. So the cameras that will not act on this are named BEFORE the
//     apply, not discovered later from an empty timeline — a green "applied"
//     against a camera that records nothing is the most expensive kind of true.
//   * THAT IT KEEPS UP. Applying COPIES the document. Editing the template
//     afterwards does not reach back into these cameras.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import type { FederatedCamera } from "@/lib/types";
import { vms } from "../api";
import type { ScheduleApplyResult, ScheduleTemplate } from "../types";

export interface ApplyScheduleModalProps {
  nodeId: string;
  template: ScheduleTemplate;
  onClose?: () => void;
}

/** A camera whose schedule will sit unused. Not an error and not hidden: the
 *  operator is entitled to know before they press the button, and to press it
 *  anyway — setting the week ahead of switching the mode is a normal order to work
 *  in. */
export function ignoresSchedule(cam: FederatedCamera): boolean {
  const mode = String(cam.recording?.mode ?? "").toLowerCase();
  // Only `schedule` acts on the week. Empty is the recorder not having said, and
  // guessing either way would be this console inventing the camera's behaviour.
  return !!mode && mode !== "schedule";
}

export default function ApplyScheduleModal({ nodeId, template, onClose }: ApplyScheduleModalProps) {
  // Mounted when it opens, so every run starts empty without an effect saying so.
  // A previous run's counts standing over a new selection is how somebody reads
  // last time's result as this time's.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<ScheduleApplyResult | null>(null);

  const camsQ = useQuery({
    queryKey: ["federation-cameras"],
    queryFn: () => vms.federation.cameras(),
  });

  // This recorder's channels only. Applying is a node-scoped call, and offering
  // another recorder's cameras would produce a page of "failed" rows.
  const cameras = useMemo<FederatedCamera[]>(
    () => (camsQ.data?.items ?? []).filter((c) => c.node_id === nodeId),
    [camsQ.data, nodeId],
  );

  const apply = useMutation({
    mutationFn: () => vms.federation.schedules.apply(nodeId, template.id, [...picked]),
    onSuccess: (r) => {
      setResult(r);
      if (r.failed) toast.warning(`${r.applied} applied, ${r.failed} failed`);
      else toast.success(`Applied to ${r.applied} ${r.applied === 1 ? "camera" : "cameras"}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const idle = cameras.filter((c) => picked.has(c.id) && ignoresSchedule(c));
  const outcome = new Map((result?.results ?? []).map((r) => [r.camera_id, r]));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Apply “${template.name}”`}
      subtitle="The week is copied onto each camera. Editing the schedule later will not change them."
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!picked.size || apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending
                ? "Applying…"
                : `Apply to ${picked.size || "no"} ${picked.size === 1 ? "camera" : "cameras"}`}
            </Button>
          </>
        )
      }
    >
      {camsQ.isLoading ? (
        <p className="py-6 text-center text-[12.5px] text-nb-faint">Loading cameras…</p>
      ) : !cameras.length ? (
        <p className="py-6 text-center text-[12.5px] text-nb-faint">
          This recorder has no cameras to schedule.
        </p>
      ) : (
        <div className="space-y-1">
          {cameras.map((c) => {
            const out = outcome.get(c.id);
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 hover:bg-nb-hover"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-nb-blue"
                  checked={picked.has(c.id)}
                  disabled={!!result}
                  onChange={() => toggle(c.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-nb-text">{c.name}</span>
                  {ignoresSchedule(c) && (
                    <span className="block text-[11px] text-amber-300/90">
                      in {c.recording?.mode} mode — it will hold this week without acting on it
                    </span>
                  )}
                </span>
                {out && (
                  <span
                    className={`shrink-0 text-[11.5px] ${
                      out.status === "applied"
                        ? "text-emerald-400"
                        : out.status === "skipped"
                          ? "text-nb-faint"
                          : "text-nb-crit"
                    }`}
                    title={out.reason}
                  >
                    {out.status}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {!result && idle.length > 0 && (
        <p className="mt-3 rounded-[9px] border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[11.5px] text-amber-200">
          <Icon icon="heroicons:exclamation-triangle" className="mr-1 inline text-xs" />
          {idle.length} of the selected {idle.length === 1 ? "camera is" : "cameras are"} not in
          schedule mode. The week will be set and will not run until the mode changes on the
          recorder.
        </p>
      )}

      {result && (
        <p className="mt-3 rounded-[9px] border border-nb-line px-3 py-2 text-[12px] text-nb-soft">
          {result.applied} applied · {result.skipped} skipped · {result.failed} failed of{" "}
          {result.requested} requested.
          {result.skipped > 0 && " A skipped camera is one this login may not reach."}
        </p>
      )}
    </Modal>
  );
}
