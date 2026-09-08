"use client";

// VMS → Linkage (P5-C). Event-automation rules that fire actions (record / notify
// / PTZ / output / popup) when a matching camera event arrives. Master/detail:
// LEFT a searchable rule list (Add + active/inactive counts in the header), RIGHT
// LinkageRuleDetail (trigger/scope/actions + active toggle). Editing runs through
// LinkageRuleModal. Mirrors the Sites config layout. Lives under Config → Linkage.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/kit";
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
} from "@/components/console";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import type { LinkageRuleCreate, LinkageRulePublic } from "./types";
import LinkageRuleListItem from "./components/LinkageRuleListItem";
import LinkageRuleDetail from "./components/LinkageRuleDetail";
import LinkageRuleModal from "./components/LinkageRuleModal";

export default function LinkageRulesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<LinkageRulePublic | null | undefined>(undefined); // undefined=closed, null=new, obj=edit
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ rule: LinkageRulePublic } | null>(null); // { rule } or null
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["vms-linkage-rules"],
    queryFn: () => vms.linkage.list({ limit: 200 }),
  });
  const rules = useMemo<LinkageRulePublic[]>(() => (q.data ? asItems(q.data) : []), [q.data]);

  const activeCount = rules.filter((r) => r.is_active).length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rules;
    return rules.filter((r) => r.name?.toLowerCase().includes(term));
  }, [rules, search]);

  // The explicit choice, or the first row when there is none. Derived here
  // rather than synced by an effect, which rendered one frame with nothing
  // selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;

  const selected = useMemo(() => rules.find((r) => r.id === effectiveId) || null, [rules, effectiveId]);


  const saveMut = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: LinkageRuleCreate }) =>
      id ? vms.linkage.update(id, body) : vms.linkage.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule saved");
      setEditing(undefined);
      setSaveError(null);
    },
    onError: (e) => setSaveError(apiError(e, "Failed to save rule")),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => vms.linkage.update(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] }),
    onError: (e) => toast.error(apiError(e, "Failed to update rule")),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => vms.linkage.remove(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["vms-linkage-rules"] });
      toast.success("Rule deleted");
      if (effectiveId === id) setSelectedId(null);
      setConfirm(null);
    },
    onError: (e) => toast.error(apiError(e, "Failed to delete rule")),
  });

  const openNew = () => {
    setSaveError(null);
    setEditing(null);
  };

  return (
    <ConsolePage>
      <ConsoleGrid>
        {/* LEFT — the rules */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:bolt"
            title="Linkage"
            count={rules.length}
            actions={
              <>
                <PanelCounts
                  items={[
                    { tone: "good", value: activeCount, label: "active" },
                    { tone: "idle", value: rules.length - activeCount, label: "inactive" },
                  ]}
                />
                <IconButton icon="heroicons:plus" title="New rule" onClick={openNew} />
              </>
            }
          />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search rules…" />
          <PanelList
            loading={q.isLoading}
            // A failed load must never read as "no rules yet" — an estate with no
            // automation and one whose automation could not be listed are opposite
            // situations.
            error={q.isError ? apiError(q.error, "Failed to load rules") : undefined}
            empty={filtered.length === 0}
            emptyText={
              search.trim()
                ? "No matches — try a different keyword."
                : "No linkage rules yet. Use ＋ above to create one."
            }
          >
            {filtered.map((r) => (
              <LinkageRuleListItem
                key={r.id}
                rule={r}
                selected={r.id === effectiveId}
                onSelect={() => setSelectedId(r.id)}
              />
            ))}
          </PanelList>
        </ConsolePanel>

        {/* RIGHT — the selected rule. ConsolePanel FILLS the row: the old hand-rolled
            section sized to its content, so the empty state was a short box floating
            in a half-height pane. */}
        <ConsolePanel>
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
            <EmptyPane
              icon="heroicons-outline:bolt"
              title="No rule selected"
              subtitle="Pick one from the list, or use ＋ above to create a rule."
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

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
                onConfirm: () => delMut.mutate(confirm.rule.id),
              }
            : null
        }
        onClose={() => setConfirm(null)}
        pending={delMut.isPending}
      />
    </ConsolePage>
  );
}
