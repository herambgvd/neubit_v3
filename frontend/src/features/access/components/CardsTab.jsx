"use client";

// Cards on a single instance. Ported from neubit_v2's cards-tab.jsx: toolbar
// (search by card code + status filter + New), table with status pill, resolved
// "Assigned To" cardholder name, description, edit/delete (delete blocked while Used).
//
// v3 difference: the mirror list takes only skip/limit, so card-code search + status
// filter run client-side. The write path id is the controller UID (dds_uid) → card_id.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { gates } from "../api";
import { CARD_STATUS_FILTERS, CARD_STATUS_TONE } from "../constants";
import CardModal from "./CardModal";

const cardId = (c) => idOf(c, "dds_uid", "card_id", "id");

export default function CardsTab({ instanceId }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const q = useQuery({
    queryKey: ["ac-cards", instanceId],
    queryFn: () => gates.cards.list(instanceId, { limit: 500 }),
    enabled: !!instanceId,
  });
  const all = useMemo(() => asItems(q.data), [q.data]);

  const items = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (!term) return true;
      return String(c.card_code || "").toLowerCase().includes(term);
    });
  }, [all, search, statusFilter]);

  const chQ = useQuery({
    queryKey: ["ac-cardholders", instanceId],
    queryFn: () => gates.cardholders.list(instanceId, { limit: 500 }),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
  const cardholderById = useMemo(
    () => Object.fromEntries(asItems(chQ.data).map((ch) => [ch.cardholder_id, ch])),
    [chQ.data],
  );

  const remove = useMutation({
    mutationFn: (id) => gates.cards.remove(instanceId, id),
    onSuccess: () => {
      toast.success("Card removed");
      qc.invalidateQueries({ queryKey: ["ac-cards", instanceId] });
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
        <Icon icon="heroicons-outline:credit-card" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Cards</span>
        <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">{items.length}</span>

        <div className="relative ml-2">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by card code"
            className="w-56 rounded-md border border-field bg-transparent py-1 pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
          {CARD_STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value} className="bg-card">
              Status: {s.label}
            </option>
          ))}
        </select>

        <div className="ml-auto">
          <Button variant="success" icon="heroicons-outline:plus" className="!px-2.5 !py-1 !text-[11px]" onClick={() => setCreateOpen(true)}>
            New card
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
            <p className="font-medium">Failed to load cards</p>
            <p className="mt-1 opacity-90">{apiError(q.error, "Unknown error")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icon icon="heroicons-outline:credit-card" className="mb-2 text-2xl text-muted" />
            <p className="text-xs text-muted">No cards</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-hover">
              <tr>
                <th className={th}>Card Code</th>
                <th className={th}>Status</th>
                <th className={th}>Assigned To</th>
                <th className={th}>Description</th>
                <th className={`${th} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {items.map((c, idx) => {
                const ch = c.cardholder_uid ? cardholderById[c.cardholder_uid] : null;
                return (
                  <tr key={cardId(c) || c.card_code || `card-${idx}`} className="hover:bg-hover/50">
                    <td className="px-3 py-2 font-mono text-foreground">{c.card_code || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase ${CARD_STATUS_TONE[c.status] || CARD_STATUS_TONE.Free}`}>
                        {c.status || "Free"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {ch ? ch.name || ch.employee_id || shortId(c.cardholder_uid) : c.cardholder_uid ? <span className="font-mono">{shortId(c.cardholder_uid)}</span> : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{c.description || "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditTarget(c)}
                          title="Edit"
                          className="rounded p-1 text-muted hover:bg-hover hover:text-foreground"
                        >
                          <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                        </button>
                        <button
                          type="button"
                          disabled={c.status === "Used"}
                          title={c.status === "Used" ? "Cannot delete a card in use" : "Delete"}
                          onClick={() =>
                            setConfirm({
                              title: "Delete card",
                              message: `Remove card ${c.card_code}? This will also delete it on the upstream controller.`,
                              confirmLabel: "Delete",
                              onConfirm: () => {
                                remove.mutate(cardId(c));
                                setConfirm(null);
                              },
                            })
                          }
                          className="rounded p-1 text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
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

      {createOpen && <CardModal instanceId={instanceId} onClose={() => setCreateOpen(false)} onSuccess={() => setCreateOpen(false)} />}
      {editTarget && (
        <CardModal instanceId={instanceId} card={editTarget} onClose={() => setEditTarget(null)} onSuccess={() => setEditTarget(null)} />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}

function shortId(id) {
  if (!id) return "—";
  return String(id).length > 10 ? `${String(id).slice(0, 10)}…` : id;
}
