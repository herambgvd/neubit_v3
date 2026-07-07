"use client";

import { useQuery } from "@tanstack/react-query";

import { PageHeader, Spinner } from "@/components/ui/kit";
import { api } from "@/lib/api";

import { ChannelCard } from "./components/ChannelCard";

export default function ChannelsPage() {
  const channels = useQuery({
    queryKey: ["messaging-channels"],
    queryFn: () => api.get("/messaging/channels").then((r) => r.data),
  });

  return (
    <div>
      <PageHeader
        title="Channels"
        subtitle="Configure how Neubit delivers notifications — email, push, and webhooks."
      />
      {channels.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {(channels.data || []).map((c) => (
            <ChannelCard key={c.channel} channel={c} />
          ))}
        </div>
      )}
    </div>
  );
}
