"use client";

// Global ⊞ MENU navigator (Round-26a) — a launcher button injected top-left across
// every authenticated screen. Clicking it opens a full-screen NeuBit-navy overlay that
// exposes the whole information architecture as a metro grid, so an operator can jump to
// any section from anywhere.
//
// Below the "Jump to" quick row it is the HOME launcher, in miniature: the same groups
// and the same surfaces, because both render config/launcher.js. Gating is Home's too —
// a surface the caller's permissions or plan don't reach keeps its label but loses its
// link and renders "Soon", rather than being hidden, so operators can see what their
// plan could unlock. "Jump to" still comes from config/menu.js and still HIDES what the
// caller can't reach: it is a shortcut row, not a catalogue.

import { Icon } from "@iconify/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { launcherGroups } from "@/config/launcher";
import { menuItems } from "@/config/menu";
import { useAuth } from "@/lib/auth";

// One IA group in the overlay grid.
function Group({ title, accent, children }) {
  return (
    <div>
      <h4
        className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.4px]"
        style={{ color: accent }}
      >
        <span
          className="h-[6px] w-[6px] rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
        />
        {title}
      </h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </div>
  );
}

// A single navigable cell. Renders dimmed + non-clickable when `soon` (no destination yet).
function Cell({ item, onGo }) {
  const soon = !item.link;
  const base =
    "group flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] transition";
  if (soon) {
    return (
      <span
        aria-disabled="true"
        title="Coming soon"
        className={`${base} cursor-default select-none border-[rgba(160,150,245,.2)] text-[#7e93bf] opacity-60`}
      >
        <Icon icon={item.icon} className="text-[17px] shrink-0" />
        <span className="truncate">{item.title}</span>
        <span className="ml-auto rounded border border-[rgba(160,150,245,.3)] px-1.5 py-px font-mono text-[9px] uppercase tracking-[.6px] text-[#8f8ac0]">
          Soon
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onGo(item.link)}
      className={`${base} border-[rgba(160,150,245,.2)] bg-[linear-gradient(155deg,rgba(34,211,238,.10),rgba(150,180,245,.04)_65%)] text-[#cfd0f2] hover:border-[rgba(34,211,238,.6)] hover:text-[#f2f6ff] hover:shadow-[0_0_22px_rgba(34,211,238,.22)]`}
    >
      <Icon icon={item.icon} className="text-[17px] shrink-0 text-[#67e8f9]" />
      <span className="truncate text-left">{item.title}</span>
    </button>
  );
}

export default function MenuNavigator() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { can, hasModule, user } = useAuth();

  useEffect(() => setMounted(true), []);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const allowed = (t) =>
    !t.disabled &&
    (!t.superadmin || user?.is_superadmin) &&
    (!t.perm || can(t.perm)) &&
    (!t.module || hasModule(t.module));

  const go = (link) => {
    setOpen(false);
    router.push(link);
  };

  // Home + the section landing links (first reachable tab of each section).
  const topLinks = [
    { title: "Home", icon: "heroicons-outline:home", link: "/home" },
    ...menuItems
      .filter((m) => m.link && allowed(m))
      .map((m) => ({ title: m.title, icon: m.icon, link: m.link })),
  ];
  // Below "Jump to", the overlay presents exactly what the HOME launcher presents —
  // the same groups (Watch · Act · Sense · Think · System & Policy · Devices &
  // Automation), the same surfaces, in the same order — because both render the one
  // launcher IA in config/launcher.js. Home shows one mode at a time; the overlay
  // shows every mode's groups at once. Nothing to keep in sync by hand.
  const groups = launcherGroups({ can, hasModule }).map((g) => ({
    ...g,
    // Cell speaks {title, icon, link}; a gated or unbuilt tile arrives with no href
    // and renders as the dimmed "Soon" cell, just as it renders a SOON tile on Home.
    items: g.tiles.map((t) => ({ title: t.label, icon: t.icon, link: t.href })),
  }));

  const launcher = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title="Open menu navigator"
      aria-label="Open menu navigator"
      className="grid h-9 w-9 place-items-center rounded-[8px] border border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.13)] text-[#67e8f9] transition hover:border-[rgba(34,211,238,.7)] hover:shadow-[0_0_16px_rgba(34,211,238,.3)]"
    >
      <Icon icon="heroicons-outline:home" className="text-[18px]" />
    </button>
  );

  const overlay =
    open && mounted
      ? createPortal(
          <div
            className="fixed inset-0 z-[100] overflow-y-auto text-[#f2f6ff] antialiased"
            style={{
              background:
                "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)",
            }}
            onClick={() => setOpen(false)}
          >
            <div
              className="mx-auto w-full max-w-6xl px-6 py-8"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-8 flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-[8px] border border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.13)] text-[#67e8f9]">
                  <Icon icon="heroicons-outline:home" className="text-[18px]" />
                </span>
                <span className="text-[15px] font-bold tracking-[0.5px]">
                  Neu<i className="not-italic text-[#67e8f9]">Bit</i>
                </span>
                <span className="border-l border-[rgba(160,150,245,.2)] pl-3 font-mono text-[10px] tracking-[2px] text-[#9a92c8]">
                  MENU NAVIGATOR
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="ml-auto grid h-8 w-8 place-items-center rounded-[8px] border border-[rgba(160,150,245,.2)] text-[#cfd0f2] transition hover:border-[rgba(34,211,238,.6)] hover:text-[#f2f6ff]"
                  aria-label="Close"
                >
                  <Icon icon="heroicons:x-mark" className="text-[18px]" />
                </button>
              </div>

              <div className="grid gap-8">
                <Group title="Jump to" accent="#67e8f9">
                  {topLinks.map((i) => (
                    <Cell key={i.title} item={i} onGo={go} />
                  ))}
                </Group>

                {groups.map((g) => (
                  <Group key={g.title} title={g.title} accent={g.accent}>
                    {g.items.map((i) => (
                      <Cell key={i.title} item={i} onGo={go} />
                    ))}
                  </Group>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {launcher}
      {overlay}
    </>
  );
}
