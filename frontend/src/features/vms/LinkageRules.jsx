"use client";

// VMS → Linkage (P5-C). Event-automation rules that fire actions (record / notify
// / PTZ / output / popup) when a matching camera event arrives. Master/detail:
// LEFT a searchable rule list (Add + active/inactive counts in the header), RIGHT
// LinkageRuleDetail (trigger/scope/actions + active toggle). Editing runs through
// LinkageRuleModal. Mirrors the Sites config layout. Lives under Config → Linkage.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import LinkageRuleListItem from "./components/LinkageRuleListItem";
import LinkageRuleDetail from "./components/LinkageRuleDetail";
import LinkageRuleModal from "./components/LinkageRuleModal";

export default function LinkageRulesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [saveError, setSaveError] = useState(null);
  const [confirm, setConfirm] = useState(null); // { rule } or null
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const q = useQuery({
    queryKey: ["vms-linkage-rules"],
    queryFn: () => vms.linkage.list({ limit: 200 }),
  });
  const rules = useMemo(() => asItems(q.data), [q.data]);

  const activeCount = rules.filter((r) => r.is_active).length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rules;
    return rules.filter((r) => r.name?.toLowerCase().includes(term));
  }, [rules, search]);

  const selected = useMemo(() => rules.find((r) => r.id === selectedId) || null, [rules, selectedId]);

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const saveMut = useMutation({
    mutationFn: ({ id, body }) => (id ? vms.linkage.update(id, body) : vms.linkage.create(body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule saved");
      setEditing(undefined);
      setSaveError(null);
    },
    onError: (e) => setSaveError(apiError(e, "Failed to save rule")),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }) => vms.linkage.update(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] }),
    onError: (e) => toast.error(apiError(e, "Failed to update rule")),
  });

  const delMut = useMutation({
    mutationFn: (id) => vms.linkage.remove(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule deleted");
      if (selectedId === id) setSelectedId(null);
      setConfirm(null);
    },
    onError: (e) => toast.error(apiError(e, "Failed to delete rule")),
  });

  const openNew = () => {
    setSaveError(null);
    setEditing(null);
  };

  const listActions = (
    <button
      onClick={openNew}
      title="New rule"
      className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
    >
      <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        aside={
          <ListPanel
            title="Linkage"
            count={rules.length}
            action={listActions}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search rules…"
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span className="text-muted">{activeCount} active</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                <span className="text-muted">{rules.length - activeCount} inactive</span>
              </span>
            </div>

            {q.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : q.isError ? (
              <div className="px-4 py-6 text-center text-xs text-red-500">
                {apiError(q.error, "Failed to load rules")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:bolt" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {search.trim() ? "No matches" : "No linkage rules yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {search.trim() ? "Try a different keyword." : "Click Add to create your first rule."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((r) => (
                  <LinkageRuleListItem
                    key={r.id}
                    rule={r}
                    selected={r.id === selectedId}
                    onSelect={() => setSelectedId(r.id)}
                  />
                ))}
              </ul>
            )}
          </ListPanel>
        }
      >
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-full flex flex-col">
          {selected ? (
            <LinkageRuleDetail
              key={selected.id}
              rule={selected}
              onToggle={(v) => toggleMut.mutate({ id: selected.id, is_active: v })}
              onClose={() => setSelectedId(null)}
              onEdit={() => {
                setSaveError(null);
                setEditing(selected);
              }}
              onDelete={() => setConfirm({ rule: selected })}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:bolt" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No rule selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add</b> to create a new rule.
              </div>
            </div>
          )}
        </section>
      </MasterDetail>

      <LinkageRuleModal
        open={editing !== undefined}
        rule={editing || null}
        onClose={() => {
          setEditing(undefined);
          setSaveError(null);
        }}
        onSave={(body) => saveMut.mutate({ id: editing?.id, body })}
        saving={saveMut.isPending}
        error={saveError}
      />

      <ConfirmDialog
        state={
          confirm
            ? {
                title: "Delete linkage rule",
                message: `Delete "${confirm.rule.name}"? This can't be undone.`,
                confirmLabel: "Delete",
                tone: "danger",
                onConfirm: () => delMut.mutate(confirm.rule.id),
              }
            : null
        }
        onClose={() => setConfirm(null)}
        pending={delMut.isPending}
      />
    </div>
  );
}
