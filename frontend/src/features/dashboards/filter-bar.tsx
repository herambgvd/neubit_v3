"use client";

// The dashboard FILTER BAR — one page, many scopes.
//
// PORTED in shape from the reference's `filter-bar.tsx` (248 lines) and
// `filter-pills.tsx` (35): a row of controls above the canvas, one per filter the
// dashboard declares, a Reset when anything is narrowed, and the chosen values
// reflected as pills so what the page is showing is legible at a glance.
//
// WHAT CHANGED. Theirs loads a select's options by running a stored
// `optionsQuery` against a datasource — free SQL, authored per filter. Ours reads
// the dataset registry's `/bi/datasets/{key}/values`, which already exists and is
// already bounded, so a filter's options are the values the store actually holds
// with a count beside each. Nobody types a query to populate a dropdown.
//
// And the values go nowhere near a query string: see `dashboard-context.ts`.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Segmented } from "@/components/console";

import { datasets as datasetsApi } from "./api";
import { WINDOW_CHOICES } from "./dashboard-context";
import type { DashFilter, DashVariable, DashboardContextState } from "./dashboard-context";

interface Option {
  value: string;
  label: string;
}

/** A dimension's distinct values, for one control. Lazy and cached — a bar with
 *  four filters is four bounded reads, once, not one per widget. */
