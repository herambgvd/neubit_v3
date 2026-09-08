"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { api } from "@/lib/api";
import type { ChannelOut } from "../types";

import { CHANNEL_META } from "./constants";
import { ChannelCard } from "./components/ChannelCard";

/**
 * `children` renders as the last card of the flow.
 *
 * A COLUMN FLOW, not a grid. In a grid every card in a row is as tall as the
 * tallest one, so three cards of very different heights — SMTP is medium, FCM is
 * one field, Appearance is half again as tall as either — left a band of dead
 * space under the two short ones. `columns` lets the browser balance them
 * instead: the short cards stack in one column while the tall one runs down the
 * other, and the bottom edge comes out roughly level.
 *
 * `break-inside-avoid` on each card is what keeps a card whole; without it the
 * browser will split one across the column boundary mid-field.
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
        <div className="columns-1 gap-3 lg:columns-2 [&>*]:mb-3 [&>*]:break-inside-avoid">
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
