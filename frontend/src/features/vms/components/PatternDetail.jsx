"use client";

// PatternDetail — the right-hand detail for a selected Pattern or Camera Group.
// Patterns show the groups in rotation + dwell + an "Open in streaming" action
// (→ /streaming?pattern_id=<id>&autoplay=1). Groups show their grid layout + a
// live preview of the camera-to-cell placement (the same grid the wall renders).
import Link from "next/link";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import { fmtDateTime } from "@/lib/format";
import { getGroupLayout, groupGridStyle } from "../videoWall";

export default function PatternDetail({ item, isPattern, groupById, cameraById, onEdit, onDelete, onToggleActive }) {
  const active = item.is_active !== false;
  const icon = isPattern ? "heroicons:squares-2x2" : "heroicons-outline:video-camera";
  const grid = isPattern ? null : getGroupLayout(item.layout);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-card-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-card-border px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-hover text-foreground">
            <Icon icon={icon} className="text-xl" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{item.name}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span
                className={`rounded-full px-2 py-0.5 font-medium uppercase tracking-wide ${
                  active ? "bg-emerald-500/15 text-emerald-400" : "bg-hover text-muted"
                }`}
              >
                {active ? "Active" : "Inactive"}
              </span>
              {isPattern ? (
                <span>· {item.seconds || 0}s rotation · {(item.camera_group_ids || []).length} groups</span>
              ) : (
                <span>· {grid.label} · {(item.camera_ids || []).length} cameras</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isPattern && (
            <Link
              href={`/streaming?pattern_id=${encodeURIComponent(item.id)}&autoplay=1`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-400 transition hover:bg-blue-500/20"
            >
              <Icon icon="heroicons-outline:play" className="text-sm" />
              Open in streaming
            </Link>
          )}
          <Button variant="secondary" className="!px-2.5 !py-1.5 !text-xs" onClick={() => onToggleActive(item)}>
            {active ? "Deactivate" : "Activate"}
          </Button>
          <Button variant="secondary" icon="heroicons-outline:pencil-square" className="!px-2.5 !py-1.5 !text-xs" onClick={() => onEdit(item)}>
            Edit
          </Button>
          <Button variant="danger" icon="heroicons-outline:trash" className="!px-2.5 !py-1.5 !text-xs" onClick={() => onDelete(item)}>
            Delete
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <DetailField label="Description">
          {item.description ? (
            <p className="text-sm leading-relaxed text-foreground">{item.description}</p>
          ) : (
            <span className="text-xs italic text-muted">No description</span>
          )}
        </DetailField>

        {isPattern ? (
          <DetailField label="Camera groups in rotation">
            {(item.camera_group_ids || []).length === 0 ? (
              <span className="text-xs italic text-muted">No groups assigned.</span>
            ) : (
              <ol className="space-y-1.5">
                {item.camera_group_ids.map((gid, i) => {
                  const g = groupById?.get(gid);
                  return (
                    <li
                      key={gid}
                      className="flex items-center gap-3 rounded-lg border border-card-border px-3 py-2"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {g?.name || <span className="italic text-muted">Deleted group</span>}
                        </span>
                        {g && (
                          <span className="block text-[11px] text-muted">
                            {(g.camera_ids || []).length} cameras · {getGroupLayout(g.layout).label}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </DetailField>
        ) : (
          <DetailField label="Camera layout">
            <div className="rounded-lg border border-card-border bg-[#050506] p-2">
              <div className="grid aspect-video gap-1.5" style={groupGridStyle(grid)}>
                {Array.from({ length: grid.capacity }, (_, i) => {
                  const cid = item.camera_ids?.[i];
                  const cam = cid ? cameraById?.get(cid) : null;
                  return (
                    <div
                      key={i}
                      className={`flex items-center justify-center overflow-hidden rounded border px-1 text-center text-[10px] ${
                        cid
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : "border-card-border bg-hover/30 text-muted"
                      }`}
                    >
                      <span className="truncate">{cam?.name || (cid ? cid : `Cell ${i + 1}`)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </DetailField>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <DetailField label="Created">
            <span className="text-sm text-foreground">{item.created_at ? fmtDateTime(item.created_at) : "—"}</span>
          </DetailField>
          <DetailField label="Updated">
            <span className="text-sm text-foreground">{item.updated_at ? fmtDateTime(item.updated_at) : "—"}</span>
          </DetailField>
          <DetailField label="ID">
            <span className="font-mono text-xs text-muted">{item.id}</span>
          </DetailField>
        </div>
      </div>
    </section>
  );
}

function DetailField({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
