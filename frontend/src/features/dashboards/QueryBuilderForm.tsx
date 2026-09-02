"use client";

// The VISUAL QUERY BUILDER.
//
// PORTED from the standalone product's
// `app/(main)/(app)/dashboards/[id]/_components/query-builder-form.tsx`. What came
// across is the interaction design, which is the good part: a SELECT list of
// column-or-measure rows each with its own aggregate and alias, a WHERE list with
// an operator vocabulary and an AND/OR combinator, an explicit GROUP BY, HAVING,
// ORDER BY referencing a select item by index, and a LIMIT. That is a real query
// builder rather than four dropdowns, and it is what makes the same form able to
// build a chart over readings, over door events, or over whatever a domain
// registers next.
//
// THREE THINGS CHANGED, ALL DELIBERATE
// ------------------------------------
// 1. **It picks from a DATASET, not from a database.** Theirs lists the tables
//    and columns of a datasource and lets the user join them: it is a BI tool
//    pointed at somebody's warehouse. Here the choices come from the registry —
//    a dataset's published dimensions and measures — so a person is offered
//    "Door name" and "Events", never `access_events_1h.event_count`, and the
//    joins are declared once by the dataset instead of assembled per widget.
//
// 2. **It generates nothing.** Theirs calls `generateBuilderSQL(state)` on every
//    keystroke and writes the SQL into the widget. This form only edits STATE;
//    the server generates and returns the statement, which is shown read-only
//    under the preview. That is builder contract §3, and it is also why fixing a
//    generator bug fixes widgets saved before the fix.
//
// 3. **It steers on the honesty rules.** An aggregate a measure does not permit
//    is not offered. A value aggregate over incomparable series is called out in
//    words with what to do instead, rather than being discovered as a 422.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Input, Select } from "@/components/ui/kit";
import { Segmented } from "@/components/console";

import { datasets as datasetsApi } from "./api";
import type { DashboardConfig } from "./dashboard-context";
import {
  AGGREGATE_LABEL,
  FILTER_OP_LABEL,
  NO_VALUE_OPS,
  dimensionOf,
  measureOf,
} from "./spec";
import type {
  Aggregate,
  Dataset,
  Filter,
  FilterOp,
  Having,
  SelectItem,
  SpecQuery,
} from "./spec";

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[1.3px] text-nb-faint">
        {children}
      </span>
      {hint ? <span className="truncate text-[10px] text-nb-faint/70">{hint}</span> : null}
    </div>
  );
}

function Row({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex items-end gap-1.5">
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-1.5">
        {children}
      </div>
      {onRemove ? (
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          className="mb-0.5 shrink-0 rounded-[6px] p-1 text-nb-faint transition-colors hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
        >
          <Icon icon="heroicons:x-mark" className="text-[13px]" />
        </button>
      ) : null}
    </div>
  );
}

/** The distinct values of a dimension, for a filter's value box. Loaded lazily —
 *  only for the column a filter actually names — so opening the editor does not
 *  scan every dimension in the dataset. */
