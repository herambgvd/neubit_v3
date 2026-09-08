"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { api } from "@/lib/api";
import type { ChannelOut } from "../types";

import { CHANNEL_META } from "./constants";
import { ChannelCard } from "./components/ChannelCard";

/**
 * `children` renders as the LAST cell of the channel grid.
 *
 * Two channels in a three-column grid left a dead third of the row, with the next
 * card stranded full-width underneath it. A card that belongs beside the channels
 * goes in the grid rather than under it — see Config, which puts Appearance there.
 */
export default function ChannelsPage({ children }: { children?: ReactNode }) {
  const channels = useQuery({
    queryKey: ["messaging-channels"],
    queryFn: () => api.get<ChannelOut[]>("/messaging/channels").then((r) => r.data),
  });

  return (
    <div>
      {channels.isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {/* Only the channels this console KNOWS. The backend still reports a
              `webhook` channel — core carries the transport — but nothing in the
              product ever sends one, so offering to configure it would be
              offering a delivery that never happens. */}
          {(channels.data || [])
            .filter((c) => c.channel in CHANNEL_META)
            .map((c) => (
              <ChannelCard key={c.channel} channel={c} />
            ))}
          {children}
        </div>
      )}
    </div>
  );
}
