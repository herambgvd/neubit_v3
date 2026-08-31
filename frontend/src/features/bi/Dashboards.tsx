"use client";

// Building Intelligence → DASHBOARDS. The VIEWING surface for what the builder
// builds.
//
// The builder lives in Configurations → Reporting & Dashboards, and that is the
// right home for AUTHORING — but nobody goes into Configurations to look at a
// dashboard every morning. This card is the daily door: a horizontal strip of
// dashboard names, click one, it opens right here. Nothing is authored on this
// screen; the strip is a menu, not a manager.
//
// Deliberately thin:
//   • The list is `dashboards.list()` — every dashboard this caller may read.
//     There is no "BI dashboards" subset because the platform stores no such
//     fact; inventing a filter would hide dashboards for no stated reason.
//   • The open dashboard is the REAL `DashboardView`, the same component the
//     Configurations route mounts — one viewer, one behaviour, same drill,
//     filters and permissions — including its own View/Edit/History controls,
//     which stay gated by `dashboards.manage` exactly as they are there. This
//     surface ADDS no authoring affordance of its own; whatever the viewer
//     already offers a caller is what they get.
//   • The selected id rides in `?d=` so a dashboard here is a shareable link,
//     and the first dashboard opens by default — a viewing surface that opens
//     onto a blank pane would just be the list page with extra steps.
//
// Permission shape (same composition DashboardList documents):
//   dashboards.read → this list and the definitions; bi.read → the widgets'
//   DATA. A caller with one but not the other sees exactly what that mix
//   honestly affords.
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsolePage,
  EmptyPane,
  EstateHeader,
  LoadingBlock,
} from "@/components/console";
import { useAuth } from "@/lib/auth";

import DashboardView from "@/features/dashboards/DashboardView";
import { dashboards } from "@/features/dashboards/api";
import {
  PERM_MANAGE as DASH_MANAGE,
  PERM_READ as DASH_READ,
} from "@/features/dashboards/constants";

const HEADER_DESC =
  "Every dashboard this account may read, built in Configurations → Reporting & Dashboards. " +
  "Pick a name to open it here — this surface views; the builder authors.";

function Strip({ items, activeId, onPick }: any) {
  return (
    <div className="mb-3 flex shrink-0 items-center gap-1.5 overflow-x-auto rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.7)] p-1.5">
      {items.map((d: any) => {
        const on = d.id === activeId;
        return (
          <button
            key={d.id}
            onClick={() => onPick(d.id)}
            className={`shrink-0 rounded-[7px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              on
                ? "bg-nb-accent/15 text-nb-accent"
                : "text-nb-faint hover:bg-[rgba(255,255,255,.04)] hover:text-nb-ink"
            }`}
            title={d.description || d.name}
          >
            {d.name}
          </button>
        );
      })}
    </div>
  );
}

function BIDashboardsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();

  const listQ = useQuery({
    queryKey: ["dashboards", "list"],
    queryFn: dashboards.list,
    enabled: can(DASH_READ),
  });

  if (!can(DASH_READ)) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
        <EmptyPane
          icon="heroicons:lock-closed"
          title="No dashboard access"
          subtitle="Viewing dashboards needs the `dashboards.read` permission — this account does not hold it."
        />
      </ConsolePage>
    );
  }

  if (listQ.isLoading) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
        <LoadingBlock label="Listing dashboards…" />
      </ConsolePage>
    );
  }

  const items = listQ.data?.items ?? [];
  if (items.length === 0) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
        <EmptyPane
          icon="heroicons:squares-2x2"
          title="No dashboards yet"
          subtitle={
            can(DASH_MANAGE)
              ? "Nothing has been built. Anything authored in Configurations → Reporting & Dashboards appears here."
              : "Nothing has been built yet. Dashboards are authored in Configurations → Reporting & Dashboards by an account holding `dashboards.manage`."
          }
        />
        {can(DASH_MANAGE) && (
          <div className="flex justify-center pb-6">
            <Link
              href="/dashboards"
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-nb-line px-3 py-1.5 text-[12px] font-semibold text-nb-accent hover:bg-[rgba(255,255,255,.04)]"
            >
              <Icon icon="heroicons:wrench-screwdriver" className="h-3.5 w-3.5" />
              Open the builder
            </Link>
          </div>
        )}
      </ConsolePage>
    );
  }

  // `?d=` names the open dashboard; absent or unknown falls back to the first,
  // so the surface always opens onto something rather than a blank pane.
  const asked = params.get("d");
  const activeId =
    (asked && items.some((d: any) => d.id === asked) && asked) ||
    items[0].id;

  return (
    <ConsolePage>
      <EstateHeader crumbs={[{ label: "Dashboards" }]} desc={HEADER_DESC} />
      <Strip
        items={items}
        activeId={activeId}
        onPick={(id: string) => router.replace(`/bi/dashboards?d=${id}`, { scroll: false })}
      />
      {/* keyed so switching dashboards remounts the viewer clean — filter and
          drill state from one dashboard must not leak into the next */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DashboardView key={activeId} id={activeId} />
      </div>
    </ConsolePage>
  );
}

export default function BIDashboards() {
  // useSearchParams needs a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<LoadingBlock label="Listing dashboards…" />}>
      <BIDashboardsInner />
    </Suspense>
  );
}
