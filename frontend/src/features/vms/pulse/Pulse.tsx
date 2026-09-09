"use client";

// SURVEILLANCE → PULSE. The estate's operational health.
//
// The tile used to open the platform's container list — Docker services and their
// logs. That is a platform-admin surface, it is already reachable under
// Configurations → Platform → Health, and it answers a question nobody watching a
// video wall is asking. Theirs are: which cameras are down and where, is footage
// actually being written, how much headroom is left, and what needs me first.
//
// Every one of those is measured by the OWNING RECORDER, so this screen is a
// fan-out and a roll-up (vision's `app/vms/pulse`), never a second measurement.
//
// The page carries NO heading of its own: Pulse names itself in the top bar
// beside the brand, the way Live and Devices do (HeaderSectionNav), so the
// screen starts on the figures instead of on a title and a paragraph explaining
// itself. What the surface is for belongs in this comment and in the launcher
// tile, not in a banner the operator reads once and then scrolls past forever.
//
// Shape: the five figures, then attention on the left and the drill-down on the
// right — a recorder's own board, or one camera's fault chain, which is where an
// operator finds out whether the fault is the camera, the network or the
// recorder. Nothing on this page turns "we did not measure it" into a number;
// `pulse/format.ts` holds that discipline and is tested on it.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  IconButton,
  LoadingBlock,
  PanelHeader,
  PanelList,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";

import { vms } from "../api";
import type { PulseAttentionItem } from "../types";
import AttentionRow from "./AttentionRow";
import IsolationPane from "./IsolationPane";
import PulseStats from "./PulseStats";
import RecorderBoard from "./RecorderBoard";

const PERM_READ = "vms.camera.read";

/** What the right pane is showing. A camera selection carries its recorder,
 *  because the fault trace is answered BY the recorder that owns the camera. */
type Focus =
  | { kind: "node"; nodeId: string; label: string }
  | { kind: "camera"; nodeId: string; cameraId: string; label: string }
  | null;

