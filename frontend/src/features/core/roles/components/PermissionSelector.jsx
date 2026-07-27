"use client";

// Grouped permission picker used inside the role form. Renders each catalog
// category as a card with a check-all/uncheck-all toggle and per-permission
// checkboxes. Read-only when viewing a system role.
import { Icon } from "@iconify/react";

import { EmptyState, Spinner } from "@/components/ui/kit";

export default function PermissionSelector({ groups, selected, loading, readOnly, count, onToggleKey, onToggleGroup }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-nb-soft">Permissions</span>
        <span className="text-xs font-mono text-nb-faint">{count} selected</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !Object.keys(groups).length ? (
        <EmptyState title="No permissions available" />
      ) : (
        <div className="space-y-4">
          {Object.entries(groups).map(([category, perms]) => {
            const total = perms.length;
            const chosen = perms.filter((p) => selected.has(p.key)).length;
            const allOn = total > 0 && chosen === total;
            return (
              <div
                key={category}
                className="rounded-[12px] border border-nb-line overflow-hidden"
              >
                <div className="flex items-center justify-between bg-[rgba(96,165,250,.08)] px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-nb-ink">
                      {category}
                    </span>
                    <span className="text-xs font-mono text-nb-faint">
                      {chosen}/{total}
                    </span>
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => onToggleGroup(perms, !allOn)}
                      className="text-xs font-medium text-nb-blueb hover:underline"
                    >
                      {allOn ? "Uncheck all" : "Check all"}
                    </button>
                  )}
                </div>
                <div className="divide-y divide-nb-line/60">
                  {perms.map((p) => {
                    const on = selected.has(p.key);
                    return (
                      <label
                        key={p.key}
                        className={`flex items-start gap-3 px-4 py-2.5 ${
                          readOnly ? "cursor-default" : "cursor-pointer hover:bg-[rgba(96,165,250,.06)]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={readOnly}
                          onChange={() => onToggleKey(p.key)}
                          className="mt-0.5 h-4 w-4 rounded border-nb-line text-nb-blue focus:ring-nb-line bg-[rgba(6,11,26,.5)]"
                        />
                        <div className="min-w-0">
                          <div className="text-sm text-nb-ink">{p.label}</div>
                          {p.description && (
                            <div className="text-xs text-nb-soft mt-0.5">{p.description}</div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