function ValueInput({
  dataset,
  filter,
  onChange,
  variableNames,
}: {
  dataset: string;
  filter: Filter;
  onChange: (patch: Partial<Filter>) => void;
  /** Names of the dashboard's variables. A filter can take its value from one
   *  instead of from a literal — which is what lets one control on the page drive
   *  a condition on only the widgets that want it. */
  variableNames: string[];
}) {
  const dim = filter.column;
  const q = useQuery<any>({
    queryKey: ["ds-values", dataset, dim],
    queryFn: () => datasetsApi.values(dataset, dim),
    enabled: !!dim && !NO_VALUE_OPS.includes(filter.op),
    staleTime: 60_000,
    retry: false,
  });
  const items: { value: string | null; count: number }[] = q.data?.items || [];

  if (NO_VALUE_OPS.includes(filter.op)) {
    return <div className="text-[10.5px] leading-[30px] text-nb-faint">no value needed</div>;
  }
  if (filter.variable) {
    // Bound to a dashboard variable. What it resolves to is decided on the
    // server, so there is nothing to type here — and nothing is substituted:
    // the NAME is a dictionary key, the VALUE it yields is a bind parameter.
    return (
      <Select
        value={filter.variable}
        onChange={(e: any) =>
          onChange(
            e.target.value
              ? { variable: e.target.value }
              : { variable: null, value: "", values: [] },
          )
        }
        options={[
          { value: "", label: "Use a fixed value instead…" },
          ...variableNames.map((n) => ({ value: n, label: `Variable: ${n}` })),
        ]}
      />
    );
  }
  if (filter.op === "in") {
    // A multi-select would be a bigger component than this earns; a comma list is
    // what the reference uses and it round-trips cleanly.
    return (
      <Input
        placeholder="value, value, …"
        value={(filter.values || []).join(", ")}
        onChange={(e: any) =>
          onChange({
            values: e.target.value
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean),
          })
        }
      />
    );
  }
  if (filter.op === "between") {
    return (
      <div className="flex gap-1.5">
        <Input
          placeholder="from"
          value={(filter.value as any) ?? ""}
          onChange={(e: any) => onChange({ value: e.target.value })}
        />
        <Input
          placeholder="to"
          value={(filter.value2 as any) ?? ""}
          onChange={(e: any) => onChange({ value2: e.target.value })}
        />
      </div>
    );
  }
  if (items.length && filter.op === "=") {
    return (
      <Select
        value={(filter.value as any) ?? ""}
        onChange={(e: any) => onChange({ value: e.target.value })}
        placeholder="Select a value…"
        options={items.map((it) => ({
          // A NULL value is a real answer — "the rows nothing has classified" —
          // so it is offered rather than dropped from the list.
          value: it.value === null ? "" : String(it.value),
          label: `${it.value === null ? "(none)" : it.value} · ${it.count}`,
        }))}
      />
    );
  }
  return (
    <Input
      placeholder="value"
      value={(filter.value as any) ?? ""}
      onChange={(e: any) => onChange({ value: e.target.value })}
    />
  );
}

