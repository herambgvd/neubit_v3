"use client";

// Version history: what this dashboard looked like, and how to get back.
//
// PORTED from the reference's `version-history-drawer.tsx` (170 lines) and
// `version-diff-dialog.tsx` (265): a right-hand drawer listing versions newest
// first, each row offering "Compare" and "Restore", the restore behind a
// confirmation.
//
// What changed is mostly what the backend gives it: our snapshot is one object
// carrying the whole dashboard, so a row can honestly say how many widgets that
// version had, and the diff compares like with like without the browser
// reassembling anything. And the confirmation can promise something theirs
// cannot quite: restoring writes the state it is about to discard as its own
// version FIRST, so the undo is itself undoable.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Drawer, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";

import { dashboards } from "./api";
import type { VersionListResponse, VersionSummary } from "./api";
import { diffSnapshots, fieldLabel, formatDiffValue } from "./version-diff";
import type { DashboardSnapshot } from "./version-diff";

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

function ChangeLine({ field, from, to }: { field: string; from: unknown; to: unknown }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 py-0.5 text-[11px]">
      <span className="font-mono text-nb-faint">{fieldLabel(field)}</span>
      <span className="max-w-[180px] truncate rounded-[5px] bg-[rgba(248,113,113,.1)] px-1.5 text-nb-crit">
        {formatDiffValue(from)}
      </span>
      <Icon icon="heroicons:arrow-right" className="shrink-0 text-[11px] text-nb-faint" />
      <span className="max-w-[180px] truncate rounded-[5px] bg-[rgba(52,211,153,.1)] px-1.5 text-nb-good">
        {formatDiffValue(to)}
      </span>
    </div>
  );
}

