"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CornerDownLeft,
  Search,
  UserCircle,
} from "lucide-react";

import { adminApi } from "@/lib/api";
import { cn } from "@/lib/cn";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Global ⌘K command palette + search. Blends quick-nav (pages + actions) with a
 * live search across tenants and users. Fully keyboard-driven: ↑/↓ to move, ↵ to
 * run, Esc to close (Esc handled by Radix). Server stays authoritative — this is
 * purely a navigation/UX layer.
 */
export function CommandPalette({ open, onOpenChange, navItems = [], actions = [] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  // Reset each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setActive(0);
    }
  }, [open]);

  // Debounce the search term so we don't hammer the API on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(id);
  }, [query]);

  const searching = debounced.length >= 1;

  const tenantsQ = useQuery({
    queryKey: ["cmd", "tenants", debounced],
    queryFn: () => adminApi.listTenants({ q: debounced, pageSize: 6 }),
    enabled: open && searching,
    staleTime: 30_000,
  });
  const usersQ = useQuery({
    queryKey: ["cmd", "users", debounced],
    queryFn: () => adminApi.listUsers({ q: debounced, pageSize: 6 }),
    enabled: open && searching,
    staleTime: 30_000,
  });

  const go = useCallback(
    (href) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router]
  );

  // Build the flat, ordered list of runnable items (also grouped for display).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s) => !q || (s || "").toLowerCase().includes(q);

    const nav = navItems
      .filter((n) => match(n.label))
      .map((n) => ({
        id: `nav:${n.href}`,
        label: n.label,
        hint: "Page",
        Icon: n.icon,
        run: () => go(n.href),
      }));

    const acts = actions
      .filter((a) => match(a.label))
      .map((a) => ({
        id: `act:${a.id}`,
        label: a.label,
        hint: "Action",
        Icon: a.icon,
        run: () => {
          onOpenChange(false);
          a.run();
        },
      }));

    const tenants = searching
      ? normalize(tenantsQ.data).map((t) => ({
          id: `tenant:${t.id}`,
          label: t.name,
          sub: t.slug,
          Icon: Building2,
          run: () => go(`/tenants/${t.id}`),
        }))
      : [];

    const users = searching
      ? normalize(usersQ.data).map((u) => ({
          id: `user:${u.id}`,
          label: u.full_name || u.email,
          sub: u.tenant_name ? `${u.email} · ${u.tenant_name}` : u.email,
          Icon: UserCircle,
          // No standalone user page — land on their tenant (or the directory).
          run: () => go(u.tenant_id ? `/tenants/${u.tenant_id}` : "/users"),
        }))
      : [];

    return [
      { key: "nav", label: "Navigation", items: nav },
      { key: "actions", label: "Actions", items: acts },
      { key: "tenants", label: "Tenants", items: tenants },
      { key: "users", label: "Users", items: users },
    ].filter((g) => g.items.length > 0);
  }, [navItems, actions, query, searching, tenantsQ.data, usersQ.data, go, onOpenChange]);

  // Flatten for index-based keyboard navigation.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Keep the active index in range as results change.
  useEffect(() => {
    setActive((a) => (flat.length === 0 ? 0 : Math.min(a, flat.length - 1)));
  }, [flat.length]);

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-cmd-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[active]?.run();
    }
  }

  const loading = searching && (tenantsQ.isLoading || usersQ.isLoading);
  let runningIndex = -1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/70 backdrop-blur-sm" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 animate-command-in overflow-hidden rounded-2xl border border-card-border bg-card shadow-2xl shadow-black/50 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search tenants and users, or jump to a page. Use arrow keys and Enter.
          </DialogPrimitive.Description>

          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-card-border px-4">
            <Search className="h-4 w-4 shrink-0 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tenants, users, or jump to a page…"
              className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
              role="combobox"
              aria-expanded="true"
              aria-controls="cmd-list"
              aria-activedescendant={flat[active] ? `cmd-opt-${active}` : undefined}
            />
            {loading && (
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-card-border border-t-accent" />
            )}
          </div>

          {/* Results */}
          <div ref={listRef} id="cmd-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
            {flat.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-muted">
                {searching && !loading ? "No results found." : "Type to search…"}
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.key} className="mb-1">
                  <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {g.label}
                  </div>
                  <div className="space-y-0.5">
                    {g.items.map((it) => {
                      runningIndex += 1;
                      const idx = runningIndex;
                      const isActive = idx === active;
                      const Icon = it.Icon;
                      return (
                        <button
                          key={it.id}
                          id={`cmd-opt-${idx}`}
                          data-cmd-index={idx}
                          role="option"
                          aria-selected={isActive}
                          onMouseMove={() => setActive(idx)}
                          onClick={() => it.run()}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                            isActive ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
                          )}
                        >
                          {Icon && <Icon className="h-4 w-4 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate text-foreground">{it.label}</span>
                          {it.sub && <span className="truncate text-xs text-muted">{it.sub}</span>}
                          {it.hint && !it.sub && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                              {it.hint}
                            </span>
                          )}
                          {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center gap-4 border-t border-card-border px-4 py-2 text-[11px] text-muted">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> select</span>
            <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-card-border bg-hover px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
