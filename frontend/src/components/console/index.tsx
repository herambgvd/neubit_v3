"use client";

// Console primitives — the ONE definition of the minimal-chrome console look used
// by every Configurations surface (Users & Roles, Sites, System, Security,
// Platform, Federation).
//
// These were previously hand-rolled inside Users.jsx and copy-pasted into Sites,
// then re-invented with a different token set in Security/Platform/Federation —
// which is exactly how the three-design-system drift happened. Every console now
// composes from here, so a change to the look lands everywhere at once.
//
// The palette is the NeuBit navy set (`nb-*` in tailwind.config.js). Configurations
// surfaces accent BLUE (nb-blue / nb-blueb) to match their launcher tone and the
// ConsoleStrip modtab; teal stays reserved for Surveillance.
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";

// The navy radial backdrop every console page sits on. Kept as one constant so a
// page can spread it onto a custom wrapper instead of nesting another div.
export const CONSOLE_BG = {
  background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)",
};

// Page frame: bleeds past <main>'s padding, fills the bounded pane, never scrolls
// itself (panels scroll internally). Matches AppLayout's `contained` route class.
// HEIGHT: `-my-3` bleeds the navy backdrop over <main>'s py-3, so the box must be
// 1.5rem TALLER than the content area or it stops short — which left a 24px dead
// strip under the panels (12px the box fell short + 12px of <main>'s own padding)
// and nothing at the top. calc(100% + 1.5rem) makes the bleed symmetric, then
// pt-3/pb-2 keeps the inner gutter tight at the bottom where the footer already
// supplies visual separation.
export function ConsolePage({ className = "", children }: any) {
  return (
    <div
      className={`flex h-[calc(100%+1.5rem)] min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 pt-3 pb-2 text-nb-ink ${className}`}
      style={CONSOLE_BG}
    >
      {children}
    </div>
  );
}

// Scrolling body for consoles whose content is a stack of cards rather than a
// master/detail grid (Security policy, Platform views, System settings).
export function ConsoleScroll({ className = "", children }: any) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-1 ${className}`}>{children}</div>;
}

// The master/detail grid. `cols` is a STATIC class string — Tailwind's JIT can't
// read a runtime-built arbitrary value.
export function ConsoleGrid({ cols = "lg:grid-cols-[300px_1fr]", className = "", children }: any) {
  return (
    <div className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${cols} ${className}`}>{children}</div>
  );
}

// A console column/card. This is the `col` string Users and Sites each declared.
export const PANEL_CLS =
  "rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] min-h-0 flex flex-col overflow-hidden";

export function ConsolePanel({ className = "", children }: any) {
  return <div className={`${PANEL_CLS} ${className}`}>{children}</div>;
}

// Panel header: icon + uppercase title + optional count, with room for actions.
export function PanelHeader({ icon, title, count, actions, children }: any) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
      <div className="flex items-center gap-2">
        {icon && <Icon icon={icon} className="text-sm text-nb-blueb" />}
        <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">{title}</span>
        {count != null && <span className="font-mono text-[11px] text-nb-faint">{count}</span>}
      </div>
      {(actions || children) && <div className="flex items-center gap-1">{actions || children}</div>}
    </div>
  );
}

