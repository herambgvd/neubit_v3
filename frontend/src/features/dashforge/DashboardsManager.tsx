"use client";

// Configurations → DASHBOARDS. Where the dashboards this platform shows are
// managed: register, rename, re-file, remove.
//
// It used to live on the Building Intelligence VIEWER, which was the only place a
// registration could be made — so managing a surveillance dashboard meant opening
// Building Intelligence, and the viewing surface carried a create form and a
// delete button beside the frame it was meant to display. Registration is
// configuration; it belongs with the other CRUD consoles and is built from the
// same primitives (ConsoleGrid 25:75, header ＋, PanelSearch, PanelList).
//
// CATEGORY is the point of this screen as much as the CRUD is: it decides which
// console shows the dashboard. Filed under "Surveillance" it appears on the
// surveillance viewer; under "Building Intelligence" on that one. The rail lists
// every category with its count, so a dashboard filed in the wrong one is
// visible here rather than merely missing over there.
//
// Permissions:
//   dashforge.read    see the registrations (this screen is readable without
//                     manage so an operator can be told what exists)
//   dashforge.manage  register, edit, remove
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  ConsoleGrid,
  ConsolePage,
  ConsolePanel,
  EmptyPane,
  IconButton,
  PanelHeader,
  PanelList,
  PanelSearch,
  RowAction,
} from "@/components/console";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import DashboardForm from "./DashboardForm";
import { dashforge, type DashForgeEmbed } from "./api";
import { CATEGORIES, categoryLabel, PERM_MANAGE, PERM_READ } from "./constants";

function CategoryChip({ slug }: { slug: string }) {
  const meta = CATEGORIES.find((c) => c.slug === slug);
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] border border-nb-line px-1.5 py-0.5 text-[10.5px] font-medium text-nb-faint">
      <Icon icon={meta?.icon || "heroicons:squares-2x2"} className="text-[11px]" />
      {categoryLabel(slug)}
    </span>
  );
}

