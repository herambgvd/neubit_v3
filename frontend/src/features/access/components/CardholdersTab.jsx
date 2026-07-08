"use client";

// Cardholders for the selected instance. Ported from neubit_v2's cardholders-tab.jsx:
// toolbar (search + status + access-group filters + New), a table with status pill,
// access-group count, and per-row suspend/reinstate/edit/delete actions.
//
// v3 difference: the mirror list endpoint takes only skip/limit, so search + status +
// group filters are applied client-side here (v2 sent them as query params).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import { CARDHOLDER_STATUS, CARDHOLDER_STATUS_FILTERS } from "../constants";
import CardholderModal from "./CardholderModal";

export default function CardholdersTab({ instanceId }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [editTarget, setEditTarget] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const groupsQ = useQuery({
    queryKey: ["ac-access-groups", instanceId],
    queryFn: () => gates.accessGroups.list(instanceId),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
  const groups = asItems(groupsQ.data);

  const q = useQuery({
    queryKey: ["ac-cardholders", instanceId],
    queryFn: () => gates.cardholders.list(instanceId, { limit: 500 }),
    enabled: !!instanceId,
  });
  const all = useMemo(() => asItems(q.data), [q.data]);

  const items = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((h) => {
      if (statusFilter && h.status !== statusFilter) return false;
      if (groupFilter && !(h.access_groups || []).includes(groupFilter)) return false;
      if (!term) return true;
      return [h.name, h.employee_id, h.email, h.first_name, h.last_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [all, search, statusFilter, groupFilter]);

  const suspend = useMutation({
    mutationFn: (id) => gates.cardholders.suspend(instanceId, id),
    onSuccess: () => {
      toast.success("Cardholder suspended");
      qc.invalidateQueries({ queryKey: ["ac-cardholders", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Suspend failed")),
  });
  const reinstate = useMutation({
    mutationFn: (id) => gates.cardholders.reinstate(instanceId, id),
    onSuccess: () => {
      toast.success("Cardholder reinstated");
      qc.invalidateQueries({ queryKey: ["ac-cardholders", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Reinstate failed")),
  });
  const remove = useMutation({
    mutationFn: (id) => gates.cardholders.remove(instanceId, id),
    onSuccess: () => {
      toast.success("Cardholder removed");
      qc.invalidateQueries({ queryKey: ["ac-cardholders", instanceId] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted";
  const selectCls =
    "rounded-md border border-field bg-transparent px-2 py-1 text-[11px] text-muted outline-none focus:border-muted";

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:users" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Cardholders</span>
        <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{items.length}</span>

        <div className="relative ml-2">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / employee id / email"
            className="w-64 rounded-md border border-field bg-transparent py-1 pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
          {CARDHOLDER_STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value} className="bg-card">
              Status: {s.label}
            </option>
          ))}
        </select>

        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className={selectCls}>
          <option value="" className="bg-card">
            All groups
          </option>
          {groups.map((g) => (
            <option key={g.group_id} value={g.group_id} className="bg-card">
              {g.name}
            </option>
          ))}
        </select>

        <div className="ml-auto">
          <Button variant="success" icon="heroicons-outline:plus" className="!px-2.5 !py-1 !text-[11px]" onClick={() => setCreateOpen(true)}>
            New cardholder
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
          </div>
        ) : q.isError ? (
          <div className="mx-2 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
            <p className="font-medium">Failed to load cardholders</p>
            <p className="mt-1 opacity-90">{apiError(q.error, "Unknown error")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icon icon="heroicons-outline:users" className="mb-2 text-2xl text-muted" />
            <p className="text-xs text-muted">No cardholders</p>
            <p className="text-[11px] text-muted/70">Create one and assign it to an access group.</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-hover">
              <tr>
                <th className={th}>Name</th>
                <th className={th}>ID Number</th>
                <th className={th}>Status</th>
                <th className={th}>Access</th>
                <th className={`${th} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {items.map((h) => {
                const sd = CARDHOLDER_STATUS[h.status] || CARDHOLDER_STATUS.expired;
                return (
                  <tr key={h.cardholder_id} className="hover:bg-hover/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{h.name}</div>
                      {h.email && <div className="text-[10px] text-muted">{h.email}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted">{h.employee_id || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${sd.cls}`}>
                        {sd.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">{(h.access_groups || []).length}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        {h.status === "suspended" ? (
                          <button
                            type="button"
                            onClick={() => reinstate.mutate(h.cardholder_id)}
                            title="Reinstate"
                            className="rounded p-1 text-emerald-500 hover:bg-emerald-500/10"
                          >
                            <Icon icon="heroicons-outline:play-circle" className="text-sm" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => suspend.mutate(h.cardholder_id)}
                            title="Suspend"
                            className="rounded p-1 text-amber-500 hover:bg-amber-500/10"
                          >
                            <Icon icon="heroicons-outline:user-minus" className="text-sm" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditTarget(h)}
                          title="Edit"
                          className="rounded p-1 text-muted hover:bg-hover hover:text-foreground"
                        >
                          <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirm({
                              title: "Delete cardholder",
                              message: `Permanently remove ${h.name}? Cards held by this user will be unassigned.`,
                              confirmLabel: "Delete",
                              onConfirm: () => {
                                remove.mutate(h.cardholder_id);
                                setConfirm(null);
                              },
                            })
                          }
                          title="Delete"
                          className="rounded p-1 text-red-500 hover:bg-red-500/10"
                        >
                          <Icon icon="heroicons-outline:trash" className="text-sm" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <CardholderModal instanceId={instanceId} onClose={() => setCreateOpen(false)} onSuccess={() => setCreateOpen(false)} />
      )}
      {editTarget && (
        <CardholderModal
          instanceId={instanceId}
          cardholder={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => setEditTarget(null)}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
