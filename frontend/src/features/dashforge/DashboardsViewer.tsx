"use client";

// The DASHBOARD VIEWER. The daily door to the dashboards this platform SHOWS,
// rendered through a short-lived DashForge embed token.
//
// One surface, many consoles. `?c=` names the CATEGORY: `?c=vms` is the
// surveillance set, `?c=building` the building-intelligence one, and a launcher
// tile deep-links its own. Without it, every category is offered as a tab.
// The categories are the segregation — before them this was one undifferentiated
// strip where a surveillance dashboard sat between two energy ones.
//
// Deliberately thin, and thinner than it was:
//   • It VIEWS. Registering, renaming, re-filing and removing moved to
//     Configurations → Dashboards, which is a CRUD console built like the others.
//     A create form and a delete button beside the frame they act on is how a
//     dashboard gets removed by someone who meant to close it.
//   • The selected id rides in `?d=`, so a dashboard here is a shareable LINK —
//     and note what that link carries: a registration id, never a token. Sharing
//     the URL shares a pointer, and the recipient's own `dashforge.read` is
//     re-checked before anything is minted for them.
//   • The first dashboard opens by default; a viewing surface that opens onto a
//     blank pane is the list page with extra steps.
//
// Permission shape:
//   dashforge.read   → this list, and the embed token that makes a dashboard
//                      render. Without it no token is ever minted, so the data is
//                      unreachable rather than merely hidden — DashForge's public
//                      embed route is unauthenticated and the token IS the
//                      credential.
//   dashforge.manage → nothing here. See Configurations → Dashboards.
import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { ConsolePage, EmptyPane, EstateHeader, LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import EmbedView from "./EmbedView";
import { dashforge, type DashForgeEmbed } from "./api";
import { CATEGORIES, categoryLabel, PERM_MANAGE, PERM_READ } from "./constants";

export interface DashboardsViewerProps {
  /** The console this surface belongs to. A page fixes it (Building Intelligence
   *  shows `building`); left unset, `?c=` chooses and every category is offered
   *  as a tab. */
  category?: string;
  /** Crumb for the header — the console's own name. */
  crumb?: string;
}

function DashboardsViewerInner({ category: fixed, crumb }: DashboardsViewerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();

  // A fixed category wins over the query: a page that IS one console's dashboards
  // must not be talked into showing another's by a hand-edited URL.
  const asked = params.get("c");
  const category = fixed ?? (asked && CATEGORIES.some((c) => c.slug === asked) ? asked : null);

  const listQ = useQuery({
    // Keyed by category because it is a server-side filter, not a slice: two
    // categories are two different responses and must not share a cache entry.
    queryKey: ["dashforge", "list", category ?? "all"],
    queryFn: () => dashforge.list(category ? { category } : {}),
    enabled: can(PERM_READ),
  });

  const items: DashForgeEmbed[] = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const label = category ? categoryLabel(category) : "All dashboards";
  const crumbs = [{ label: crumb || "Dashboards" }];
  const desc =
    `The dashboards registered for ${category ? label : "this platform"}. ` +
    "Pick a name to open it here — this surface views; DashForge authors.";

  const manageLink = can(PERM_MANAGE) ? (
    <Link
      href="/config/dashboards"
      className="inline-flex items-center gap-1.5 rounded-[8px] border border-nb-line px-2.5 py-1.5 text-[11.5px] font-semibold text-nb-faint transition hover:text-nb-ink"
    >
      <Icon icon="heroicons-outline:cog-6-tooth" className="text-[13px]" />
      Manage
    </Link>
  ) : null;

  if (!can(PERM_READ)) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={crumbs} desc={desc} />
        <EmptyPane
          icon="heroicons:lock-closed"
          title="No dashboard access"
          subtitle="Viewing dashboards needs the `dashforge.read` permission — this account does not hold it. Without it no embed token is minted, so the data is unreachable, not merely hidden."
        />
      </ConsolePage>
    );
  }

  if (listQ.isLoading) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={crumbs} desc={desc} right={manageLink} />
        <LoadingBlock label="Listing dashboards…" />
      </ConsolePage>
    );
  }

  if (listQ.error) {
    // A failed load must never read as "nothing registered": one tells an
    // operator to go and register something, the other that the dashboards they
    // have may be fine and unreachable.
    return (
      <ConsolePage>
        <EstateHeader crumbs={crumbs} desc={desc} right={manageLink} />
        <EmptyPane
          icon="heroicons:exclamation-triangle"
          title="Could not list dashboards"
          subtitle={apiError(listQ.error, "The registry did not answer.")}
        />
      </ConsolePage>
    );
  }

  const tabs = !fixed ? (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-1 rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.7)] p-1.5">
      <Tab label="All" on={!category} onClick={() => router.replace("?", { scroll: false })} />
      {CATEGORIES.map((c) => (
        <Tab
          key={c.slug}
          label={c.label}
          icon={c.icon}
          on={category === c.slug}
          onClick={() => router.replace(`?c=${c.slug}`, { scroll: false })}
        />
      ))}
    </div>
  ) : null;

  if (items.length === 0) {
    return (
      <ConsolePage>
        <EstateHeader crumbs={crumbs} desc={desc} right={manageLink} />
        {tabs}
        <EmptyPane
          icon="heroicons:squares-2x2"
          title={category ? `No ${label} dashboards` : "No dashboards registered"}
          subtitle={
            can(PERM_MANAGE)
              ? "Build a dashboard in DashForge, then register it under Configurations → Dashboards and file it in this category."
              : "Nothing is filed here yet. An account holding `dashforge.manage` chooses which dashboards appear, and in which console."
          }
        />
      </ConsolePage>
    );
  }

  // `?d=` names the open dashboard; absent or unknown falls back to the first, so
  // the surface always opens onto something rather than a blank pane.
  const askedId = params.get("d");
  const active = (askedId && items.find((d) => d.id === askedId)) || items[0];
  const keep = category ? `c=${category}&` : "";

  return (
    <ConsolePage>
      <EstateHeader crumbs={crumbs} desc={desc} right={manageLink} />
      {tabs}
      <div className="mb-3 flex shrink-0 items-center gap-1.5 overflow-x-auto rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.7)] p-1.5">
        {items.map((d) => (
          <button
            key={d.id}
            onClick={() => router.replace(`?${keep}d=${d.id}`, { scroll: false })}
            title={d.description || d.name}
            className={`shrink-0 rounded-[7px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              d.id === active.id
                ? "bg-nb-accent/15 text-nb-accent"
                : "text-nb-faint hover:bg-[rgba(255,255,255,.04)] hover:text-nb-ink"
            }`}
          >
            {d.name}
          </button>
        ))}
      </div>
      {/* keyed so switching dashboards mints a fresh session and remounts the
          frame clean — one dashboard's token must never render another's */}
      <EmbedView key={active.id} id={active.id} name={active.name} />
    </ConsolePage>
  );
}

function Tab({
  label,
  icon,
  on,
  onClick,
}: {
  label: string;
  icon?: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors ${
        on
          ? "bg-nb-accent/15 text-nb-accent"
          : "text-nb-faint hover:bg-[rgba(255,255,255,.04)] hover:text-nb-ink"
      }`}
    >
      {icon && <Icon icon={icon} className="text-[13px]" />}
      {label}
    </button>
  );
}

export default function DashboardsViewer(props: DashboardsViewerProps) {
  // useSearchParams needs a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<LoadingBlock label="Listing dashboards…" />}>
      <DashboardsViewerInner {...props} />
    </Suspense>
  );
}