function DiffDialog({
  open,
  onClose,
  from,
  to,
  fromLabel,
  toLabel,
}: {
  open: boolean;
  onClose: () => void;
  from: DashboardSnapshot;
  to: DashboardSnapshot;
  fromLabel: string;
  toLabel: string;
}) {
  const diff = useMemo(() => diffSnapshots(from, to), [from, to]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="What changed"
      subtitle={`${fromLabel} → ${toLabel}`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {!diff.hasChanges ? (
        <p className="px-2 py-8 text-center text-[11.5px] text-nb-faint">
          These two are identical.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-nb-faint">
            {diff.count} change{diff.count === 1 ? "" : "s"}
          </p>

          {diff.dashboardChanges.length ? (
            <section>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                Dashboard
              </h4>
              <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-2.5 py-1.5">
                {diff.dashboardChanges.map((c) => (
                  <ChangeLine key={c.field} {...c} />
                ))}
              </div>
            </section>
          ) : null}

          {diff.widgetsAdded.length ? (
            <section>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-good">
                Added
              </h4>
              <ul className="space-y-1">
                {diff.widgetsAdded.map((w) => (
                  <li
                    key={w.id}
                    className="rounded-[9px] border border-[rgba(52,211,153,.25)] bg-[rgba(52,211,153,.07)] px-2.5 py-1.5 text-[11.5px] text-nb-ink"
                  >
                    {w.title}
                    {w.viz ? <span className="ml-1.5 text-[10px] text-nb-faint">{w.viz}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {diff.widgetsRemoved.length ? (
            <section>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-crit">
                Removed
              </h4>
              <ul className="space-y-1">
                {diff.widgetsRemoved.map((w) => (
                  <li
                    key={w.id}
                    className="rounded-[9px] border border-[rgba(248,113,113,.25)] bg-[rgba(248,113,113,.07)] px-2.5 py-1.5 text-[11.5px] text-nb-ink"
                  >
                    {w.title}
                    {w.viz ? <span className="ml-1.5 text-[10px] text-nb-faint">{w.viz}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {diff.widgetsChanged.length ? (
            <section>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                Changed
              </h4>
              <div className="space-y-1.5">
                {diff.widgetsChanged.map((w) => (
                  <div
                    key={w.id}
                    className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-2.5 py-1.5"
                  >
                    <div className="mb-0.5 text-[11.5px] text-nb-ink">{w.title}</div>
                    {w.changes.map((c) => (
                      <ChangeLine key={c.field} {...c} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

export default function VersionHistoryDrawer({
  open,
  dashboardId,
  canManage,
  onClose,
  onRestored,
}: {
  open: boolean;
  dashboardId: string;
  canManage: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<any>(null);
  const [compare, setCompare] = useState<VersionSummary | null>(null);

  const q = useQuery<VersionListResponse>({
    queryKey: ["dashboard-versions", dashboardId],
    queryFn: () => dashboards.versions(dashboardId),
    enabled: open,
  });

  // The snapshot of the version being compared. Fetched on demand: the list
  // deliberately ships no snapshots, because thirty of them is the dashboard
  // thirty times over for a drawer that shows a date and a label.
  const detail = useQuery({
    queryKey: ["dashboard-version", dashboardId, compare?.version],
    queryFn: () => dashboards.version(dashboardId, compare!.version),
    enabled: !!compare,
  });

  const restoreM = useMutation({
    mutationFn: (version: number) => dashboards.restoreVersion(dashboardId, version),
    onSuccess: (_d, version) => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      qc.invalidateQueries({ queryKey: ["dashboard-versions", dashboardId] });
      onRestored();
      toast.success(`Restored version ${version}`, {
        description: "What was there before was kept as a new version.",
      });
    },
    onError: (e) => toast.error(apiError(e, "Could not restore that version")),
  });

  const items = q.data?.items || [];
  const current = (q.data?.current || {}) as DashboardSnapshot;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Version history"
        subtitle="A snapshot after every change that saved. Restoring keeps what is there now as a new version, so it is undoable."
        width="max-w-md"
      >
        {q.isLoading ? (
          <p className="px-1 py-6 text-center text-[11.5px] text-nb-faint">Loading history…</p>
        ) : q.isError ? (
          <p className="px-1 py-6 text-center text-[11.5px] text-nb-crit">
            {apiError(q.error, "Could not load the history")}
          </p>
        ) : items.length === 0 ? (
          // ABSENCE, said plainly. A dashboard nobody has edited since this
          // landed genuinely has no history, and inventing a "version 1" for the
          // state it happens to be in now would be a snapshot of a moment nobody
          // chose.
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-6 text-center text-[11.5px] leading-relaxed text-nb-faint">
            No versions yet. One is written after every change that saves — edit
            something and it will appear here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((v, i) => (
              <li
                key={v.version}
                className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-2.5 py-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-nb-blueb">v{v.version}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-nb-ink">
                    {v.label || "changed"}
                  </span>
                  {i === 0 ? (
                    <span className="shrink-0 rounded-full border border-nb-line px-1.5 text-[9.5px] uppercase tracking-[1px] text-nb-faint">
                      latest
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-nb-faint">
                  <span>{when(v.created_at)}</span>
                  <span>·</span>
                  <span>
                    {v.widget_count} widget{v.widget_count === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCompare(v)}
                      className="text-nb-faint transition hover:text-nb-ink"
                    >
                      Compare
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirm({
                            title: `Restore version ${v.version}?`,
                            message:
                              `The dashboard goes back to “${v.label || "that state"}” from ` +
                              `${when(v.created_at)}. What is there now is kept as a new version, ` +
                              `so this can be undone.`,
                            confirmLabel: "Restore",
                            onConfirm: () => restoreM.mutate(v.version),
                          })
                        }
                        className="text-nb-blueb transition hover:text-nb-ink"
                      >
                        Restore
                      </button>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      <DiffDialog
        open={!!compare && !!detail.data}
        onClose={() => setCompare(null)}
        from={(detail.data?.snapshot || {}) as DashboardSnapshot}
        to={current}
        fromLabel={compare ? `v${compare.version} (${when(compare.created_at)})` : ""}
        toLabel="now"
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={restoreM.isPending} />
    </>
  );
}