export default function QueryBuilderForm({
  ds,
  query,
  onChange,
  config,
}: {
  ds: Dataset;
  query: SpecQuery;
  onChange: (patch: Partial<SpecQuery>) => void;
  /** The DASHBOARD's filters and variables, when this widget is being edited on
   *  a page that has any. Two things depend on it: a filter can take its value
   *  from a variable instead of a literal, and the widget can opt out of the
   *  page's filters one at a time. Absent when a widget is edited outside a
   *  dashboard — the section simply does not render. */
  config?: DashboardConfig;
}) {
  const [showAdvanced, setShowAdvanced] = useState(
    (query.having || []).length > 0 || (query.group_by || []).length > 1,
  );

  const variableNames = (config?.variables || []).map((v) => v.name);
  const dashFilters = (config?.filters || []).filter((f) => f.dataset === ds.key);
  const dimOptions = ds.dimensions.map((d) => ({ value: d.key, label: d.label }));
  const measureOptions = ds.measures.map((m) => ({ value: m.key, label: m.label }));
  const select = query.select || [];
  const filters = query.filters || [];

  // A comparison needs something to BE a change in; the backend refuses a
  // dimensions-only comparison, so the control is disabled rather than offering
  // a request that will 400.
  const hasMeasure = select.some((s) => !!s.measure);

  const patchSelect = (i: number, patch: Partial<SelectItem>) =>
    onChange({ select: select.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const setSelectSource = (i: number, raw: string) => {
    // One dropdown lists both, prefixed, because "what goes in this column" is
    // one decision. The state keeps them apart, as the backend requires.
    if (raw.startsWith("m:")) {
      const key = raw.slice(2);
      const m = measureOf(ds, key);
      patchSelect(i, { dimension: null, measure: key, aggregate: m?.aggregates[0] });
    } else {
      patchSelect(i, { measure: null, aggregate: null, dimension: raw.slice(2) });
    }
  };

  return (
    <div className="space-y-3.5">
      {/* ── SELECT ─────────────────────────────────────────────────────── */}
      <div>
        <FieldLabel hint={query.time_series ? "the measure each line draws" : "the columns to show"}>
          Show
        </FieldLabel>
        <div className="space-y-1.5">
          {select.map((item, i) => {
            const m = measureOf(ds, item.measure);
            return (
              <Row
                key={i}
                onRemove={
                  select.length > 1
                    ? () =>
                        onChange({
                          select: select.filter((_, j) => j !== i),
                          // An ordering that pointed past the end would silently
                          // stop applying; drop it rather than leave it dangling.
                          order_by: (query.order_by || []).filter((o) => o.select_index !== i),
                        })
                    : undefined
                }
              >
                <Select
                  value={item.measure ? `m:${item.measure}` : `d:${item.dimension}`}
                  onChange={(e: any) => setSelectSource(i, e.target.value)}
                  options={[
                    ...measureOptions.map((o) => ({ value: `m:${o.value}`, label: o.label })),
                    ...dimOptions.map((o) => ({ value: `d:${o.value}`, label: o.label })),
                  ]}
                />
                {item.measure ? (
                  <Select
                    value={item.aggregate || ""}
                    onChange={(e: any) => patchSelect(i, { aggregate: e.target.value as Aggregate })}
                    // ONLY what the dataset permits. A measure that must not be
                    // summed says so in the registry, and the option is simply
                    // not here — the rule is shown, not discovered as an error.
                    options={(m?.aggregates || []).map((a) => ({
                      value: a,
                      label: AGGREGATE_LABEL[a],
                    }))}
                  />
                ) : (
                  <div className="text-[10.5px] leading-[30px] text-nb-faint">grouped</div>
                )}
                <Input
                  placeholder="column name (optional)"
                  value={item.alias || ""}
                  onChange={(e: any) => patchSelect(i, { alias: e.target.value || null })}
                />
              </Row>
            );
          })}
        </div>
        {!query.time_series ? (
          <Button
            variant="ghost"
            className="mt-1.5"
            icon="heroicons:plus"
            onClick={() =>
              onChange({
                select: [
                  ...select,
                  { measure: ds.measures[0]?.key, aggregate: ds.measures[0]?.aggregates[0] },
                ],
              })
            }
          >
            Add column
          </Button>
        ) : null}
      </div>

      {/* ── split / group ──────────────────────────────────────────────── */}
      {query.time_series ? (
        <Select
          label="Split into series by"
          hint="one line per distinct value"
          value={query.series_by || ""}
          onChange={(e: any) => {
            const key = e.target.value || null;
            onChange({
              series_by: key,
              // Keep the legend readable: if the split key is an id and the
              // dataset names a label dimension, carry it.
              series_label:
                key && ds.defaults.label_dimension && ds.defaults.label_dimension !== key
                  ? ds.defaults.label_dimension
                  : null,
              band: key ? query.band : false,
            });
          }}
          options={[{ value: "", label: "One line (no split)" }, ...dimOptions]}
        />
      ) : (
        <div>
          <FieldLabel hint="one row per distinct combination">Group by</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {ds.dimensions.map((d) => {
              const on = (query.group_by || []).includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() =>
                    onChange({
                      group_by: on
                        ? (query.group_by || []).filter((k) => k !== d.key)
                        : [...(query.group_by || []), d.key],
                    })
                  }
                  className={`rounded-[7px] border px-2 py-1 text-[11px] transition ${
                    on
                      ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                      : "border-nb-line text-nb-faint hover:text-nb-muted"
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── WHERE ──────────────────────────────────────────────────────── */}
      <div>
        <FieldLabel hint={filters.length > 1 ? undefined : "narrow what is counted"}>
          <span className="inline-flex items-center gap-2">
            Filters
            {filters.length > 1 ? (
              <Segmented
                value={query.filter_combinator || "AND"}
                onChange={(v: any) => onChange({ filter_combinator: v })}
                options={[
                  { value: "AND", label: "all" },
                  { value: "OR", label: "any" },
                ]}
              />
            ) : null}
          </span>
        </FieldLabel>
        <div className="space-y-1.5">
          {filters.map((f, i) => (
            <Row
              key={i}
              onRemove={() => onChange({ filters: filters.filter((_, j) => j !== i) })}
            >
              <Select
                value={f.column}
                onChange={(e: any) =>
                  onChange({
                    filters: filters.map((x, j) =>
                      j === i ? { ...x, column: e.target.value, value: null, values: [] } : x,
                    ),
                  })
                }
                options={dimOptions}
              />
              <Select
                value={f.op}
                onChange={(e: any) =>
                  onChange({
                    filters: filters.map((x, j) =>
                      j === i ? { ...x, op: e.target.value as FilterOp } : x,
                    ),
                  })
                }
                options={(Object.keys(FILTER_OP_LABEL) as FilterOp[]).map((op) => ({
                  value: op,
                  label: FILTER_OP_LABEL[op],
                }))}
              />
              <ValueInput
                dataset={ds.key}
                filter={f}
                variableNames={variableNames}
                onChange={(patch) =>
                  onChange({
                    filters: filters.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  })
                }
              />
            </Row>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button
            variant="ghost"
            icon="heroicons:plus"
            onClick={() =>
              onChange({
                filters: [
                  ...filters,
                  { column: ds.dimensions[0]?.key || "", op: "=", value: "" },
                ],
              })
            }
          >
            Add filter
          </Button>
          {variableNames.length ? (
            <Button
              variant="ghost"
              icon="heroicons:variable"
              onClick={() =>
                onChange({
                  filters: [
                    ...filters,
                    {
                      column: ds.dimensions[0]?.key || "",
                      op: "=",
                      variable: variableNames[0],
                    },
                  ],
                })
              }
            >
              Filter by a variable
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── the DASHBOARD's filters, and opting out of them ─────────────── */}
      {config && (dashFilters.length > 0 || config.window) ? (
        <div>
          <FieldLabel hint="applied by the page, not by this widget">
            Dashboard filters
          </FieldLabel>
          <div className="space-y-1 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] p-2">
            {dashFilters.map((f) => {
              const off =
                !!query.ignore_all_filters || (query.ignore_filters || []).includes(f.id);
              return (
                <label
                  key={f.id}
                  className="flex items-center gap-2 text-[11.5px] text-nb-soft"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-nb-blue"
                    checked={!off}
                    disabled={!!query.ignore_all_filters}
                    onChange={(e) =>
                      onChange({
                        ignore_filters: e.target.checked
                          ? (query.ignore_filters || []).filter((k) => k !== f.id)
                          : [...(query.ignore_filters || []), f.id],
                      })
                    }
                  />
                  Follow “{f.label || f.column}”
                </label>
              );
            })}
            <label className="flex items-center gap-2 text-[11.5px] text-nb-soft">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-nb-blue"
                checked={!!query.ignore_all_filters}
                onChange={(e) => onChange({ ignore_all_filters: e.target.checked })}
              />
              Ignore every dashboard filter
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-nb-soft">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-nb-blue"
                checked={!!query.ignore_window}
                onChange={(e) => onChange({ ignore_window: e.target.checked })}
              />
              Keep this widget&apos;s own time window
            </label>
            <p className="pt-0.5 text-[10.5px] leading-snug text-nb-faint">
              A widget that opts out says so on its own footer, so a viewer is
              never left wondering why one tile did not move.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── period-over-period ─────────────────────────────────────────── */}
      <Select
        label="Compare with"
        hint={
          hasMeasure
            ? "the same query over an earlier, equal-length window"
            : "needs a measure — there is nothing for a dimension to be a change in"
        }
        value={query.compare?.period || ""}
        disabled={!hasMeasure}
        onChange={(e: any) => {
          const period = e.target.value;
          onChange({ compare: period ? { period: period as any } : null });
        }}
        options={[
          { value: "", label: "Nothing — show this period only" },
          { value: "previous", label: "The previous period (same length)" },
          { value: "day", label: "The same window a day earlier" },
          { value: "week", label: "The same window a week earlier" },
        ]}
      />
      {query.compare ? (
        <p className="-mt-1 text-[10.5px] leading-snug text-nb-faint">
          Both periods are the same length and the offset is exact, so the buckets
          line up. A group with no row in the earlier period shows no change at all
          rather than a fall of 100% — and if the earlier window has nothing in it,
          the widget says so instead of drawing a flat line.
        </p>
      ) : null}

      {/* ── ordering + limit ───────────────────────────────────────────── */}
      {!query.time_series ? (
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Sort by"
            value={
              (query.order_by || []).length
                ? `${query.order_by![0].select_index}:${query.order_by![0].dir}`
                : ""
            }
            onChange={(e: any) => {
              const raw = e.target.value;
              if (!raw) return onChange({ order_by: [] });
              const [idx, dir] = raw.split(":");
              onChange({ order_by: [{ select_index: Number(idx), dir: dir as "asc" | "desc" }] });
            }}
            options={[
              { value: "", label: "Unsorted" },
              ...select.flatMap((s, i) => {
                const name =
                  s.alias ||
                  (s.measure ? measureOf(ds, s.measure)?.label : dimensionOf(ds, s.dimension)?.label) ||
                  `column ${i + 1}`;
                return [
                  { value: `${i}:desc`, label: `${name} — high to low` },
                  { value: `${i}:asc`, label: `${name} — low to high` },
                ];
              }),
            ]}
          />
          <Input
            label="Rows"
            type="number"
            min={1}
            max={200}
            value={query.limit}
            onChange={(e: any) =>
              onChange({ limit: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Lines"
            hint="At most 24 — a chart with more is unreadable and slow."
            type="number"
            min={1}
            max={24}
            value={query.limit}
            onChange={(e: any) =>
              onChange({ limit: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })
            }
          />
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-[11.5px] text-nb-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-nb-blue"
              disabled={!query.series_by || query.limit !== 1}
              checked={!!query.band}
              onChange={(e) => onChange({ band: e.target.checked })}
            />
            {/* The band is MEASURED by the server from the same buckets, not
                inferred in the browser. One series only: overlaid bands on six
                lines are unreadable. */}
            Show min–max band (one line only)
          </label>
        </div>
      )}

      {/* ── HAVING: real, but folded away ──────────────────────────────── */}
      {!query.time_series ? (
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-[10.5px] uppercase tracking-[1.2px] text-nb-faint hover:text-nb-muted"
          >
            {showAdvanced ? "− " : "+ "}Conditions on the totals
          </button>
          {showAdvanced ? (
            <div className="mt-1.5 space-y-1.5">
              {(query.having || []).map((h, i) => (
                <Row
                  key={i}
                  onRemove={() =>
                    onChange({ having: (query.having || []).filter((_, j) => j !== i) })
                  }
                >
                  <Select
                    value={`${h.measure}:${h.aggregate}`}
                    onChange={(e: any) => {
                      const [measure, aggregate] = e.target.value.split(":");
                      onChange({
                        having: (query.having || []).map((x, j) =>
                          j === i ? { ...x, measure, aggregate: aggregate as Aggregate } : x,
                        ),
                      });
                    }}
                    options={ds.measures.flatMap((m) =>
                      m.aggregates.map((a) => ({
                        value: `${m.key}:${a}`,
                        label: `${AGGREGATE_LABEL[a]} of ${m.label}`,
                      })),
                    )}
                  />
                  <Select
                    value={h.op}
                    onChange={(e: any) =>
                      onChange({
                        having: (query.having || []).map((x, j) =>
                          j === i ? { ...x, op: e.target.value as FilterOp } : x,
                        ),
                      })
                    }
                    options={([">", ">=", "<", "<=", "=", "!="] as FilterOp[]).map((op) => ({
                      value: op,
                      label: FILTER_OP_LABEL[op],
                    }))}
                  />
                  <Input
                    type="number"
                    value={(h.value as any) ?? ""}
                    onChange={(e: any) =>
                      onChange({
                        having: (query.having || []).map((x, j) =>
                          j === i ? { ...x, value: Number(e.target.value) } : x,
                        ),
                      })
                    }
                  />
                </Row>
              ))}
              <Button
                variant="ghost"
                icon="heroicons:plus"
                onClick={() =>
                  onChange({
                    having: [
                      ...(query.having || []),
                      {
                        measure: ds.measures[0]?.key || "",
                        aggregate: (ds.measures[0]?.aggregates[0] || "sum") as Aggregate,
                        op: ">",
                        value: 0,
                      } as Having,
                    ],
                  })
                }
              >
                Add condition
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
