"use client";

// Live log tail for one service.
//
// FOLLOWING IS A POLL, and it says so: the ops-agent reads `docker logs`, which
// this asks for every 3 seconds with a `since` of the newest line it already
// holds — so a follow costs the new lines, not the whole tail. Lines accumulate
// in a ref rather than being replaced, or the pane would flicker back to a
// window every tick and lose everything scrolled past.
//
// Pause stops the polling. That is the difference between reading a stack trace
// and chasing it up the screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { IconButton } from "@/components/console";
import { Input } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import type { ServiceLogsOut, ServiceOut } from "../../types";
import { lineTone, sinceOf, splitLine } from "../serviceFormat";

/** How many lines the pane keeps. Beyond this the oldest are dropped. */
const MAX_LINES = 2000;
const POLL_MS = 3000;

export interface ServiceLogsProps {
  service: ServiceOut;
  /** False when the caller lacks `system.logs`. */
  allowed: boolean;
}

export default function ServiceLogs({ service, allowed }: ServiceLogsProps) {
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState("");
  const linesRef = useRef<string[]>([]);
  const sinceRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Reset when the pane switches service. The parent keys this component on the
  // container, so this runs on mount — but the refs outlive a re-render, and one
  // service's log body must never appear under another's name.
  const reset = useCallback(() => {
    linesRef.current = [];
    sinceRef.current = 0;
  }, []);

  const logs = useQuery({
    queryKey: ["service-logs", service.container],
    queryFn: async () => {
      const { data } = await api.get<ServiceLogsOut>(
        `/system/services/${encodeURIComponent(service.container)}/logs`,
        { params: { tail: 400, since: sinceRef.current } },
      );
      const incoming = data.lines || [];
      if (incoming.length) {
        // The `since` overlap re-delivers the last second, so drop what is
        // already held rather than printing it twice.
        const held = new Set(linesRef.current.slice(-400));
        const fresh = incoming.filter((l) => !held.has(l));
        const next = [...linesRef.current, ...fresh];
        linesRef.current = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        sinceRef.current = sinceOf(linesRef.current) || sinceRef.current;
      }
      return linesRef.current;
    },
    enabled: allowed,
    refetchInterval: following ? POLL_MS : false,
    // A poll is a refresh of a live view, not a fresh load: keeping the previous
    // data stops the pane blanking every three seconds.
    placeholderData: (prev) => prev,
  });

  useEffect(() => reset, [reset, service.container]);

  const lines = useMemo(() => logs.data || [], [logs.data]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
  }, [lines, filter]);

  // Stick to the bottom while following. Reading the scroll position first, so a
  // scrolled-up reader is not yanked back down by the next tick.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [shown, following]);

  if (!allowed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Icon icon="heroicons-outline:lock-closed" className="text-2xl text-nb-faint" />
        <p className="text-sm text-nb-muted">Logs need the “Read service logs” permission.</p>
        <p className="max-w-sm text-[11.5px] text-nb-faint">
          Service status is visible to anyone who can open this page; what a service prints
          is a separate grant, because a log line carries request paths and identifiers.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-nb-line px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter lines…"
          aria-label="Filter log lines"
          className="!h-8 !py-1 text-xs"
          wrapperClassName="flex-1"
        />
        <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">
          {shown.length}
          {filter && ` / ${lines.length}`}
        </span>
        <IconButton
          icon={following ? "heroicons:pause" : "heroicons:play"}
          title={following ? "Pause following" : "Follow"}
          onClick={() => setFollowing((f) => !f)}
        />
      </div>

      <div
        ref={bodyRef}
        role="log"
        aria-label={`${service.name} logs`}
        className="min-h-0 flex-1 overflow-auto bg-[rgba(4,9,22,.6)] px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
      >
        {logs.isError ? (
          <p className="py-6 text-center text-xs text-nb-crit">
            {apiError(logs.error, "Couldn't read the logs")}
          </p>
        ) : logs.isLoading ? (
          <p className="py-6 text-center text-xs text-nb-faint">Reading…</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-nb-faint">
            {filter ? "No line matches that filter." : "This service has printed nothing."}
          </p>
        ) : (
          shown.map((line, i) => {
            const { ts, text } = splitLine(line);
            return (
              <div key={`${i}-${line.slice(0, 24)}`} className="flex gap-2 whitespace-pre-wrap break-all">
                {ts && (
                  <span className="shrink-0 text-nb-faint">
                    {ts.slice(11, 19)}
                  </span>
                )}
                <span className={lineTone(text)}>{text}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
