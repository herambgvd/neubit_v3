"use client";

import { useQuery } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { api } from "@/lib/api";
import type { ChannelOut } from "../types";

import { CHANNEL_META } from "./constants";
import { ChannelCard } from "./components/ChannelCard";

export default function ChannelsPage() {
  const channels = useQuery({
    queryKey: ["messaging-channels"],
    queryFn: () => api.get<ChannelOut[]>("/messaging/channels").then((r) => r.data),
  });

  return (
    <div>
      {channels.isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {/* Only the channels this console KNOWS. The backend still reports a
              `webhook` channel — core carries the transport — but nothing in the
              product ever sends one, so offering to configure it would be
              offering a delivery that never happens. */}
          {(channels.data || [])
            .filter((c) => c.channel in CHANNEL_META)
            .map((c) => (
              <ChannelCard key={c.channel} channel={c} />
            ))}
        </div>
      )}
    </div>
  );
}
