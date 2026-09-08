"use client";

// One enrolled recorder, as the federation sees it.
//
// The pane used to answer "is it up and how many cameras does it have". Four
// things an operator needs before they can trust or debug a federation link were
// missing, and each has a failure that is otherwise invisible:
//
//   TRUST      — a per-node credential freezes the grants it was minted with, so
//                widening the recorder's grant set leaves an existing credential
//                short. The node stays reachable and reports ONLINE the whole
//                time; the only symptom is one screen returning an error. The
//                heartbeat records the reason (`credential_error`) — this reads it.
//   ENDPOINTS  — a node can answer its API and still play nothing, because a
//                media base was never filled in at onboarding. That showed up as
//                a black tile on the wall and nowhere else.
//   STORAGE    — the recorder owns the disks. Its usage and RAID health are the
//                first question when recordings stop appearing, and they were
//                readable through the federation API but shown on no screen.
//   APPLIANCES — the third-party NVRs a recorder onboarded are cameras to us, so
//                the estate never said which box they actually come from.
//
// Read-only, like the rest of this console: lifecycle and endpoint edits live on
// the Recorders page.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { InfoCell, QuietButton } from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import type { FederatedCamera } from "@/lib/types";
import { vms } from "../api";
import type { FederationNode } from "../types";
import StatusBadge, { StatusDot } from "./StatusBadge";

export interface FederationNodeDetailProps {
  node: FederationNode;
  cameras: FederatedCamera[];
  camsLoading: boolean;
  unreachable: boolean;
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center justify-between gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{children}</p>
      {right}
    </div>
  );
}

/** Bytes as an operator reads them. Undefined stays undefined — a missing figure
 *  must not render as "0 B", which is a claim about the disk. */
function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function meterColor(pct: number): string {
  if (pct >= 90) return "#f87171";
  if (pct >= 75) return "#fbbf24";
  return "#60a5fa";
}