export default function Pulse() {
  const { can } = useAuth();
  const [focus, setFocus] = useState<Focus>(null);

  const overviewQ = useQuery({
    queryKey: ["pulse", "overview"],
    queryFn: () => vms.pulse.overview(),
    enabled: can(PERM_READ),
    // Often enough to be live on a wall, rarely enough that each refresh does not
    // make every recorder re-probe its disks: the fan-out is one sysmon call per
    // recorder and each of those is real work on the box.
    refetchInterval: 20_000,
  });

  const data = overviewQ.data;

  // The right pane's own fetches. Both are keyed by what is focused and disabled
  // otherwise, so opening Pulse costs exactly one call.
  const boardQ = useQuery({
    queryKey: ["pulse", "sysmon", focus?.kind === "node" ? focus.nodeId : null],
    queryFn: () => vms.pulse.nodeSysmon((focus as { nodeId: string }).nodeId),
    enabled: focus?.kind === "node",
    refetchInterval: 20_000,
  });

  const traceQ = useQuery({
    queryKey: [
      "pulse",
      "isolate",
      focus?.kind === "camera" ? focus.nodeId : null,
      focus?.kind === "camera" ? focus.cameraId : null,
    ],
    queryFn: () =>
      vms.pulse.isolate((focus as { nodeId: string }).nodeId, (focus as { cameraId: string }).cameraId),
    enabled: focus?.kind === "camera",
    // Not polled: a trace is a point-in-time diagnosis an operator asked for, and
    // re-running it every few seconds re-probes the camera for nobody.
    refetchInterval: false,
  });

  const attention: PulseAttentionItem[] = useMemo(() => data?.attention ?? [], [data]);

  const openItem = (item: PulseAttentionItem) => {
    if (item.camera_id && item.node_id) {
      setFocus({ kind: "camera", nodeId: item.node_id, cameraId: item.camera_id, label: item.item });
    } else if (item.node_id) {
      setFocus({ kind: "node", nodeId: item.node_id, label: item.where || item.item });
    } else {
      // A volume warning names a recorder but carries no id; find it by name so
      // the row still leads somewhere.
      const node = data?.nodes.find((n) => n.node_name === item.where);
      if (node) setFocus({ kind: "node", nodeId: node.node_id, label: node.node_name });
    }
  };

  const canOpen = (item: PulseAttentionItem) =>
    Boolean(item.node_id || data?.nodes.some((n) => n.node_name === item.where));

  if (!can(PERM_READ)) {
    return (
      <ConsolePage>
        <EmptyPane
          icon="heroicons:lock-closed"
          title="No estate access"
          subtitle="Reading the estate's health needs the `vms.camera.read` permission — this account does not hold it."
        />
      </ConsolePage>
    );
  }

  if (overviewQ.isLoading) {
    return (
      <ConsolePage>
        <LoadingBlock label="Asking the recorders…" />
      </ConsolePage>
    );
  }

  if (overviewQ.error || !data) {
    // A failed read must never render as a healthy estate: an empty board and a
    // green board look identical to someone glancing at a wall.
    return (
      <ConsolePage>
        <EmptyPane
          icon="heroicons:exclamation-triangle"
          title="Could not read the estate"
          subtitle={apiError(overviewQ.error, "The vision service did not answer.")}
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      {/* Freshness rides WITH the figures rather than in a title bar: every number
          below is a reading with an age, and "updated 2m ago" is the difference
          between a healthy estate and a stale page about one. */}
      <PulseStats
        data={data}
        right={
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[10.5px] text-nb-faint">
              {overviewQ.isFetching ? "refreshing…" : `updated ${fmtRelative(data.generated_at)}`}
            </span>
            <IconButton
              icon="heroicons:arrow-path"
              title="Refresh now"
              onClick={() => {
                overviewQ.refetch();
                if (focus?.kind === "node") boardQ.refetch();
                if (focus?.kind === "camera") traceQ.refetch();
              }}
            />
          </div>
        }
      />

      <ConsoleGrid>
        {/* LEFT — what needs an operator, worst first (ranked by the service) */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons:exclamation-triangle"
            title="Needs attention"
            count={attention.length}
          />
          <PanelList
            empty={attention.length === 0}
            emptyText="Nothing needs attention — every recorder that answered reports healthy."
          >
            {attention.map((item, i) => (
              <AttentionRow
                key={`${item.kind}-${item.item}-${i}`}
                item={item}
                selected={
                  (focus?.kind === "camera" && focus.cameraId === item.camera_id) ||
                  (focus?.kind === "node" && focus.nodeId === item.node_id)
                }
                onSelect={canOpen(item) ? () => openItem(item) : undefined}
              />
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — the recorders, or the one thing being looked at */}
        <ConsolePanel>
          {focus === null ? (
            <>
              <PanelHeader
                icon="heroicons-outline:server-stack"
                title="Recorders"
                count={data.totals.recorders}
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                <div className="grid gap-2 md:grid-cols-2">
                  {data.nodes.map((n) => (
                    <button
                      key={n.node_id}
                      onClick={() => setFocus({ kind: "node", nodeId: n.node_id, label: n.node_name })}
                      className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-left transition hover:border-[rgba(150,180,245,.42)]"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            n.verdict.level === "down"
                              ? "bg-nb-crit"
                              : n.verdict.level === "degraded"
                                ? "bg-nb-warn"
                                : "bg-nb-good"
                          }`}
                        />
                        <span className="truncate text-[12.5px] font-semibold text-nb-ink">
                          {n.node_name}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-nb-muted">
                        {n.verdict.headline || "no verdict reported"}
                      </p>
                      <p className="mt-0.5 font-mono text-[10.5px] text-nb-faint">
                        {n.cameras.online}/{n.cameras.total} cameras · {n.cameras.recording_active}{" "}
                        recording
                      </p>
                    </button>
                  ))}
                  {data.unreachable.map((n) => (
                    <div
                      key={n.node_id}
                      className="rounded-[10px] border border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)] px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <Icon icon="heroicons:signal-slash" className="text-[13px] text-nb-crit" />
                        <span className="truncate text-[12.5px] font-semibold text-nb-ink">{n.name}</span>
                      </div>
                      <p className="mt-1 break-words font-mono text-[10.5px] text-nb-faint">{n.error}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <PanelHeader
                icon={
                  focus.kind === "camera"
                    ? "heroicons-outline:video-camera"
                    : "heroicons-outline:server-stack"
                }
                title={focus.label}
                actions={
                  <IconButton
                    icon="heroicons-outline:x-mark"
                    title="Back to recorders"
                    onClick={() => setFocus(null)}
                  />
                }
              />
              {focus.kind === "node" ? (
                <RecorderBoard
                  board={boardQ.data}
                  loading={boardQ.isLoading}
                  error={boardQ.error ? apiError(boardQ.error, "The recorder did not answer") : undefined}
                  onIsolate={(cameraId) =>
                    setFocus({ kind: "camera", nodeId: focus.nodeId, cameraId, label: cameraId })
                  }
                />
              ) : (
                <IsolationPane
                  trace={traceQ.data}
                  loading={traceQ.isLoading}
                  error={traceQ.error ? apiError(traceQ.error, "The recorder did not answer") : undefined}
                  cameraName={focus.label}
                  onRetest={() => traceQ.refetch()}
                />
              )}
            </>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
