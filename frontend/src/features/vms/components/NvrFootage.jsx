"use client";

// NvrFootage — browse & play recorded footage stored on an onboarded 3rd-party
// NVR (not our pooled storage). Pick an NVR + channel + date range → search the
// NVR's own storage (nvrFootage.recordings) → a list of ranges → click a range
// → open a PlaybackPlayer driven by nvrFootage.playback (returns an HLS session
// like ours). This is the unified-timeline differentiator (P4-B).
//
// The NVR may be unreachable / the driver may not implement search — every path
// degrades to a graceful empty/error state, never a crash.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtDateTime, fmtDuration } from "@/lib/format";
import { vms } from "../api";
import PlaybackPlayer from "./PlaybackPlayer";

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function NvrFootage() {
  const [nvrId, setNvrId] = useState("");
  const [channel, setChannel] = useState("");
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [active, setActive] = useState(null); // { from, to } being played

  // ── NVRs ────────────────────────────────────────────────────────────────
  const nvrsQ = useQuery({
    queryKey: ["vms-nvrs", "footage-picker"],
    queryFn: () => vms.nvrs.list({ limit: 200 }),
    staleTime: 60_000,
  });
  const nvrs = useMemo(() => asItems(nvrsQ.data), [nvrsQ.data]);
  const nvrNames = useMemo(() => {
    const m = {};
    for (const n of nvrs) m[n.id] = n.name;
    return m;
  }, [nvrs]);

  // ── Channels for the chosen NVR ───────────────────────────────────────────
  const channelsQ = useQuery({
    queryKey: ["vms-nvr-channels", nvrId],
    queryFn: () => vms.nvrs.channels(nvrId),
    enabled: !!nvrId,
  });
  const channels = useMemo(() => asItems(channelsQ.data), [channelsQ.data]);

  const range = useMemo(() => {
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : null;
    const to = toDate ? new Date(`${toDate}T23:59:59`).toISOString() : null;
    return { from, to };
  }, [fromDate, toDate]);

  // ── Recording search on the NVR's own storage ─────────────────────────────
  const searchQ = useQuery({
    queryKey: ["vms-nvr-footage", nvrId, channel, range.from, range.to],
    queryFn: () => vms.nvrFootage.recordings(nvrId, channel, range),
    enabled: !!nvrId && channel !== "",
    retry: false,
  });
  const results = useMemo(() => asItems(searchQ.data), [searchQ.data]);

  const nvrOptions = [
    { value: "", label: nvrs.length ? "Select NVR…" : "No NVRs onboarded" },
    ...nvrs.map((n) => ({ value: n.id, label: n.name })),
  ];
  const channelOptions = [
    { value: "", label: channelsQ.isLoading ? "Loading channels…" : "Select channel…" },
    ...channels.map((c) => ({
      value: String(c.channel_number ?? c.channel ?? c.id),
      label: c.name || `Channel ${c.channel_number ?? c.channel ?? c.id}`,
    })),
  ];

  // Source functions for the PlaybackPlayer when playing an NVR range.
  const sourceFn = (win) => vms.nvrFootage.playback(nvrId, channel, win);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
        <div className="w-52">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">NVR</label>
          <Select
            value={nvrId}
            onChange={(e) => {
              setNvrId(e.target.value);
              setChannel("");
              setActive(null);
            }}
            options={nvrOptions}
            className="!h-9 !py-1.5"
          />
        </div>
        <div className="w-44">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Channel</label>
          <Select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setActive(null);
            }}
            options={channelOptions}
            disabled={!nvrId}
            className="!h-9 !py-1.5"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">From</label>
          <input
            type="date"
            value={fromDate}
            max={todayStr()}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">To</label>
          <input
            type="date"
            value={toDate}
            max={todayStr()}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
          />
        </div>
        <Button variant="secondary" icon="heroicons-outline:magnifying-glass" onClick={() => searchQ.refetch()} disabled={!nvrId || channel === ""}>
          Search
        </Button>
      </div>

      {/* Player (when a range is active) */}
      {active && (
        <PlaybackPlayer
          key={`${active.from}-${active.to}`}
          cameraId={`${nvrId}:${channel}`}
          cameraName={`${nvrNames[nvrId] || "NVR"} · Ch ${channel}`}
          sourceFn={sourceFn}
          timelineFn={() => ({ coverage: results.map((r) => ({ start: r.start, end: r.end })) })}
        />
      )}

      {/* Results */}
      {!nvrId || channel === "" ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-16 text-center text-muted">
          <Icon icon="heroicons:server-stack" className="mb-3 text-4xl opacity-50" />
          <p className="font-medium text-foreground">Pick an NVR and channel</p>
          <p className="mt-1 text-sm">Then search its on-device storage for recorded footage.</p>
        </div>
      ) : searchQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-16 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Searching the recorder…
        </div>
      ) : searchQ.isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
          {apiError(searchQ.error, "The recorder could not be searched (unreachable or unsupported).")}
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-card py-16 text-center text-muted">
          <Icon icon="heroicons-outline:film" className="mb-3 text-4xl opacity-50" />
          <p className="font-medium text-foreground">No footage found on the recorder</p>
          <p className="mt-1 text-sm">Adjust the channel or date range.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-card-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border text-left text-muted">
                <th className="px-4 py-3 font-medium">Start</th>
                <th className="px-4 py-3 font-medium">End</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 text-right font-medium">Play</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const dur =
                  r.duration ??
                  (r.start && r.end ? (new Date(r.end) - new Date(r.start)) / 1000 : null);
                const isActive = active && active.from === r.start;
                return (
                  <tr key={r.id || `${r.start}-${i}`} className="border-b border-card-border last:border-0 hover:bg-hover/50">
                    <td className="px-4 py-3 text-foreground">{fmtDateTime(r.start)}</td>
                    <td className="px-4 py-3 text-muted">{r.end ? fmtDateTime(r.end) : "—"}</td>
                    <td className="px-4 py-3 text-muted">{fmtDuration(dur)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Button
                          variant={isActive ? "primary" : "secondary"}
                          icon="heroicons-outline:play"
                          className="!px-3 !py-1.5 !text-xs"
                          onClick={() => setActive({ from: r.start, to: r.end })}
                        >
                          {isActive ? "Playing" : "Play"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
