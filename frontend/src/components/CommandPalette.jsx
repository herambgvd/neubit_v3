"use client";

import { Icon } from "@iconify/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { menuItems, configTabs, deviceTabs, streamTabs } from "@/config/menu";
import { useAuth } from "@/lib/auth";

// Human labels for the entity groups the /search endpoint returns (keyed by its
// `type`). Anything unmapped falls back to a capitalised, pluralised type.
const ENTITY_GROUPS = {
  user: "Users",
  role: "Roles",
};

function groupLabel(type) {
  return ENTITY_GROUPS[type] || `${type.charAt(0).toUpperCase()}${type.slice(1)}s`;
}

// Flatten the nav into a list of {title, link, icon, perm} entries the palette can offer
// as "Pages". Disabled placeholders (unbuilt features) and section entries (no own link)
// are dropped; the Config + Devices sub-tabs are hoisted so their pages are searchable too.
function navPages() {
  const out = [];
  for (const item of menuItems) {
    if (item.disabled || item.section || !item.link) continue;
    out.push(item);
  }
  for (const t of [...configTabs, ...deviceTabs, ...streamTabs]) {
    if (t.disabled || !t.link) continue;
    out.push(t);
  }
  out.push({ title: "My account", link: "/account", icon: "heroicons-outline:user-circle" });
  return out;
}

export default function CommandPalette() {
  const router = useRouter();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Global ⌘K / Ctrl-K toggle.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    function onOpen() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener("palette:open", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("palette:open", onOpen);
    };
  }, []);

  // Reset each time the palette opens.
  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setLoading(false);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const pages = useMemo(
    () => navPages().filter((p) => !p.perm || can(p.perm)),
    [can]
  );

  // Debounced entity search (users, roles). Server stays authoritative — this is
  // purely a navigation/UX layer.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/search", { params: { q: term } });
        setResults(data.results || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const pageMatches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return pages;
    return pages.filter((p) => p.title.toLowerCase().includes(term));
  }, [q, pages]);

  // Build the ordered, grouped list of runnable items: Pages first, then one group
  // per entity type the search returned (Users, Roles, …).
  const groups = useMemo(() => {
    const gs = [];

    if (pageMatches.length) {
      gs.push({
        key: "pages",
        label: "Pages",
        items: pageMatches.map((p) => ({
          id: `page:${p.link}`,
          kind: "page",
          label: p.title,
          icon: p.icon,
          href: p.link,
        })),
      });
    }

    // Preserve the server's ordering while bucketing entities by type.
    const byType = new Map();
    for (const r of results) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type).push(r);
    }
    for (const [type, rows] of byType) {
      gs.push({
        key: type,
        label: groupLabel(type),
        items: rows.map((r, i) => ({
          id: `${type}:${r.id ?? i}`,
          kind: type,
          label: r.label,
          sublabel: r.sublabel,
          icon: r.icon,
          href: r.href,
        })),
      });
    }

    return gs;
  }, [pageMatches, results]);

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

  const go = useCallback(
    (item) => {
      if (!item) return;
      setOpen(false);
      router.push(item.href);
    },
    [router]
  );

  function onInputKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[active]);
    }
  }

  if (!open) return null;

  const term = q.trim();
  let runningIndex = -1;

  return (
    <div className="fixed inset-0 z-[70]">
      <div
        className="fixed inset-0 animate-fade-in bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fixed left-1/2 top-[12vh] z-[71] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 animate-command-in overflow-hidden rounded-2xl border border-card-border bg-card shadow-2xl shadow-black/50"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-card-border px-4">
          <Icon icon="heroicons-outline:magnifying-glass" className="shrink-0 text-lg text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search pages, users, roles…"
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={flat[active] ? `cmd-opt-${active}` : undefined}
          />
          {loading && (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-card-border border-t-primary-500" />
          )}
        </div>

        {/* Results */}
        <div ref={listRef} id="cmd-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted">
              {term && !loading ? "No results found." : "Type to search…"}
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
                    return (
                      <button
                        key={it.id}
                        id={`cmd-opt-${idx}`}
                        data-cmd-index={idx}
                        role="option"
                        aria-selected={isActive}
                        onMouseMove={() => setActive(idx)}
                        onClick={() => go(it)}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                          isActive ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
                        }`}
                      >
                        <Icon
                          icon={it.icon || "heroicons-outline:arrow-right"}
                          className="h-4 w-4 shrink-0 text-base"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{it.label}</span>
                        {it.sublabel && <span className="truncate text-xs text-muted">{it.sublabel}</span>}
                        {isActive && <span className="shrink-0 font-mono text-xs text-muted">↵</span>}
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
      </div>
    </div>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-card-border bg-hover px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
