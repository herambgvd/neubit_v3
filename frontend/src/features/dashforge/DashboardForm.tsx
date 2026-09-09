"use client";

// The registration form — create and edit in one modal, because the fields are
// identical and two near-copies drift.
//
// A registration records a POINTER: which DashForge dashboard, what to call it
// here, which console shows it, and which filter values are locked into the
// embed token's signature. Nothing about the dashboard's content is stored —
// layout, widgets and queries live in DashForge, and a copy here would drift.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Input, Modal, Select, Textarea } from "@/components/ui/kit";
import { apiError } from "@/lib/api";

import { dashforge, type DashForgeEmbed } from "./api";
import { CATEGORIES, DEFAULT_CATEGORY } from "./constants";

// `scope` is entered as plain `name=value` lines rather than JSON because it is a
// short list of filter bindings, and because a JSON textarea makes a typo a parse
// error instead of a missing lock.
//
// NeuBit does NOT validate the names: the lockable set is the DashForge
// dashboard's own global-filter control variables, which this platform has no
// view of. DashForge refuses an unlockable name at mint with a message naming it,
// and that message is surfaced verbatim — checking here would mean guessing, and
// a guess that says "fine" when DashForge says "no" is worse than no check.
export function parseScope(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function formatScope(scope: Record<string, string> | null | undefined): string {
  return Object.entries(scope || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export interface DashboardFormProps {
  open: boolean;
  /** The row being edited, or null to register a new one. */
  target: DashForgeEmbed | null;
  /** Preselected category for a new row — the tab the operator was standing on. */
  defaultCategory?: string;
  onClose: () => void;
  onSaved?: (row: DashForgeEmbed) => void;
}

export default function DashboardForm({
  open,
  target,
  defaultCategory,
  onClose,
  onSaved,
}: DashboardFormProps) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [workspaceRef, setWorkspaceRef] = useState("");
  const [dashboardRef, setDashboardRef] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reload the form whenever it OPENS or the target changes. Without the `open`
  // dependency, closing an edit and reopening create leaves the previous row's
  // ids in the boxes, and a second registration of the same dashboard is the
  // 409 that follows.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(target?.name ?? "");
    setDescription(target?.description ?? "");
    setCategory(target?.category ?? defaultCategory ?? DEFAULT_CATEGORY);
    setWorkspaceRef(target?.workspace_ref ?? "");
    setDashboardRef(target?.dashboard_ref ?? "");
    setScopeText(formatScope(target?.scope));
  }, [open, target, defaultCategory]);

  const save = useMutation({
    mutationFn: (): Promise<DashForgeEmbed> => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        category,
        workspace_ref: workspaceRef.trim(),
        dashboard_ref: dashboardRef.trim(),
        scope: parseScope(scopeText),
      };
      return target ? dashforge.update(target.id, body) : dashforge.register(body);
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["dashforge"] });
      toast.success(target ? "Dashboard updated" : "Dashboard registered");
      onSaved?.(row);
      onClose();
    },
    onError: (e) =>
      setError(apiError(e, target ? "Could not save that dashboard" : "Could not register that dashboard")),
  });

  const incomplete = !name.trim() || !workspaceRef.trim() || !dashboardRef.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={target ? "Edit dashboard" : "Register a dashboard"}
      subtitle="Records a pointer and a name. The dashboard itself stays in DashForge."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={incomplete || save.isPending}
          >
            {save.isPending ? "Saving…" : target ? "Save changes" : "Register"}
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
          hint="What operators call it here. Independent of its title in DashForge on purpose — a rename on either side should not silently change the other's navigation."
        />
        <Select
          label="Category"
          required
          value={category}
          onChange={(e: any) => setCategory(e.target.value)}
          options={CATEGORIES.map((c) => ({ value: c.slug, label: c.label }))}
        />
        <Textarea
          label="Description"
          rows={2}
          value={description}
          onChange={(e: any) => setDescription(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="DashForge workspace id"
            required
            value={workspaceRef}
            onChange={(e: any) => setWorkspaceRef(e.target.value)}
          />
          <Input
            label="DashForge dashboard id"
            required
            value={dashboardRef}
            onChange={(e: any) => setDashboardRef(e.target.value)}
          />
        </div>
        <Textarea
          label="Locked filters"
          rows={3}
          placeholder="site_id=42"
          value={scopeText}
          onChange={(e: any) => setScopeText(e.target.value)}
        />
        <p className="text-[11px] leading-relaxed text-nb-faint">
          One <span className="font-mono">name=value</span> per line. These are baked into the embed
          token&apos;s signature: a viewer can neither change one nor widen the view by leaving it
          out. Only a dashboard&apos;s global-filter controls can be locked, and DashForge refuses
          to mint if a widget&apos;s query ignores the lock — so an empty box means every viewer of
          this dashboard sees every row it can reach.
        </p>
        {error && <p className="text-[11.5px] text-nb-crit">{error}</p>}
      </div>
    </Modal>
  );
}