function useDimensionOptions(dataset?: string, column?: string, enabled = true) {
  return useQuery<{ items: { value: string | null; count: number }[] }>({
    queryKey: ["ds-values", dataset, column],
    queryFn: () => datasetsApi.values(dataset!, column!),
    enabled: !!dataset && !!column && enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A multi-select that stays a plain button and a popover — the console has no
 *  combobox primitive and a filter bar does not earn one. */
function ValuePicker({
  label,
  options,
  chosen,
  multi,
  loading,
  onChange,
}: {
  label: string;
  options: Option[];
  chosen: string[];
  multi?: boolean;
  loading?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const shown = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const summary = chosen.length === 0 ? "All" : chosen.length === 1 ? chosen[0] : `${chosen.length} selected`;

  const toggle = (value: string) => {
    if (!multi) {
      onChange(chosen[0] === value ? [] : [value]);
      setOpen(false);
      return;
    }
    onChange(chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value]);
  };

  return (
    <div className="relative">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[30px] min-w-[132px] max-w-[220px] items-center gap-1.5 rounded-[8px] border px-2.5 text-[11.5px] transition ${
          chosen.length
            ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.14)] text-nb-blueb"
            : "border-nb-line bg-[rgba(6,11,26,.5)] text-nb-soft hover:border-nb-line2"
        }`}
      >
        <span className="truncate">{summary}</span>
        <Icon icon="heroicons:chevron-down" className="ml-auto shrink-0 text-[12px]" />
      </button>

      {open ? (
        <>
          {/* Click-away. A filter bar that traps focus in a popover is worse than
              one that closes when you look elsewhere. */}
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-30 mt-1 max-h-64 w-[240px] overflow-y-auto rounded-[10px] border border-nb-line2 bg-[rgba(8,15,34,.98)] p-1.5 shadow-xl">
            {options.length > 8 ? (
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="mb-1 w-full rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.6)] px-2 py-1 text-[11.5px] text-nb-ink outline-none placeholder:text-nb-faint focus:border-nb-line2"
              />
            ) : null}
            <button
              type="button"
              onClick={() => {
                onChange([]);
                if (!multi) setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[11.5px] ${
                chosen.length === 0 ? "text-nb-blueb" : "text-nb-soft hover:bg-[rgba(150,180,245,.08)]"
              }`}
            >
              All
            </button>
            {loading ? (
              <div className="px-2 py-2 text-[11px] text-nb-faint">Loading values…</div>
            ) : shown.length === 0 ? (
              // ABSENCE, not an empty dropdown pretending to be a working one.
              <div className="px-2 py-2 text-[11px] leading-snug text-nb-faint">
                Nothing has reported a value for this in the last week.
              </div>
            ) : (
              shown.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={`flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[11.5px] ${
                    chosen.includes(o.value)
                      ? "bg-[rgba(96,165,250,.16)] text-nb-blueb"
                      : "text-nb-soft hover:bg-[rgba(150,180,245,.08)]"
                  }`}
                >
                  {multi ? (
                    <Icon
                      icon={chosen.includes(o.value) ? "heroicons:check-circle" : "heroicons:stop"}
                      className="shrink-0 text-[13px]"
                    />
                  ) : null}
                  <span className="truncate">{o.label}</span>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function FilterControl({ filter, state }: { filter: DashFilter; state: DashboardContextState }) {
  const q = useDimensionOptions(filter.dataset, filter.column);
  const options: Option[] = (q.data?.items || [])
    // A NULL is a real answer — "the rows nothing has classified" — but it cannot
    // be carried in a URL param as itself, so it is offered only where the value
    // has a spelling. Dropping it silently would be worse; it is simply not
    // representable here, and the widget's own `is empty` filter still expresses it.
    .filter((it) => it.value !== null)
    .map((it) => ({ value: String(it.value), label: `${it.value} · ${it.count}` }));

  return (
    <ValuePicker
      label={filter.label || filter.column}
      options={options}
      chosen={state.values.filters[filter.id] || []}
      multi={filter.multi || filter.op === "in"}
      loading={q.isLoading}
      onChange={(next) => state.setFilter(filter.id, next)}
    />
  );
}

function VariableControl({ variable, state }: { variable: DashVariable; state: DashboardContextState }) {
  const fromDataset = variable.source === "dataset";
  const q = useDimensionOptions(variable.dataset, variable.column, fromDataset);
  const chosen = state.values.variables[variable.name] || [];

  if (variable.source === "text") {
    return (
      <div>
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
          {variable.label || variable.name}
        </span>
        <input
          value={chosen[0] ?? ""}
          onChange={(e) => state.setVariable(variable.name, e.target.value ? [e.target.value] : [])}
          placeholder="Any"
          className="h-[30px] w-[150px] rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2.5 text-[11.5px] text-nb-ink outline-none placeholder:text-nb-faint focus:border-nb-line2"
        />
      </div>
    );
  }

  const options: Option[] = fromDataset
    ? (q.data?.items || [])
        .filter((it) => it.value !== null)
        .map((it) => ({ value: String(it.value), label: `${it.value} · ${it.count}` }))
    : (variable.options || []).map((o) => ({ value: o.value, label: o.label || o.value }));

  return (
    <ValuePicker
      label={variable.label || variable.name}
      options={options}
      chosen={chosen}
      multi={variable.multi}
      loading={fromDataset && q.isLoading}
      onChange={(next) => state.setVariable(variable.name, next)}
    />
  );
}

/** The chosen values, as removable pills. The reference's `filter-pills.tsx`,
 *  serving the same purpose: the controls say what you CAN narrow, the pills say
 *  what you HAVE. On a page with six controls those are different questions. */
function Pills({ state }: { state: DashboardContextState }) {
  const items: { key: string; label: string; value: string; clear: () => void }[] = [];
  for (const f of state.config.filters || []) {
    const chosen = state.values.filters[f.id] || [];
    if (chosen.length) {
      items.push({
        key: `f:${f.id}`,
        label: f.label || f.column,
        value: chosen.join(", "),
        clear: () => state.setFilter(f.id, []),
      });
    }
  }
  for (const v of state.config.variables || []) {
    const chosen = state.values.variables[v.name] || [];
    if (chosen.length) {
      items.push({
        key: `v:${v.name}`,
        label: v.label || v.name,
        value: chosen.join(", "),
        clear: () => state.setVariable(v.name, []),
      });
    }
  }
  if (!items.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <span
          key={it.key}
          className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-2.5 py-0.5 text-[11px] text-nb-blueb"
        >
          <span className="shrink-0 text-nb-faint">{it.label}</span>
          <span className="truncate">{it.value}</span>
          <button
            type="button"
            onClick={it.clear}
            aria-label={`Clear ${it.label}`}
            className="shrink-0 text-nb-blueb/70 hover:text-nb-ink"
          >
            <Icon icon="heroicons:x-mark" className="text-[12px]" />
          </button>
        </span>
      ))}
    </div>
  );
}

export default function FilterBar({
  state,
  onEditVariables,
}: {
  state: DashboardContextState;
  /** Present only in edit mode — a viewer changes values, an author changes what
   *  values there are to change. */
  onEditVariables?: () => void;
}) {
  const filters = state.config.filters || [];
  const controls = (state.config.variables || []).filter((v) => v.control !== false);
  const nothing = filters.length === 0 && controls.length === 0;

  if (nothing && !onEditVariables) return null;

  return (
    <div className="mb-2.5 shrink-0 space-y-2 rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-3">
        <span className="flex items-center gap-1.5 self-center text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
          <Icon icon="heroicons:adjustments-horizontal" className="text-[14px]" />
          Filters
        </span>

        {filters.map((f) => (
          <FilterControl key={f.id} filter={f} state={state} />
        ))}
        {controls.map((v) => (
          <VariableControl key={v.name} variable={v} state={state} />
        ))}

        <div>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
            Window
          </span>
          <Segmented
            value={String(state.values.windowHours ?? "")}
            onChange={(v: string) => state.setWindowHours(v ? Number(v) : null)}
            options={[
              { value: "", label: "Per widget" },
              ...WINDOW_CHOICES.map((w) => ({ value: String(w.hours), label: w.label })),
            ]}
          />
        </div>

        <div className="ml-auto flex items-center gap-2 self-center">
          {state.active ? (
            <button
              type="button"
              onClick={state.clear}
              className="text-[11px] text-nb-faint transition hover:text-nb-ink"
            >
              Reset
            </button>
          ) : null}
          {onEditVariables ? (
            <button
              type="button"
              onClick={onEditVariables}
              className="flex items-center gap-1 rounded-[7px] border border-nb-line px-2 py-1 text-[11px] text-nb-faint transition hover:border-nb-line2 hover:text-nb-ink"
            >
              <Icon icon="heroicons:variable" className="text-[13px]" />
              Filters &amp; variables
            </button>
          ) : null}
        </div>
      </div>

      {nothing ? (
        <p className="text-[11px] leading-snug text-nb-faint">
          This dashboard has no filters yet. Add one and every widget over the same
          dataset follows it — individual widgets can opt out.
        </p>
      ) : (
        <Pills state={state} />
      )}
    </div>
  );
}