function Meter({ percent, label }: { percent: number; label: string }) {
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  const color = meterColor(p);
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-white/[.08]"
      role="progressbar"
      aria-label={label}
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

export default function FederationNodeDetail({
  node,
  cameras,
  camsLoading,
  unreachable,
}: FederationNodeDetailProps) {
  const cap = node.capacity_channels;
  const used = node.used_channels ?? cameras.length;
  const online = cameras.filter((c) => c.status === "online").length;
  const capPct = cap ? (used / cap) * 100 : 0;

  // Read THROUGH the node, so only for the node on screen and only while it is
  // answering: polling storage on an unreachable recorder buys a timeout per tick.
  const storageQ = useQuery({
    queryKey: ["fed-node-storage", node.id],
    queryFn: () => vms.federation.storage.usage(node.id),
    enabled: !unreachable,
    retry: false,
    staleTime: 30_000,
  });
  const raidQ = useQuery({
    queryKey: ["fed-node-raid", node.id],
    queryFn: () => vms.federation.storage.raid(node.id),
    enabled: !unreachable,
    retry: false,
    staleTime: 30_000,
  });
  const nvrsQ = useQuery({
    queryKey: ["fed-node-nvrs", node.id],
    queryFn: () => vms.federation.nvrs(node.id),
    enabled: !unreachable,
    retry: false,
    staleTime: 30_000,
  });

  const usage = storageQ.data;
  const usedPct =
    typeof usage?.used_percent === "number"
      ? usage.used_percent
      : usage?.total_bytes && usage?.used_bytes
        ? (usage.used_bytes / usage.total_bytes) * 100
        : null;
  const arrays = raidQ.data?.arrays || [];
  const nvrs = nvrsQ.data?.items || [];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nb-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-nb-blue/40 bg-[rgba(96,165,250,.12)] text-nb-blueb">
            <Icon icon="heroicons-outline:share" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-nb-ink">{node.name}</h1>
            <p className="truncate font-mono text-[11px] text-nb-faint">{node.api_url || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <QuietButton
            as={Link}
            href="/devices/recorders"
            icon="heroicons-outline:cog-6-tooth"
            className="!py-1.5 !text-xs"
          >
            Manage
          </QuietButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {unreachable && (
          <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-nb-crit/40 bg-nb-crit/10 px-3 py-2 text-[12px] text-nb-crit">
            <Icon icon="heroicons:exclamation-triangle" className="shrink-0 text-sm" />
            This node is not reachable right now — its federated cameras can&apos;t be listed or
            streamed until it comes back online.
          </div>
        )}

        {node.credential_error && (
          // The node is UP. Without this line the estate says "online" while a
          // screen somewhere returns an error, and nobody connects the two.
          <div className="mb-3 rounded-[10px] border border-nb-warn/40 bg-nb-warn/10 px-3 py-2 text-[12px] text-nb-warn">
            <div className="flex items-center gap-2 font-medium">
              <Icon icon="heroicons:key" className="shrink-0 text-sm" />
              This node&apos;s federation credential is being refused
            </div>
            <p className="mt-1 break-words font-mono text-[11px] text-nb-warn/90">
              {node.credential_error}
            </p>
            <p className="mt-1 text-[11px] text-nb-soft">
              A credential freezes the grants it was minted with. Re-enrol the recorder on the
              Recorders page to mint one with the current grant set.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={node.status || "unknown"} />
          <InfoCell
            label="Last heartbeat"
            value={node.last_heartbeat ? fmtRelative(node.last_heartbeat) : "never"}
            title={node.last_heartbeat || undefined}
          />
          <InfoCell label="Location / label" value={node.label || "—"} />
          <InfoCell
            label="Enrolled"
            value={node.enrolled_at ? fmtRelative(node.enrolled_at) : "—"}
            title={node.enrolled_at || undefined}
          />
        </div>

        <SectionLabel
          right={
            <span className="font-mono text-[10px] tabular-nums text-nb-soft">
              {used} / {cap != null ? cap : "∞"}
            </span>
          }
        >
          Channel capacity
        </SectionLabel>
        {cap ? (
          <Meter percent={capPct} label="Channel capacity" />
        ) : (
          <p className="text-[11px] text-nb-faint">No channel cap declared for this recorder.</p>
        )}

        <SectionLabel>Trust</SectionLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell
            label="Credential"
            value={
              node.has_credential ? (
                <span className={node.credential_error ? "text-nb-warn" : "text-nb-good"}>
                  {node.credential_error ? "Scoped — refused" : "Scoped to this node"}
                </span>
              ) : (
                // Not a fault: the ambient service JWT still works. It is the
                // difference between access we can revoke on its own and access
                // we cannot.
                <span className="text-nb-soft">Shared service token</span>
              )
            }
          />
        </div>

        {/* NO endpoint list. The URLs are the Recorders page's business — this
            console does not edit them, and four rows of internal hostnames is
            not information anyone acts on here. What IS actionable is the one
            state they can be in that makes an online node useless. */}
        {!node.hls_base && !node.webrtc_base && (
          <p className="mt-3 flex items-start gap-1.5 rounded-[10px] border border-nb-warn/40 bg-nb-warn/10 px-3 py-2 text-[11.5px] text-nb-warn">
            <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 shrink-0 text-xs" />
            <span>
              No playable media base. This node answers its API, so it reports online — but a
              tile opened on its cameras has nowhere to stream from. Set HLS or WebRTC on the{" "}
              <Link href="/devices/recorders" className="underline decoration-dotted underline-offset-2">
                Recorders
              </Link>{" "}
              page.
            </span>
          </p>
        )}

        <SectionLabel
          right={
            usedPct != null ? (
              <span className="font-mono text-[10px] tabular-nums text-nb-soft">
                {fmtBytes(usage?.used_bytes)} / {fmtBytes(usage?.total_bytes)}
              </span>
            ) : undefined
          }
        >
          Recorder storage
        </SectionLabel>
        {unreachable ? (
          <p className="text-[11px] text-nb-faint">Unavailable while the node is unreachable.</p>
        ) : storageQ.isLoading ? (
          <p className="text-[11px] text-nb-faint">Reading…</p>
        ) : storageQ.isError ? (
          <p className="text-[11px] text-nb-warn">
            {apiError(storageQ.error, "The node did not answer for storage")}
          </p>
        ) : usedPct == null ? (
          <p className="text-[11px] text-nb-faint">This recorder reports no disk usage.</p>
        ) : (
          <>
            <Meter percent={usedPct} label="Recorder disk usage" />
            <p className="mt-1 font-mono text-[10.5px] text-nb-faint">
              {Math.round(usedPct)}% used · {fmtBytes(usage?.free_bytes)} free
            </p>
          </>
        )}

        {!unreachable && raidQ.data?.available && arrays.length > 0 && (
          <ul className="mt-2 space-y-1">
            {arrays.map((a, i) => {
              const healthy = (a.health || "").toLowerCase() === "healthy" || a.health === "clean";
              return (
                <li
                  key={a.device || i}
                  className="flex items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5 text-[12px]"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthy ? "bg-nb-good" : "bg-nb-crit"}`}
                  />
                  <span className="font-mono text-nb-ink">{a.device || "array"}</span>
                  {a.level && <span className="text-nb-faint">{a.level}</span>}
                  <span className={`ml-auto ${healthy ? "text-nb-soft" : "text-nb-crit"}`}>
                    {a.health || "unknown"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <SectionLabel
          right={
            <span className="rounded-full border border-nb-line bg-white/5 px-2 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
              {online}/{cameras.length} online
            </span>
          }
        >
          Federated cameras
        </SectionLabel>
        {camsLoading ? (
          <p className="flex items-center gap-1.5 px-1 py-3 text-xs text-nb-faint">
            <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" />
            Loading…
          </p>
        ) : cameras.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs text-nb-faint">
            {unreachable
              ? "Cameras are unavailable while this node is unreachable."
              : "This node exposes no federated cameras."}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {cameras.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5"
              >
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-nb-ink" title={c.name}>
                  {c.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.5px] text-nb-faint">
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        {!unreachable && nvrs.length > 0 && (
          <>
            <SectionLabel>
              Third-party appliances
            </SectionLabel>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {nvrs.map((n) => (
                <li
                  key={n.id}
                  className="flex items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5"
                >
                  <StatusDot status={String(n.status || "unknown")} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-nb-ink">
                    {n.name || n.id}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-nb-faint">{n.host || ""}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-nb-faint">
              Onboarded by this recorder, which holds their credentials. Their channels arrive
              above as ordinary federated cameras.
            </p>
          </>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-nb-faint">
          <Icon icon="heroicons:play-circle" className="text-sm text-nb-blueb" />
          Federated cameras stream through their node — view them live on the
          <Link
            href="/streaming"
            className="text-nb-blueb underline decoration-dotted underline-offset-2 hover:text-nb-ink"
          >
            Live wall
          </Link>
          .
        </p>
      </div>
    </>
  );
}