// The active/idle count dots Sites shows next to its header (green = active,
// grey = inactive). Shared so every list that reports a split renders it alike.
export function PanelCounts({ items = [] }: any) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {items.map((it, i) => (
        <span key={it.label || i} className="flex items-center gap-1" title={it.label}>
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              it.tone === "good" ? "bg-nb-good shadow-[0_0_5px_#34d399]" : it.tone === "crit" ? "bg-nb-crit shadow-[0_0_5px_rgba(248,113,113,.6)]" : "bg-nb-faint"
            }`}
          />
          <span className="text-nb-soft">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// Boxed search row that sits under the panel header.
export function PanelSearch({ value, onChange, placeholder = "Search…" }: any) {
  return (
    <div className="px-3 pb-2">
      <div className="flex items-center gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
        <Icon icon="heroicons-outline:magnifying-glass" className="text-sm text-nb-faint" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent text-[12.5px] text-nb-muted outline-hidden placeholder:text-nb-faint"
        />
      </div>
    </div>
  );
}

// Scrolling list body with the three standard states, so "Loading…" / "no match" /
// "nothing yet" read identically on every console.
export function PanelList({ loading, error, empty, emptyText = "Nothing here yet", children }: any) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3">
      {loading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-nb-soft">
          <Icon icon="svg-spinners:180-ring" className="text-base text-nb-blueb" /> Loading…
        </div>
      ) : error ? (
        <div className="px-1 py-10 text-center text-xs text-nb-crit">{error}</div>
      ) : empty ? (
        <div className="px-1 py-10 text-center text-xs text-nb-faint">{emptyText}</div>
      ) : (
        <div className="space-y-2 pb-2">{children}</div>
      )}
    </div>
  );
}

// Panel footer — the dashed create CTA plus an optional explanatory note.
export function PanelFooter({ children }: any) {
  return <div className="border-t border-nb-line/50 p-3">{children}</div>;
}

// The dashed "＋ NEW X" create button. `label` is the bare noun ("SITE"); the
// component owns the ＋ and the wording so no console can drift its copy.
export function CreateButton({ label, onClick, disabled, className = "" }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-[9px] border border-dashed border-nb-line2 py-2.5 text-[12px] tracking-[.7px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb disabled:opacity-50 ${className}`}
    >
      ＋ NEW {label}
    </button>
  );
}

// Borderless icon action for a LIST ROW (view / edit / delete on a webhook, rule,
// event…). Distinct from IconButton, which is the bordered chip a panel header
// uses. Rows were hand-rolling this at h-7 and h-8, with and without borders.
export function RowAction({ icon, title, onClick, disabled, tone = "default", className = "", ...props }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      {...props}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-nb-faint transition disabled:opacity-50 ${
        tone === "danger" ? "hover:bg-nb-crit/12 hover:text-nb-crit" : "hover:bg-white/5 hover:text-nb-blueb"
      } ${className}`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

// Small square icon button used in panel headers (export / import / refresh).
export function IconButton({ icon, title, onClick, disabled, className = "", ...props }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      {...props}
      className={`grid h-7 w-7 place-items-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb disabled:opacity-50 ${className}`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

// The three console actions are the kit's <Button> under named variants — NOT a
// second button implementation. An inline "Save changes" and a modal footer's
// "Create" are then literally the same component, which is what stops the two
// from drifting apart again. `as` (from Button) renders one as a <Link>.
export function ActionButton(props) {
  return <Button variant="action" {...props} />;
}

// Quiet secondary action (Cancel, Manage, Back).
export function QuietButton(props) {
  return <Button variant="secondary" {...props} />;
}

// Segmented toggle — the same pill-in-a-box the header's console strip uses for
// ?view= navigation, but driven by state instead of links. Anywhere a form offers
// two or three modes (Raw JSON / Guided, list / map) this is the control.
//   <Segmented value={mode} onChange={setMode} options={[{value,label,icon}]} />
export function Segmented({ value, onChange, options = [], className = "" }: any) {
  return (
    <div className={`flex shrink-0 gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px] ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange?.(o.value)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition ${
              on
                ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                : "border border-transparent text-nb-faint hover:text-nb-muted"
            }`}
          >
            {o.icon && <Icon icon={o.icon} className="text-[14px]" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// The right-aligned action row a console view puts above its content (Save
// changes, Create key, Upload…). One definition so the gap above the content is
// the same on every view.
export function ViewActions({ className = "", children }: any) {
  return <div className={`mb-3 flex items-center justify-end gap-2 ${className}`}>{children}</div>;
}

// Centred loading block for a whole view (as opposed to PanelList's inline one).
export function LoadingBlock({ label = "Loading…", className = "" }: any) {
  return (
    <div className={`flex items-center justify-center gap-2 py-16 text-sm text-nb-muted ${className}`}>
      <Icon icon="svg-spinners:180-ring" className="text-base text-nb-blueb" /> {label}
    </div>
  );
}

// Destructive action (Delete, Revoke) — red is reserved for actions that lose data.
export function DangerButton(props) {
  return <Button variant="danger" {...props} />;
}

// --- RIGHT-hand context panel (Security posture, Role summary, …) ------------
// Both panels had their own copy of these two; the copies had already drifted
// (one grew a busy spinner and tones, the other stayed a hand-rolled <button>).
// One definition each, so a stat row and a panel action look the same everywhere.

// One "label ······ value" row inside a context panel's stat card.
export function PanelStat({ label, value, tone = "ink" }: any) {
  const c = {
    ink: "text-nb-ink",
    good: "text-nb-good",
    warn: "text-nb-warn",
    crit: "text-nb-crit",
    blue: "text-nb-blueb",
    faint: "text-nb-faint",
  }[tone];
  return (
    <div className="flex items-center justify-between border-b border-nb-line/40 py-1.5 last:border-b-0">
      <span className="text-[11.5px] text-nb-faint">{label}</span>
      <span className={`font-mono text-[11.5px] ${c}`}>{value}</span>
    </div>
  );
}

// Full-width action button inside a context panel (CLONE THIS USER ▸, UNLOCK ▸).
export function PanelAction({ icon, children, onClick, tone = "blue", disabled, busy }: any) {
  const cls = {
    blue: "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb hover:bg-[rgba(96,165,250,.16)]",
    warn: "border-nb-warn/50 bg-nb-warn/10 text-nb-warn hover:bg-nb-warn/20",
    good: "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good hover:bg-[rgba(52,211,153,.16)]",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border px-3 py-2 text-[11.5px] tracking-[.5px] transition disabled:opacity-50 ${cls}`}
    >
      <Icon icon={busy ? "svg-spinners:180-ring" : icon} className="text-[13px]" />
      {children}
    </button>
  );
}

