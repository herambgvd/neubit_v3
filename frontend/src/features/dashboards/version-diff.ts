// Structural diff of two dashboard SNAPSHOTS.
//
// PORTED from the reference's `lib/dashboard/version-diff.ts` (251 lines) and it
// is the closest port in this whole phase, because the design is right: flatten
// each side into a leaf map keyed by dotted path, compare the leaves, and group
// the result into added / removed / changed with per-field old→new. No React, no
// I/O, so it stays testable on its own.
//
// WHAT CHANGED
// ------------
// * **Snapshots are objects, not JSON strings.** Theirs stores `widgetsJSON`,
//   `layoutJSON`, `variablesJSON` — three separately-parsed strings that can
//   disagree about which widgets exist. Ours is one object the server built from
//   the live rows, so geometry travels WITH its widget and there is nothing to
//   parse defensively.
// * **`spec.*` is diffed as leaves, so a change reads as a change.** A widget
//   whose measure went from `avg` to `sum` shows `spec.query.select.0.aggregate:
//   avg → sum`, not "the spec object changed". That is the whole reason somebody
//   opens a diff, and it is what makes storing STATE rather than SQL pay off
//   here too: a stored SQL string would diff as one enormous unreadable leaf.
// * **Arrays of objects are indexed rather than compared whole.** Theirs treats
//   any array as a single leaf, so adding one filter to a widget renders as the
//   entire filter list old→new. Indexing them means one added filter reads as one
//   added line.
// * The dashboard-level fields (name, grid, config) are diffed unconditionally,
//   because our snapshot always carries them.

export interface FieldChange {
  /** Dotted path: `title`, `x`, `spec.query.limit`, `spec.options.format.unit`. */
  field: string;
  from: unknown;
  to: unknown;
}

export interface WidgetSummary {
  id: string;
  title: string;
  viz?: string;
}

export interface WidgetChange extends WidgetSummary {
  changes: FieldChange[];
}

export interface DashboardSnapshot {
  name?: string;
  description?: string | null;
  grid_cols?: number;
  row_height?: number;
  config?: Record<string, unknown>;
  widgets?: {
    id: string;
    title?: string;
    spec?: any;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }[];
}

export interface DashboardDiff {
  widgetsAdded: WidgetSummary[];
  widgetsRemoved: WidgetSummary[];
  widgetsChanged: WidgetChange[];
  dashboardChanges: FieldChange[];
  hasChanges: boolean;
  /** Total field-level changes, for the "12 changes" summary line. */
  count: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Flatten into leaves keyed by dotted path.
 *
 *  Objects recurse. ARRAYS recurse by index when they hold objects — a widget's
 *  filters, its select items — so one added filter is one added line rather than
 *  the whole list rewritten. An array of scalars stays a single leaf, because
 *  `group_by: [a, b]` → `[b, a]` reads better as one change than as two. */
function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (Array.isArray(value) && value.some(isPlainObject)) {
    value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  if (value !== undefined) out[prefix] = value;
}

const valueEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

function diffLeaves(from: Record<string, unknown>, to: Record<string, unknown>): FieldChange[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changes: FieldChange[] = [];
  for (const field of keys) {
    if (!valueEqual(from[field], to[field])) changes.push({ field, from: from[field], to: to[field] });
  }
  changes.sort((a, b) => a.field.localeCompare(b.field));
  return changes;
}

function widgetLeaves(w: NonNullable<DashboardSnapshot["widgets"]>[number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const { id: _id, ...rest } = w;
  void _id;
  flatten(rest, "", out);
  return out;
}

const widgetTitle = (w: { title?: string; id: string }) => (w.title || "").trim() || w.id;

const summarise = (w: NonNullable<DashboardSnapshot["widgets"]>[number]): WidgetSummary => ({
  id: w.id,
  title: widgetTitle(w),
  viz: typeof w.spec?.viz === "string" ? w.spec.viz : undefined,
});

/** `from` is the OLDER side, `to` the newer — so every change reads old → new. */
export function diffSnapshots(from: DashboardSnapshot, to: DashboardSnapshot): DashboardDiff {
  const fromById = new Map((from.widgets || []).filter((w) => w?.id).map((w) => [w.id, w]));
  const toById = new Map((to.widgets || []).filter((w) => w?.id).map((w) => [w.id, w]));

  const widgetsAdded: WidgetSummary[] = [];
  const widgetsRemoved: WidgetSummary[] = [];
  const widgetsChanged: WidgetChange[] = [];

  for (const [id, w] of toById) if (!fromById.has(id)) widgetsAdded.push(summarise(w));
  for (const [id, w] of fromById) if (!toById.has(id)) widgetsRemoved.push(summarise(w));
  for (const [id, toW] of toById) {
    const fromW = fromById.get(id);
    if (!fromW) continue;
    const changes = diffLeaves(widgetLeaves(fromW), widgetLeaves(toW));
    if (changes.length) widgetsChanged.push({ ...summarise(toW), changes });
  }

  const dashLeaves = (s: DashboardSnapshot) => {
    const out: Record<string, unknown> = {};
    flatten(
      {
        name: s.name,
        description: s.description ?? null,
        grid_cols: s.grid_cols,
        row_height: s.row_height,
        config: s.config || {},
      },
      "",
      out,
    );
    return out;
  };
  const dashboardChanges = diffLeaves(dashLeaves(from), dashLeaves(to));

  const count =
    widgetsAdded.length +
    widgetsRemoved.length +
    widgetsChanged.reduce((n, w) => n + w.changes.length, 0) +
    dashboardChanges.length;

  return {
    widgetsAdded,
    widgetsRemoved,
    widgetsChanged,
    dashboardChanges,
    hasChanges: count > 0,
    count,
  };
}

/** Render one side of a change. `—` for absent, so "added" and "set to empty
 *  string" do not look the same. */
export function formatDiffValue(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** A dotted path in words. `spec.query.select.0.aggregate` is precise and it is
 *  also not what anybody wants to read, so the leading noise is dropped and the
 *  parts a person recognises are kept. */
export function fieldLabel(field: string): string {
  return field
    .replace(/^spec\.query\./, "")
    .replace(/^spec\./, "")
    .replace(/\.(\d+)\./g, " #$1 ")
    .replace(/\.(\d+)$/, " #$1")
    .replace(/\./g, " · ");
}
