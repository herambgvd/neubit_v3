"use client";

// Configurations → DASHBOARDS. Where the dashboards this platform shows are
// managed: register, rename, re-file, remove.
//
// It used to live on the Building Intelligence VIEWER, which was the only place a
// registration could be made — so managing a surveillance dashboard meant opening
// Building Intelligence, and the viewing surface carried a create form and a
// delete button beside the frame it was meant to display. Registration is
// configuration; it belongs with the other CRUD consoles.
//
// Built to the SITES SHAPE, which is the shape every console in this group uses:
// ConsoleGrid 25:75, a PanelHeader with counts and a ＋, PanelSearch, a list of
// bordered cards (DashboardListItem, the SiteListItem card), and a detail pane
// whose header carries the glyph tile, the name, its pills and PaneAction /
// PaneDeleteAction. The first version of this screen was a hover-row list with
// icon actions that appeared on hover and a hand-built definition list — its own
// idea of a console, sitting next to Sites.
//
// CATEGORY is the point of this screen as much as the CRUD is: it decides which
// console shows the dashboard. The filter above the list is the shared Segmented
// control, and it counts what it filters, so a dashboard filed in the wrong
// console is visible here rather than merely missing over there.
//
// Permissions:
//   dashforge.read    see the registrations (readable without manage, so an
//                     operator can be told what exists)
//   dashforge.manage  register, edit, remove
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  IconButton,
  PanelCounts,
  PanelHeader,
  PanelList,
  PanelSearch,
  Segmented,
} from "@/components/console";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import DashboardForm from "./DashboardForm";
import DashboardDetail from "./components/DashboardDetail";
import DashboardListItem from "./components/DashboardListItem";
import { dashforge, type DashForgeEmbed } from "./api";
import { CATEGORIES, categoryLabel, PERM_MANAGE, PERM_READ } from "./constants";

// Short labels for the rail's filter — the full names ("Building Intelligence")
// are what the pills and the detail pane say, where there is room for them.
const FILTER_LABEL: Record<string, string> = {
  building: "Building",
  vms: "Video",
  access: "Access",
  workflow: "Workflow",
  general: "General",
};

export default function DashboardsManager() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  // "" = every category. A filter, not a tab bar: this console's job is to show
  // what exists across consoles, and hiding four fifths of it by default is how a
  // duplicate registration gets made.
  const [category, setCategory] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DashForgeEmbed | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const manage = can(PERM_MANAGE);

  // The WHOLE set, unfiltered: the counts beside the filter are counts of
  // everything registered, and a per-category fetch could only count the one
  // being shown. Filtering is local for the same reason.
  const listQ = useQuery({
    queryKey: ["dashforge", "list"],
    queryFn: () => dashforge.list(),
    enabled: can(PERM_READ),
  });

  const items: DashForgeEmbed[] = useMemo(() => listQ.data?.items ?? [], [listQ.data]);

  const countByCategory = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((d) => m.set(d.category, (m.get(d.category) || 0) + 1));
    return m;
  }, [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((d) => {
      if (category && d.category !== category) return false;
      if (!term) return true;
      return (
        d.name.toLowerCase().includes(term) ||
        (d.description || "").toLowerCase().includes(term) ||
        d.dashboard_ref.toLowerCase().includes(term)
      );
    });
  }, [items, category, search]);

  // The explicit choice, or the first row of what is showing. Derived rather than
  // synced by an effect, which renders one frame with nothing selected.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;
  const selected = useMemo(
    () => filtered.find((d) => d.id === effectiveId) || null,
    [filtered, effectiveId],
  );

  // Locked vs open, which is the one thing about a registration worth counting:
  // an unlocked dashboard shows every viewer every row it can reach. Sites counts
  // active/inactive in the same slot; there is no active state here and inventing
  // one would be a status nothing sets.
  const lockedCount = items.filter((d) => Object.keys(d.scope || {}).length > 0).length;

  const remove = useMutation({
    mutationFn: (id: string) => dashforge.remove(id),
    onSuccess: (_d, id) => {
      toast.success("Registration removed");
      if (effectiveId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["dashforge"] });
    },
    onError: (e) => toast.error(apiError(e, "Could not remove that registration")),
  });

  const askDelete = (row: DashForgeEmbed) =>
    setConfirm({
      title: "Remove registration",
      // Says what it does NOT do, because "remove dashboard" is what an operator
      // will read into it: the dashboard and its data stay in DashForge, and only
      // this console stops showing it.
      message: `“${row.name}” will stop appearing under ${categoryLabel(row.category)}. The dashboard itself stays in DashForge and is not deleted.`,
      confirmLabel: "Remove",
      onConfirm: () => {
        remove.mutate(row.id);
        setConfirm(null);
      },
    });

  if (!can(PERM_READ)) {
    return (
      <ConsolePage>
        <EmptyPane
          icon="heroicons:lock-closed"
          title="No dashboard access"
          subtitle="Seeing which dashboards are registered needs the `dashforge.read` permission — this account does not hold it."
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <ConsoleGrid>
        {/* LEFT — library */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:rectangle-group"
            title="Dashboards"
            count={items.length}
            actions={
              <>
                <PanelCounts
                  items={[
                    { tone: "good", value: lockedCount, label: "filter-locked" },
                    { tone: "idle", value: items.length - lockedCount, label: "unlocked" },
                  ]}
                />
                {manage && (
                  // The only way to start a registration, so it carries a real
                  // accessible name rather than leaving a bare "+".
                  <IconButton
                    icon="heroicons:plus"
                    title="New dashboard"
                    onClick={() => {
                      setEditTarget(null);
                      setFormOpen(true);
                    }}
                  />
                )}
              </>
            }
          />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search by name or dashboard id…" />
          <div className="px-2.5 pb-2">
            <Segmented
              className="w-full overflow-x-auto"
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: `All ${items.length}` },
                ...CATEGORIES.map((c) => ({
                  value: c.slug,
                  icon: c.icon,
                  label: `${FILTER_LABEL[c.slug] ?? c.label} ${countByCategory.get(c.slug) || 0}`,
                })),
              ]}
            />
          </div>

          <PanelList
            loading={listQ.isLoading}
            // A failed load must never read as "none registered yet".
            error={listQ.error ? apiError(listQ.error, "Couldn't load dashboards") : undefined}
            empty={filtered.length === 0}
            emptyText={
              search.trim()
                ? "No dashboards match your search"
                : category
                  ? `Nothing filed under ${categoryLabel(category)} yet`
                  : "No dashboards registered yet"
            }
          >
            {filtered.map((d) => (
              <DashboardListItem
                key={d.id}
                dashboard={d}
                selected={d.id === effectiveId}
                onSelect={() => setSelectedId(d.id)}
              />
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — detail */}
        <ConsolePanel>
          {selected ? (
            <DashboardDetail
              key={selected.id}
              dashboard={selected}
              canManage={manage}
              onEdit={() => {
                setEditTarget(selected);
                setFormOpen(true);
              }}
              onDelete={() => askDelete(selected)}
            />
          ) : (
            <EmptyPane
              icon="heroicons-outline:rectangle-group"
              title="No dashboard selected"
              subtitle={
                manage
                  ? "Pick one from the list, or use ＋ New dashboard at the top of it."
                  : "Pick one from the list to see where it points."
              }
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

      <DashboardForm
        open={formOpen}
        target={editTarget}
        defaultCategory={category || undefined}
        onClose={() => {
          setFormOpen(false);
          setEditTarget(null);
        }}
        onSaved={(row) => setSelectedId(row.id)}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsolePage>
  );
}
