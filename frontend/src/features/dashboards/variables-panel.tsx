"use client";

// The DEFINITIONS editor behind the filter bar — what filters this dashboard
// offers and what variables it carries.
//
// PORTED in purpose from the reference's `variables-panel.tsx` (304 lines): a
// dialog listing the dashboard's variables, each with a name, a default, a
// control type and (for a dropdown) where its options come from.
//
// WHAT CHANGED, AND IT IS MOST OF IT
// ----------------------------------
// Theirs is a panel for authoring TEMPLATE PARAMETERS. Its help text tells you to
// write `{{name}}` into a widget's SQL, explains that values are SQL-quoted
// "unless marked raw", and offers a `raw` checkbox and a free-text `optionsQuery`
// per variable. Every one of those exists because the variable is destined for a
// string.
//
// Here a filter is bound to a DATASET DIMENSION picked from the registry, its
// options are that dimension's actual distinct values, and a variable is a named
// value a widget's filter references by name. So:
//
//   * no `raw` — there is no string to be raw in;
//   * no `optionsQuery` — the registry already answers "what values exist";
//   * no `{{…}}` anywhere in the copy, because there is no template.
//
// What is kept is the shape of the interaction, which is genuinely good: the
// definitions are a list you add to, each row is self-contained, and the panel
// closes onto a filter bar that immediately works.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Input, Modal, Select } from "@/components/ui/kit";

import { datasets as datasetsApi } from "./api";
import type { DashFilter, DashVariable, DashboardConfig } from "./dashboard-context";
import type { Dataset } from "./spec";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const slugId = (s: string) =>
  `f_${(s || "filter").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "filter"}`;

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-[1.4px] text-nb-muted">{title}</h3>
        <p className="mt-0.5 text-[11px] leading-snug text-nb-faint">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function RowShell({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-1.5 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] p-2">
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        className="mt-1 shrink-0 rounded-[6px] p-1 text-nb-faint transition-colors hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
      >
        <Icon icon="heroicons:x-mark" className="text-[13px]" />
      </button>
    </div>
  );
}

/** How many distinct values a dimension actually has right now. Shown beside a
 *  filter so an author picking `point_id` on a 300-point estate is told before
 *  they ship a dropdown nobody can use. */
function ValueCount({ dataset, column }: { dataset?: string; column?: string }) {
  const q = useQuery<any>({
    queryKey: ["ds-values", dataset, column],
    queryFn: () => datasetsApi.values(dataset!, column!),
    enabled: !!dataset && !!column,
    staleTime: 60_000,
    retry: false,
  });
  if (!dataset || !column) return null;
  if (q.isLoading) return <span className="text-[10.5px] text-nb-faint">counting values…</span>;
  const n = (q.data?.items || []).length;
  return (
    <span className="text-[10.5px] text-nb-faint">
      {n === 0
        ? "nothing has reported a value for this in the last week"
        : `${n} value${n === 1 ? "" : "s"} in the last week`}
    </span>
  );
}

