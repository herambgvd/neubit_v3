"use client";

// Right-pane detail for a selected registration — built to the same shape as
// SiteDetail, because a console that sits beside Sites should not have its own
// idea of what a detail pane looks like: a 12×12 glyph tile, the name as an h2,
// a row of pills under it, and PaneAction / PaneDeleteAction on the right.
//
// The body is the read-only field grid the other consoles use (`InfoField`),
// not a bespoke definition list.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import { PaneAction, PaneDeleteAction } from "@/components/console";

import type { DashForgeEmbed } from "../api";
import { CATEGORIES, categoryLabel } from "../constants";

function InfoField({ label, full, children }: { label: ReactNode; full?: boolean; children?: ReactNode }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Where this dashboard is actually shown. Building Intelligence and Surveillance
 *  have their own viewer; the rest are reached from the shared one with the
 *  category preselected, so every category has a real destination. */
function viewerHref(category: string): string {
  if (category === "building") return "/bi/dashboards";
  if (category === "vms") return "/surveillance/dashboards";
  return `/bi/dashboards?c=${category}`;
}

export interface DashboardDetailProps {
  dashboard: DashForgeEmbed;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function DashboardDetail({ dashboard, canManage, onEdit, onDelete }: DashboardDetailProps) {
  const d = dashboard;
  const icon = CATEGORIES.find((c) => c.slug === d.category)?.icon || "heroicons-outline:squares-2x2";
  const locks = Object.entries(d.scope || {});

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-nb-line px-6 py-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb">
            <Icon icon={icon} className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold text-nb-ink">{d.name}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-nb-soft">
              <span className="font-mono text-nb-faint">{d.dashboard_ref}</span>
              <span className="rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-2 py-0.5 font-medium text-nb-blueb">
                {categoryLabel(d.category)}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 font-medium ${
                  locks.length
                    ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] text-nb-good"
                    : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"
                }`}
              >
                {locks.length ? `${locks.length} locked filter${locks.length === 1 ? "" : "s"}` : "No filter lock"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* The registration's whole point is that a console shows it. Without
              this the only way to check the filing was right is to go and look
              for it in the other console. */}
          <PaneAction
            href={viewerHref(d.category)}
            icon="heroicons-outline:arrow-top-right-on-square"
            title={`Open in ${categoryLabel(d.category)}`}
          >
            Open
          </PaneAction>
          {canManage && (
            <>
              <PaneAction icon="heroicons-outline:pencil-square" onClick={onEdit}>
                Edit
              </PaneAction>
              <PaneDeleteAction title="Remove" onClick={onDelete} />
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-6 py-5 md:grid-cols-2">
          {d.description && (
            <InfoField label="Description" full>
              <p className="text-sm text-nb-muted">{d.description}</p>
            </InfoField>
          )}
          <InfoField label="Shown on">
            <p className="text-sm text-nb-ink">{categoryLabel(d.category)}</p>
          </InfoField>
          <InfoField label="DashForge workspace">
            <p className="font-mono text-sm text-nb-ink">{d.workspace_ref}</p>
          </InfoField>
          <InfoField label="DashForge dashboard">
            <p className="font-mono text-sm text-nb-ink">{d.dashboard_ref}</p>
          </InfoField>
          <InfoField label="Registered">
            <p className="text-sm text-nb-ink">
              {d.created_at ? new Date(d.created_at).toLocaleString() : "—"}
            </p>
          </InfoField>
          <InfoField label="Updated">
            <p className="text-sm text-nb-ink">
              {d.updated_at ? new Date(d.updated_at).toLocaleString() : "—"}
            </p>
          </InfoField>
          <InfoField label="Locked filters" full>
            {locks.length === 0 ? (
              // Not left blank: an empty lock is a real and consequential state —
              // every viewer of this dashboard sees every row it can reach — and
              // a blank reads as "not filled in yet".
              <p className="text-sm text-nb-muted">
                None. Every viewer of this dashboard sees every row it can reach.
              </p>
            ) : (
              <ul className="space-y-1">
                {locks.map(([k, v]) => (
                  <li key={k} className="font-mono text-[12.5px] text-nb-ink">
                    <span className="text-nb-blueb">{k}</span>={v}
                  </li>
                ))}
              </ul>
            )}
          </InfoField>
        </div>
      </div>
    </div>
  );
}
