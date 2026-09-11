"use client";

// THE USER PICKER — one copy, previously two.
//
// It lived twice, identically: once in TriggerForm and once in TransitionModal,
// with a comment in each saying it was "also mirrored" in the other. That comment
// is the tell — somebody knew, and knowing is not a control. A search box, a chip
// list and a user query are not hard to keep in step by hand until one of them
// gains a fix and the other does not.
//
// It reads the user list itself rather than taking one as a prop: both callers
// wanted every user in the tenant, and a picker that fetches what it shows cannot
// be handed a list that disagrees with its own search.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { checkboxClass } from "@/components/ui/kit";
import { api } from "@/lib/api";
import type { Page } from "@/lib/types";
import { asItems } from "@/lib/format";
import type { AssignableUser } from "../types";

/** A user's id, and the best name to show for them — the two facts every row of
 *  this picker needs, and the reason a bare `u.full_name` is not enough: an invited
 *  account has an email and no name yet. */
const uid = (u: AssignableUser): string => u.id;
const display = (u: AssignableUser): string => u.full_name || u.email || uid(u);

export interface UserMultiSelectProps {
  label: ReactNode;
  selectedIds: string[];
  onToggle: (userId: string) => void;
  onClear: () => void;
}

/* Multi-select user picker with search — selected chips on top + searchable
 * list. 1:1 port of the v2 UserMultiSelect (also mirrored in TransitionModal). */
export default function UserMultiSelect({ label, selectedIds, onToggle, onClear }: UserMultiSelectProps) {
  const [query, setQuery] = useState("");
  const usersQ = useQuery({
    queryKey: ["auth-users-picker"],
    queryFn: () => api.get<Page<AssignableUser>>("/auth/users", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const allUsers = useMemo<AssignableUser[]>(() => (usersQ.data ? asItems(usersQ.data) : []), [usersQ.data]);


  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) =>
      `${u.email || ""} ${display(u)}`.toLowerCase().includes(q),
    );
  }, [allUsers, query]);
  const selectedUsers = useMemo(() => allUsers.filter((u) => selectedIds.includes(uid(u))), [allUsers, selectedIds]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-faint">{label}</div>
        <div className="flex items-center gap-2 text-[11px] text-nb-faint">
          <Icon icon="heroicons-outline:users" className="text-sm" />
          {selectedIds.length} selected
          {selectedIds.length > 0 && (
            <button type="button" onClick={onClear} className="hover:text-nb-ink hover:underline">clear</button>
          )}
        </div>
      </div>

      {selectedUsers.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedUsers.map((u) => (
            <span key={uid(u)} className="inline-flex items-center gap-1 rounded-full border border-[rgba(96,165,250,.30)] bg-[rgba(96,165,250,.10)] px-2.5 py-1 text-xs text-nb-blueb">
              {display(u)}
              <button type="button" onClick={() => onToggle(uid(u))} aria-label={`Remove ${display(u)}`}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-nb-line bg-[rgba(8,15,34,.5)]">
        <label className="relative block border-b border-nb-line">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nb-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users by name or email…" className="h-9 w-full bg-transparent pl-7 pr-3 text-xs text-nb-ink outline-hidden" />
        </label>
        <div className="max-h-40 overflow-y-auto">
          {usersQ.isLoading ? (
            <div className="px-3 py-3 text-xs text-nb-faint">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-nb-faint">No users match &quot;{query}&quot;.</div>
          ) : (
            <ul className="divide-y divide-nb-line">
              {filtered.map((u) => {
                const checked = selectedIds.includes(uid(u));
                return (
                  <li key={uid(u)}>
                    <label className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${checked ? "bg-[rgba(96,165,250,.10)]" : "hover:bg-[rgba(96,165,250,.1)]"}`}>
                      <input type="checkbox" checked={checked} onChange={() => onToggle(uid(u))} className={checkboxClass} />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-nb-ink truncate">{display(u)}</span>
                        {u.email && display(u) !== u.email && (
                          <span className="block text-[10px] text-nb-faint truncate">{u.email}</span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
