"use client";

// Wall picker (VW-D) — the /wall landing surface: a card grid of the tenant's
// shared video walls. Pick one to open its operator console. Read-gated on
// vms.wall.view; the "Manage walls" shortcut appears for vms.wall.manage.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { Button, EmptyState, PageHeader, Spinner } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { useAuth } from "@/lib/auth";

import { videowall } from "./api";

export default function WallList() {
  const { can } = useAuth();
  const canView = can("vms.wall.view");
  const canManage = can("vms.wall.manage");

  const wallsQ = useQuery({
    queryKey: ["walls"],
    queryFn: () => videowall.walls.list({ limit: 200 }),
    enabled: canView,
  });
  const walls = useMemo(() => asItems(wallsQ.data), [wallsQ.data]);

  if (!canView) {
    return (
      <EmptyState
        icon="heroicons-outline:lock-closed"
        title="No access"
        subtitle="You don't have permission to view video walls."
      />
    );
  }

  return (
    <div
      className="-mx-4 lg:-mx-5 -my-3 min-h-full px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <PageHeader
        title="Video walls"
        subtitle="Shared control-room display surfaces. Open a wall to drive its monitors."
        actions={
          canManage && (
            <Link href="/config/video-wall">
              <Button variant="secondary" icon="heroicons-outline:cog-6-tooth">
                Manage walls
              </Button>
            </Link>
          )
        }
      />

      {wallsQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-nb-soft">
          <Spinner /> Loading walls…
        </div>
      ) : walls.length === 0 ? (
        <EmptyState
          icon="heroicons-outline:computer-desktop"
          title="No video walls yet"
          subtitle={canManage ? "Create a wall in Wall management to get started." : "Ask an administrator to create a wall."}
          action={
            canManage && (
              <Link href="/config/video-wall">
                <Button variant="primary" icon="heroicons-mini:plus">
                  Create a wall
                </Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {walls.map((w) => (
            <Link
              key={w.id}
              href={`/wall/${w.id}`}
              className="group flex flex-col rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4 transition hover:border-[rgba(96,165,250,.5)] hover:bg-[rgba(96,165,250,.06)]"
            >
              <div className="mb-3 flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb">
                  <Icon icon="heroicons:computer-desktop" className="text-lg" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-nb-ink">{w.name}</span>
                    {!w.is_active && (
                      <span className="rounded-sm border border-nb-line bg-[rgba(10,18,40,.6)] px-1.5 py-0.5 text-[9px] font-medium text-nb-faint">inactive</span>
                    )}
                  </div>
                  {w.description && <p className="mt-0.5 truncate text-xs text-nb-soft">{w.description}</p>}
                </div>
                <Icon
                  icon="heroicons-outline:arrow-right"
                  className="shrink-0 text-nb-muted opacity-0 transition group-hover:opacity-100"
                />
              </div>
              <div className="mt-auto flex items-center gap-3 text-[11px] text-nb-faint">
                <span className="inline-flex items-center gap-1">
                  <Icon icon="heroicons-outline:squares-2x2" className="text-xs" />
                  {w.rows}×{w.cols} monitors
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