// Header action inside a detail pane (Edit) and its destructive icon-only sibling
// (Delete). RoleDetail and UserDetail each hand-rolled these; the Delete buttons
// had already diverged (one labelled, one a bare icon chip).
export function PaneAction({ icon, title, onClick, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-xs text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
    >
      <Icon icon={icon} className="text-sm" />
      {children}
    </button>
  );
}

export function PaneDeleteAction({ title = "Delete", onClick }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.1)] text-nb-crit transition hover:bg-[rgba(248,113,113,.18)]"
    >
      <Icon icon="heroicons-outline:trash" className="text-sm" />
    </button>
  );
}

// A create/edit form that FILLS a detail pane (as opposed to one in a modal).
// Chrome deliberately mirrors kit's <Modal>: same header padding, same divider
// rules, same footer — so "Create SOP" in a pane and "Add user" in a dialog read
// as the same form. Half the workflow tabs used to render a tinted card floating
// inside the pane instead, which is why they looked like a different product.
export function PaneForm({ title, subtitle, action, onSubmit, footer, className = "", children }: any) {
  return (
    <form noValidate onSubmit={onSubmit} className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-nb-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-nb-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-nb-faint">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-nb-line px-5 py-4">{footer}</div>
      )}
    </form>
  );
}

// Card frame for stacked-form consoles (Security sections, Settings groups,
// Platform panels). Same surface as ConsolePanel but padded and non-flex.
export function SectionCard({ className = "", children }: any) {
  return (
    <div className={`rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4 ${className}`}>{children}</div>
  );
}

// Uppercase micro-heading used at the top of a SectionCard.
export function SectionHead({ icon, title, desc, action, className = "" }: any) {
  return (
    <div className={`mb-3 flex items-start gap-2 ${className}`}>
      {icon && <Icon icon={icon} className="mt-0.5 text-sm text-nb-blueb" />}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{title}</div>
        {desc && <p className="mt-1 text-[11.5px] leading-relaxed text-nb-faint">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

// Centred "nothing selected" placeholder for a detail pane.
export function EmptyPane({ icon = "heroicons-outline:cursor-arrow-rays", title, subtitle }: any) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
        <Icon icon={icon} className="text-xl" />
      </span>
      <div className="mt-3 text-sm font-semibold text-nb-ink">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-nb-faint">{subtitle}</div>}
    </div>
  );
}

// Read-only label/value cell used inside detail panes.
export function InfoCell({ label, value, mono = false, title }: any) {
  return (
    <div className="min-w-0 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{label}</p>
      <p
        className={`mt-0.5 truncate text-[13px] font-medium text-nb-ink ${mono ? "font-mono" : ""}`}
        title={title ?? (typeof value === "string" ? value : undefined)}
      >
        {value ?? "—"}
      </p>
    </div>
  );
}