export default function DashboardsManager() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  // null = every category. A filter, not a tab bar: the manager's job is to show
  // what exists across consoles, and hiding four fifths of it by default is how a
  // duplicate registration gets made.
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DashForgeEmbed | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const manage = can(PERM_MANAGE);

  // The WHOLE set, unfiltered: the category counts in the rail are counts of
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
      // Says what it does NOT do, because "delete dashboard" is what an operator
      // will read into it: the dashboard and its data stay in DashForge, and only
      // this console stops showing it.
      message: `“${row.name}” will stop appearing under ${categoryLabel(row.category)}. The dashboard itself stays in DashForge and is not deleted.`,
      confirmLabel: "Remove",
      onConfirm: () => {
        remove.mutate(row.id);
        setConfirm(null);
      },
    });

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };
  const openEdit = (row: DashForgeEmbed) => {
    setEditTarget(row);
    setFormOpen(true);
  };

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
        {/* LEFT — categories, then the registrations in the chosen one */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:squares-2x2"
            title="Dashboards"
            count={items.length}
            actions={
              manage ? (
                <IconButton icon="heroicons:plus" title="Register a dashboard" onClick={openCreate} />
              ) : undefined
            }
          />
          <div className="flex flex-wrap gap-1 border-b border-nb-line px-2.5 py-2">
            <FilterChip
              label="All"
              count={items.length}
              on={category === null}
              onClick={() => setCategory(null)}
            />
            {CATEGORIES.map((c) => (
              <FilterChip
                key={c.slug}
                label={c.label}
                icon={c.icon}
                count={countByCategory.get(c.slug) || 0}
                on={category === c.slug}
                onClick={() => setCategory(category === c.slug ? null : c.slug)}
              />
            ))}
          </div>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search dashboards…" />
          <PanelList
            loading={listQ.isLoading}
            // A failed load must never read as "none registered yet".
            error={listQ.error ? apiError(listQ.error, "Failed to load dashboards") : undefined}
            empty={filtered.length === 0}
            emptyText={
              search.trim()
                ? "No matches — try a different keyword."
                : category
                  ? `Nothing filed under ${categoryLabel(category)} yet.`
                  : manage
                    ? "No dashboards registered. Use ＋ above to add one."
                    : "No dashboards registered. An account holding `dashforge.manage` chooses which appear here."
            }
          >
            {filtered.map((d) => (
              <div
                key={d.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(d.id);
                  }
                }}
                className={`group relative flex cursor-pointer items-center gap-3 rounded-[10px] border px-2.5 py-2.5 outline-hidden transition ${
                  effectiveId === d.id
                    ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
                    : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
                }`}
              >
                {effectiveId === d.id && (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-nb-blue" />
                )}
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-blueb">
                  <Icon
                    icon={CATEGORIES.find((c) => c.slug === d.category)?.icon || "heroicons:squares-2x2"}
                    className="text-base"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-nb-ink">{d.name}</div>
                  <div className="truncate font-mono text-xs text-nb-faint">
                    {categoryLabel(d.category)} · {d.dashboard_ref}
                  </div>
                </div>
                {manage && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <RowAction
                      icon="heroicons-outline:pencil-square"
                      title="Edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(d);
                      }}
                    />
                    <RowAction
                      icon="heroicons-outline:trash"
                      title="Remove"
                      tone="danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        askDelete(d);
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — the selected registration */}
        <ConsolePanel>
          {selected ? (
            <>
              <PanelHeader
                icon="heroicons-outline:squares-2x2"
                title={selected.name}
                actions={
                  manage ? (
                    <>
                      <IconButton
                        icon="heroicons-outline:pencil-square"
                        title="Edit"
                        onClick={() => openEdit(selected)}
                      />
                      <IconButton
                        icon="heroicons-outline:trash"
                        title="Remove"
                        onClick={() => askDelete(selected)}
                      />
                    </>
                  ) : undefined
                }
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                <div className="mb-3 flex items-center gap-2">
                  <CategoryChip slug={selected.category} />
                  <span className="text-[11px] text-nb-faint">
                    shows on the {categoryLabel(selected.category)} console
                  </span>
                </div>
                {selected.description && (
                  <p className="mb-4 text-[12.5px] leading-relaxed text-nb-muted">
                    {selected.description}
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-3 text-[12px]">
                  <Detail label="DashForge workspace" value={selected.workspace_ref} />
                  <Detail label="DashForge dashboard" value={selected.dashboard_ref} />
                </dl>
                <div className="mt-4">
                  <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-nb-muted">
                    Locked filters
                  </div>
                  {Object.keys(selected.scope || {}).length === 0 ? (
                    // Not a blank: an empty lock is a real and consequential
                    // state — every viewer of this dashboard sees every row it
                    // can reach — and reads as "not configured yet" unless said.
                    <p className="text-[11.5px] leading-relaxed text-nb-faint">
                      None. Every viewer of this dashboard sees every row it can reach.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {Object.entries(selected.scope).map(([k, v]) => (
                        <li key={k} className="font-mono text-[11.5px] text-nb-ink">
                          <span className="text-nb-blueb">{k}</span>={v}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          ) : (
            <EmptyPane
              icon="heroicons-outline:squares-2x2"
              title="No dashboard selected"
              subtitle={
                manage
                  ? "Pick one from the list, or use ＋ above to register one."
                  : "Pick one from the list to see where it points."
              }
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

      <DashboardForm
        open={formOpen}
        target={editTarget}
        defaultCategory={category ?? undefined}
        onClose={() => {
          setFormOpen(false);
          setEditTarget(null);
        }}
        onSaved={(row) => setSelectedId(row.id)}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </ConsolePage>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[11px] uppercase tracking-wide text-nb-muted">{label}</dt>
      <dd className="truncate font-mono text-[12px] text-nb-ink">{value}</dd>
    </div>
  );
}

function FilterChip({
  label,
  icon,
  count,
  on,
  onClick,
}: {
  label: string;
  icon?: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center gap-1 rounded-[7px] px-2 py-1 text-[11px] font-semibold transition-colors ${
        on
          ? "bg-nb-accent/15 text-nb-accent"
          : "text-nb-faint hover:bg-[rgba(255,255,255,.04)] hover:text-nb-ink"
      }`}
    >
      {icon && <Icon icon={icon} className="text-[12px]" />}
      {label}
      <span className="font-mono text-[10.5px] opacity-70">{count}</span>
    </button>
  );
}