export default function VariablesPanel({
  open,
  config,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  config: DashboardConfig;
  onClose: () => void;
  onSave: (next: DashboardConfig) => void;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState<DashboardConfig>({ filters: [], variables: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft({
      filters: (config.filters || []).map((f) => ({ ...f })),
      variables: (config.variables || []).map((v) => ({ ...v })),
      window: config.window ?? null,
    });
    setError(null);
  }, [open, config]);

  const dsQ = useQuery<{ items: Dataset[] }>({
    queryKey: ["bi-datasets"],
    queryFn: () => datasetsApi.list(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const allDatasets = dsQ.data?.items || [];
  const dsOptions = allDatasets.map((d) => ({ value: d.key, label: d.name }));
  const dimsOf = useMemo(
    () => (key?: string) =>
      (allDatasets.find((d) => d.key === key)?.dimensions || []).map((d) => ({
        value: d.key,
        label: d.label,
      })),
    [allDatasets],
  );

  const filters = draft.filters || [];
  const variables = draft.variables || [];

  const patchFilter = (i: number, patch: Partial<DashFilter>) =>
    setDraft((d) => ({ ...d, filters: (d.filters || []).map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const patchVariable = (i: number, patch: Partial<DashVariable>) =>
    setDraft((d) => ({
      ...d,
      variables: (d.variables || []).map((v, j) => (j === i ? { ...v, ...patch } : v)),
    }));

  const addFilter = () => {
    const ds = allDatasets[0];
    if (!ds) return;
    const dim = ds.dimensions[0];
    const base = slugId(dim?.label || "filter");
    let id = base;
    let n = 1;
    while (filters.some((f) => f.id === id)) id = `${base}_${++n}`;
    setDraft((d) => ({
      ...d,
      filters: [
        ...(d.filters || []),
        { id, label: dim?.label || "Filter", dataset: ds.key, column: dim?.key || "", op: "in", multi: true },
      ],
    }));
  };

  const addVariable = () => {
    const ds = allDatasets[0];
    let name = "site";
    let n = 1;
    while (variables.some((v) => v.name === name)) name = `site_${++n}`;
    setDraft((d) => ({
      ...d,
      variables: [
        ...(d.variables || []),
        {
          name,
          label: "Site",
          source: "dataset",
          dataset: ds?.key,
          column: ds?.dimensions[0]?.key,
          control: true,
        },
      ],
    }));
  };

  const validate = (): string | null => {
    for (const f of filters) {
      if (!f.column) return `Filter “${f.label || f.id}” needs a column.`;
      if (!f.dataset) return `Filter “${f.label || f.id}” needs a dataset.`;
    }
    if (new Set(filters.map((f) => f.id)).size !== filters.length) {
      return "Two filters share an id.";
    }
    for (const v of variables) {
      if (!NAME_RE.test(v.name)) {
        return `“${v.name}” is not a usable variable name — letters, digits and underscores, not starting with a digit.`;
      }
      if (v.source === "dataset" && !v.column) return `Variable “${v.name}” needs a column.`;
      if (v.source === "static" && !(v.options || []).length) {
        return `Variable “${v.name}” has no options.`;
      }
    }
    if (new Set(variables.map((v) => v.name)).size !== variables.length) {
      return "Two variables share a name.";
    }
    return null;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Filters & variables"
      subtitle="What this dashboard lets a viewer narrow. Values are bound as query parameters, never written into a query — a widget can opt out of any of them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            icon={saving ? "svg-spinners:180-ring" : "heroicons:check"}
            disabled={!!saving}
            onClick={() => {
              const issue = validate();
              setError(issue);
              if (!issue) onSave(draft);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Section
          title="Dashboard filters"
          hint="Applied to every widget over the same dataset, automatically. A widget whose dataset has no such column is left alone and says so."
        >
          {filters.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-[11.5px] text-nb-faint">
              No filters yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {filters.map((f, i) => (
                <RowShell
                  key={f.id}
                  onRemove={() =>
                    setDraft((d) => ({ ...d, filters: (d.filters || []).filter((_, j) => j !== i) }))
                  }
                >
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    <Input
                      label="Label"
                      value={f.label}
                      onChange={(e: any) => patchFilter(i, { label: e.target.value })}
                    />
                    <Select
                      label="Dataset"
                      value={f.dataset}
                      onChange={(e: any) =>
                        patchFilter(i, { dataset: e.target.value, column: dimsOf(e.target.value)[0]?.value || "" })
                      }
                      options={dsOptions}
                    />
                    <Select
                      label="Column"
                      value={f.column}
                      onChange={(e: any) => patchFilter(i, { column: e.target.value })}
                      options={dimsOf(f.dataset)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-[11px] text-nb-soft">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-nb-blue"
                        checked={f.multi !== false}
                        onChange={(e) =>
                          patchFilter(i, { multi: e.target.checked, op: e.target.checked ? "in" : "=" })
                        }
                      />
                      Allow several at once
                    </label>
                    <span className="font-mono text-[10px] text-nb-faint">id: {f.id}</span>
                    <ValueCount dataset={f.dataset} column={f.column} />
                  </div>
                </RowShell>
              ))}
            </div>
          )}
          <Button variant="ghost" icon="heroicons:plus" onClick={addFilter} disabled={!allDatasets.length}>
            Add filter
          </Button>
        </Section>

        <Section
          title="Variables"
          hint="A named value the page carries. A widget references one by name in its own filter, so one dashboard control can drive a condition only some widgets want. A variable is a VALUE — it cannot carry a column name or a fragment of a query, because nothing here is written into one."
        >
          {variables.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-[11.5px] text-nb-faint">
              No variables yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {variables.map((v, i) => (
                <RowShell
                  key={i}
                  onRemove={() =>
                    setDraft((d) => ({ ...d, variables: (d.variables || []).filter((_, j) => j !== i) }))
                  }
                >
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    <Input
                      label="Name"
                      hint="referenced by a widget filter"
                      value={v.name}
                      onChange={(e: any) => patchVariable(i, { name: e.target.value })}
                    />
                    <Input
                      label="Label"
                      value={v.label || ""}
                      onChange={(e: any) => patchVariable(i, { label: e.target.value })}
                    />
                    <Select
                      label="Values from"
                      value={v.source}
                      onChange={(e: any) => patchVariable(i, { source: e.target.value })}
                      options={[
                        { value: "dataset", label: "A dataset column" },
                        { value: "static", label: "A list I type" },
                        { value: "text", label: "Free text" },
                      ]}
                    />
                  </div>
                  {v.source === "dataset" ? (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      <Select
                        label="Dataset"
                        value={v.dataset || ""}
                        onChange={(e: any) =>
                          patchVariable(i, {
                            dataset: e.target.value,
                            column: dimsOf(e.target.value)[0]?.value || "",
                          })
                        }
                        options={dsOptions}
                      />
                      <Select
                        label="Column"
                        value={v.column || ""}
                        onChange={(e: any) => patchVariable(i, { column: e.target.value })}
                        options={dimsOf(v.dataset)}
                      />
                    </div>
                  ) : v.source === "static" ? (
                    <Input
                      label="Options"
                      hint="comma separated"
                      value={(v.options || []).map((o) => o.value).join(", ")}
                      onChange={(e: any) =>
                        patchVariable(i, {
                          options: e.target.value
                            .split(",")
                            .map((s: string) => s.trim())
                            .filter(Boolean)
                            .map((s: string) => ({ value: s, label: s })),
                        })
                      }
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-[11px] text-nb-soft">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-nb-blue"
                        checked={v.control !== false}
                        onChange={(e) => patchVariable(i, { control: e.target.checked })}
                      />
                      Show on the filter bar
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-nb-soft">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-nb-blue"
                        checked={!!v.multi}
                        onChange={(e) => patchVariable(i, { multi: e.target.checked })}
                      />
                      Allow several at once
                    </label>
                    {v.source === "dataset" ? <ValueCount dataset={v.dataset} column={v.column} /> : null}
                  </div>
                </RowShell>
              ))}
            </div>
          )}
          <Button variant="ghost" icon="heroicons:plus" onClick={addVariable} disabled={!allDatasets.length}>
            Add variable
          </Button>
        </Section>

        {error ? <p className="text-[11.5px] text-nb-crit">{error}</p> : null}
      </div>
    </Modal>
  );
}
