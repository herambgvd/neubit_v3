"use client";

import { useQuery } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { api } from "@/lib/api";

import { ChannelCard } from "./components/ChannelCard";

export default function ChannelsPage() {
  const channels = useQuery({
    queryKey: ["messaging-channels"],
    queryFn: () => api.get("/messaging/channels").then((r) => r.data),
  });

  return (
    <div>
      {channels.isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {(channels.data || []).map((c) => (
            <ChannelCard key={c.channel} channel={c} />
          ))}
        </div>
      )}
    </div>
  );
}
