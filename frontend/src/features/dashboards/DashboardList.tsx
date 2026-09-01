"use client";

// Dashboards index — what exists, and the way in to building a new one.
//
// Not ported: the standalone product's list page is wired to its own routing,
// share links and folder model, none of which apply here. This is the console's
// own `ConsolePage`/`ConsolePanel` vocabulary so the screen belongs to this
// application rather than looking like a guest in it.
//
// Permission shape, which is the only subtle thing here:
//   dashboards.read    → see this list, open a dashboard
//   dashboards.manage  → the "New dashboard" button and the delete action
//   bi.read            → the widgets' DATA (enforced by the reading-writer)
// The three compose honestly. A user with read but not manage gets a browsable,
// unbuildable console. A user with dashboards.* but not bi.read gets the canvas
// with widgets that say they could not run — which is the truth, not a bug.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  CreateButton,
  EmptyPane,
  PanelHeader,
  PanelList,
  PanelSearch,
} from "@/components/console";
import { Button, ConfirmDialog, Input, Modal, Textarea } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtRelative } from "@/lib/format";

import { dashboards } from "./api";
import type { DashboardSummary } from "./api";
import { PERM_DATA, PERM_MANAGE } from "./constants";

export default function DashboardList() {
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can(PERM_MANAGE);
  const canReadData = can(PERM_DATA);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [confirm, setConfirm] = useState<any>(null);

  const listQ = useQuery<any>({
    queryKey: ["dashboards"],
    queryFn: () => dashboards.list(),
  });

  const items: DashboardSummary[] = (listQ.data?.items || []).filter((d: DashboardSummary) =>
    !search.trim() ? true : d.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const createM = useMutation({
    mutationFn: () => dashboards.create({ name: name.trim(), description: description.trim() || null }),
    onSuccess: (d) => {
      setCreating(false);
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      // Straight into edit mode: a dashboard with no widgets has nothing to view.
      router.push(`/dashboards/${d.id}?edit=1`);
    },
    onError: (e) => toast.error(apiError(e, "Could not create the dashboard")),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => dashboards.remove(id),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Dashboard deleted");
    },
    onError: (e) => toast.error(apiError(e, "Could not delete the dashboard")),
  });

  return (
    <ConsolePage>
      <ConsoleGrid cols="lg:grid-cols-[340px_1fr]">
        <ConsolePanel>
          <PanelHeader icon="heroicons:squares-2x2" title="Dashboards" count={items.length} />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search dashboards…" />
          <PanelList
            loading={listQ.isLoading}
            error={listQ.isError ? apiError(listQ.error, "Could not load dashboards") : null}
            empty={!items.length}
            emptyText={search ? "No dashboard matches that." : "No dashboards yet."}
          >
            {items.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => router.push(`/dashboards/${d.id}`)}
                className="w-full rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-3 py-2.5 text-left transition hover:border-nb-line2"
              >
                <div className="flex items-center gap-2">
                  <Icon icon="heroicons:squares-2x2" className="shrink-0 text-[13px] text-nb-violetb" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-nb-ink">{d.name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">
                    {d.widget_count}
                  </span>
                </div>
                {d.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-nb-soft">
                    {d.description}
                  </p>
                ) : null}
                <p className="mt-1 text-[10px] text-nb-faint">
                  updated {fmtRelative(d.updated_at)}
                </p>
              </button>
            ))}
          </PanelList>
          {canManage ? (
            <div className="border-t border-nb-line/50 p-3">
              <CreateButton label="New dashboard" onClick={() => setCreating(true)} />
            </div>
          ) : null}
        </ConsolePanel>

        <ConsolePanel className="p-0">
          <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
            <h2 className="text-[15px] font-semibold text-nb-ink">Dashboard builder</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-nb-soft">
              Build a canvas of widgets over the live reading store. A widget is
              defined by a <strong className="text-nb-ink">structured query</strong> —
              a scope, a metric, a window and a rollup — not by SQL. Charts read the
              1-minute and 1-hour continuous aggregates, so what a widget costs to
              run does not grow with how fast the building reports.
            </p>

            {!canReadData ? (
              <div className="mt-4 rounded-[10px] border border-[rgba(251,191,36,.3)] bg-[rgba(251,191,36,.07)] px-3 py-2.5 text-[11.5px] leading-snug text-nb-warn">
                You can open dashboards, but you do not hold{" "}
                <span className="font-mono">bi.read</span>, so their widgets will not
                return data. Ask an administrator to grant “View building
                intelligence”.
              </div>
            ) : null}

            {items.length ? (
              <div className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((d) => (
                  <div
                    key={d.id}
                    className="group flex flex-col rounded-[12px] border border-nb-line bg-[rgba(6,11,26,.45)] p-3.5 transition hover:border-nb-line2"
                  >
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-nb-ink">
                        {d.name}
                      </span>
                      {canManage ? (
                        <button
                          type="button"
                          title="Delete dashboard"
                          aria-label="Delete dashboard"
                          onClick={() =>
                            setConfirm({
                              title: "Delete dashboard",
                              message: `“${d.name}” and its ${d.widget_count} widget${d.widget_count === 1 ? "" : "s"} will be removed. This cannot be undone.`,
                              confirmLabel: "Delete",
                              danger: true,
                              onConfirm: () => deleteM.mutate(d.id),
                            })
                          }
                          className="shrink-0 rounded-[6px] p-1 text-nb-faint opacity-0 transition group-hover:opacity-100 hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
                        >
                          <Icon icon="heroicons:trash" className="text-[13px]" />
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-[2.2em] text-[11px] leading-snug text-nb-soft">
                      {d.description || "No description."}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="action"
                        icon="heroicons:eye"
                        onClick={() => router.push(`/dashboards/${d.id}`)}
                      >
                        Open
                      </Button>
                      {canManage ? (
                        <Button
                          variant="ghost"
                          icon="heroicons:pencil-square"
                          onClick={() => router.push(`/dashboards/${d.id}?edit=1`)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <span className="ml-auto font-mono text-[10.5px] text-nb-faint">
                        {d.widget_count} widget{d.widget_count === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-6">
                <EmptyPane
                  icon="heroicons:squares-2x2"
                  title="No dashboards yet"
                  subtitle={
                    canManage
                      ? "Create one, then add widgets from the live reading store."
                      : "Nobody has built one yet, and you do not hold the permission to."
                  }
                />
              </div>
            )}
          </div>
        </ConsolePanel>
      </ConsoleGrid>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New dashboard"
        subtitle="A name and, if it helps, one line about what it is for."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!name.trim() || createM.isPending}
              icon={createM.isPending ? "svg-spinners:180-ring" : "heroicons:plus"}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Name"
            required
            value={name}
            onChange={(e: any) => setName(e.target.value)}
            placeholder="e.g. Building overview"
          />
          <Textarea
            label="Description"
            rows={3}
            value={description}
            onChange={(e: any) => setDescription(e.target.value)}
            placeholder="What this dashboard is for."
          />
        </div>
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={deleteM.isPending} />
    </ConsolePage>
  );
}
