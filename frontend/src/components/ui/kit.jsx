"use client";

// Shared UI kit — reskinned to the NeuBit navy/teal command-console look. Panels
// are navy-glass (nb.line border, translucent navy bg); inputs use the nb.field
// surface with teal focus rings; labels/text follow the ink→muted→faint ramp.
// Status-semantic colours (green=ok, amber=warn, red=crit) are kept.
//
// Panels carry NO backdrop-blur. They sit on a smooth radial gradient, so there is
// nothing for a blur to reveal — but it did make every panel its own *backdrop
// root*, which an overlay's backdrop-blur cannot reach into. The result was sharp
// islands in an otherwise blurred page whenever a modal opened. Only the overlays
// below blur, and they paint on top.
import { Icon } from "@iconify/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { areaClass, fieldClass, FieldLabel } from "@/components/common/Field";
import SelectMenu from "@/components/common/SelectMenu";

export function Card({ className = "", children }) {
  return (
    <div className={`rounded-lg bg-[rgba(8,15,34,.5)] border border-nb-line ${className}`}>{children}</div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-nb-ink">{title}</h1>
        {subtitle && <p className="text-nb-muted mt-1 text-[13px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const VARIANTS = {
  // Primary inverts with the theme (black-on-white in light, white-on-black in dark).
  primary: "bg-foreground text-background hover:opacity-90",
  // `action` is the Configurations blue — the confirm/save colour on every console
  // surface. Console's <ActionButton> is this variant, so an inline Save and a modal
  // footer's Create are the same button rather than two that merely look similar.
  action:
    "border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.14)] text-nb-blueb hover:bg-[rgba(96,165,250,.22)]",
  success: "bg-nb-teal text-[#062330] font-semibold hover:bg-nb-tealb", // create actions — Surveillance teal
  // Disruptive but reversible (rotate a token, force a re-sync): warns without
  // claiming the action destroys data, which is what `danger` means.
  warn: "border border-nb-warn/40 bg-nb-warn/10 text-nb-warn hover:bg-nb-warn/20",
  danger: "border border-nb-crit/40 bg-nb-crit/10 text-nb-crit hover:bg-nb-crit/20", // delete actions
  secondary: "border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted hover:border-nb-blue hover:text-nb-blueb",
  ghost: "bg-transparent text-nb-muted hover:text-nb-ink hover:bg-white/5",
};

// DEFAULT VARIANT is `action` (the console blue). A bare <Button> is the primary
// confirm on its surface, and ~28 of them were falling through to `primary` — the
// theme-inverting black-on-white chip — which is why "Create webhook" rendered as a
// white button next to blue ones. `primary` is still there for callers that ask.
//
// `as` lets a button that navigates render as a <Link>/<a>. Wrapping a <button>
// in a <Link> nests interactive elements — invalid HTML, and it breaks keyboard
// and assistive-tech navigation.
export function Button({ as: As = "button", variant = "action", icon, className = "", children, ...props }) {
  const extra = As === "button" ? { type: props.type || "button" } : {};
  return (
    <As
      {...props}
      {...extra}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[9px] px-3 py-2 text-[12.5px] font-medium tracking-[.4px] transition disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${className}`}
    >
      {icon && <Icon icon={icon} className="text-[15px]" />}
      {children}
    </As>
  );
}

// Control + label styling come from components/common/Field — the ONE definition.
// The kit used to declare its own (rounded-md, py-2, sentence-case ink label) while
// common used another (rounded-lg, h-10, uppercase muted label), so a modal built on
// the kit and a pane form built on common looked like two different products. Both
// now render the same field; only the wrappers differ.
const FIELD = `${fieldClass} !mt-0`;
const AREA = `${areaClass} !mt-0`;

// Kit field label — the same uppercase micro-label as common's FieldLabel, with the
// kit's own bottom spacing (the kit stacks label-over-control; common relies on the
// control's mt-1).
function Label({ children, required }) {
  return <FieldLabel className="mb-1.5 block" required={required}>{children}</FieldLabel>;
}

// `error` mirrors common/Field: a red border and a red message that takes the
// hint's place, so a kit modal reports a bad field exactly like a pane form does.
function FieldNote({ error, hint }) {
  if (error) return <span className="mt-1 block text-xs text-nb-crit">{error}</span>;
  if (hint) return <span className="mt-1 block text-xs text-nb-muted">{hint}</span>;
  return null;
}

export function Input({ label, hint, error, required, className = "", ...props }) {
  return (
    <label className="block">
      {label && <Label required={required}>{label}</Label>}
      <input
        {...props}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        className={`${FIELD} ${error ? "!border-nb-crit" : ""} ${className}`}
      />
      <FieldNote error={error} hint={hint} />
    </label>
  );
}

// Password field with the same show/hide eye affordance as the sign-in form —
// so an admin can verify what they typed before creating an account.
export function PasswordInput({ label, hint, error, required, className = "", ...props }) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      {label && <Label required={required}>{label}</Label>}
      <span className="relative block">
        <input
          {...props}
          type={show ? "text" : "password"}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          className={`${FIELD} pr-10 ${error ? "!border-nb-crit" : ""} ${className}`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          title={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-nb-faint transition hover:text-nb-ink"
        >
          <Icon icon={show ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="text-base" />
        </button>
      </span>
      <FieldNote error={error} hint={hint} />
    </label>
  );
}

// Select — delegates to the shared SelectMenu so a picker looks and behaves the
// same whether the screen was built on this kit or on components/common. The kit
// used to carry its own near-duplicate (no keyboard nav, different active colour);
// this wrapper only adds the kit's label.
export function Select({ label, required, error, hint, className = "", ...props }) {
  return (
    <div className="block">
      {label && <Label required={required}>{label}</Label>}
      <SelectMenu {...props} className={`!mt-0 ${error ? "!border-nb-crit" : ""} ${className}`} />
      <FieldNote error={error} hint={hint} />
    </div>
  );
}

// For the few places a raw <input type="checkbox"> has to stay because it sits
// inside a bespoke row layout (permission grids, payload pickers): this gives it
// the same size and accent as <Checkbox> so the two never look like two controls.
export const checkboxClass = "h-4 w-4 shrink-0 cursor-pointer accent-nb-blue";

// Themed checkbox — replaces the native box, whose blue accent and sizing did not
// match anything else in the console. Renders label + box as one clickable row.
export function Checkbox({ label, checked, onChange, disabled, className = "", ...props }) {
  return (
    <label className={`inline-flex cursor-pointer select-none items-center gap-2 ${disabled ? "opacity-50" : ""} ${className}`}>
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border transition ${
          checked ? "border-nb-blue bg-nb-blue text-[#0c1530]" : "border-nb-line bg-nb-field"
        }`}
      >
        {checked && <Icon icon="heroicons-mini:check" className="text-[13px]" />}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked, e)}
        className="sr-only"
        {...props}
      />
      {label && <span className="text-sm text-nb-muted">{label}</span>}
    </label>
  );
}

export function Textarea({ label, required, className = "", ...props }) {
  return (
    <label className="block">
      {label && <Label required={required}>{label}</Label>}
      <textarea {...props} aria-required={required || undefined} className={`${AREA} ${className}`} />
    </label>
  );
}

const BADGE = {
  slate: "bg-white/5 text-nb-muted border-nb-line",
  neutral: "bg-white/5 text-nb-muted border-nb-line",
  green: "bg-green-500/10 text-green-400 border-green-500/20",
  red: "bg-red-500/10 text-red-400 border-red-500/20",
  indigo: "bg-nb-teal/10 text-nb-teal border-nb-teal/25",
  blue: "bg-nb-blue/10 text-nb-blue border-nb-blue/25",
  amber: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

export function Badge({ color = "neutral", children }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE[color] || BADGE.neutral}`}
    >
      {children}
    </span>
  );
}

// Round profile picture: shows the image when a URL is given, otherwise the
// first initial on a neutral chip. `size` is the diameter in px.
export function Avatar({ src, name, size = 28, className = "" }) {
  const initials = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const dim = { width: size, height: size };
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name || "Avatar"}
        style={dim}
        className={`rounded-full object-cover border border-nb-line ${className}`}
      />
    );
  }
  return (
    <div
      style={dim}
      className={`rounded-full bg-white/5 border border-nb-line text-nb-ink flex items-center justify-center font-semibold shrink-0 ${className}`}
    >
      <span style={{ fontSize: Math.round(size * 0.42) }}>{initials}</span>
    </div>
  );
}

export function Spinner({ className = "" }) {
  return (
    <div className={`h-6 w-6 rounded-full border-2 border-nb-line border-t-nb-teal animate-spin ${className}`} />
  );
}

// Branded full-screen loader: the "N" mark inside a spinning ring. Used for the
// initial auth check and route-level loading fallbacks.
export function FullPageLoader({ label = "Loading" }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-nb-bg">
      <div className="relative h-14 w-14">
        <div className="absolute inset-0 rounded-full border-2 border-nb-line border-t-nb-teal animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-7 w-7 rounded-md bg-nb-teal flex items-center justify-center text-[#062330] font-bold text-sm">
            N
          </div>
        </div>
      </div>
      {label && <p className="text-nb-muted text-[13px] animate-pulse">{label}</p>}
    </div>
  );
}

export function EmptyState({ icon = "heroicons-outline:inbox", title, subtitle, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon icon={icon} className="text-4xl text-nb-teal mb-3 opacity-70" />
      <p className="text-nb-ink font-medium">{title}</p>
      {subtitle && <p className="text-nb-muted text-sm mt-1">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Metric / KPI cards ────────────────────────────────────────────────────────
// The enterprise stat tile used across dashboards & report headers: an icon chip
// (tone-coloured) + a large tabular value + an uppercase label, with a matching
// accent bar. Use <MetricRow> to lay out a set that always fills the row width.
// Status-semantic tones (ok/warn/bad) keep their green/amber/red meaning; the
// neutral/info tones adopt the NeuBit teal accent.
const _METRIC_TONE = {
  ok: "text-nb-good bg-nb-good/10",
  warn: "text-nb-warn bg-nb-warn/10",
  bad: "text-nb-crit bg-nb-crit/10",
  info: "text-nb-teal bg-nb-teal/10",
  neutral: "text-nb-muted bg-white/5",
};
const _METRIC_BAR = {
  ok: "bg-nb-good/70",
  warn: "bg-nb-warn/70",
  bad: "bg-nb-crit/70",
  info: "bg-nb-teal/70",
  neutral: "bg-nb-line",
};
export function MetricCard({ label, value, icon, tone = "info", hint, className = "" }) {
  return (
    <div
      className={`relative flex items-center gap-3 overflow-hidden rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] px-4 py-3.5 ${className}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${_METRIC_BAR[tone] || _METRIC_BAR.info}`} />
      {icon && (
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${_METRIC_TONE[tone] || _METRIC_TONE.info}`}>
          <Icon icon={icon} className="text-lg" />
        </span>
      )}
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight tracking-tight text-nb-ink tabular-nums">{value}</div>
        <div className="mt-0.5 truncate text-[11px] font-medium uppercase tracking-wide text-nb-muted">{label}</div>
        {hint && <div className="truncate text-[11px] text-nb-faint">{hint}</div>}
      </div>
    </div>
  );
}
const _METRIC_COLS = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 5: "sm:grid-cols-5", 6: "sm:grid-cols-6" };
export function MetricRow({ items = [], className = "" }) {
  const cols = _METRIC_COLS[Math.min(items.length, 6)] || "sm:grid-cols-4";
  return (
    <div className={`grid grid-cols-2 gap-2.5 ${cols} ${className}`}>
      {items.map((m, i) => (
        <MetricCard key={m.label || i} {...m} />
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        checked ? "bg-nb-teal" : "bg-white/10"
      } disabled:opacity-40`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition ${
          checked ? "bg-[#062330]" : "bg-nb-faint"
        }`}
        style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
      />
    </button>
  );
}

// The dim-backdrop shell EVERY overlay sits in — modal, drawer, and the hand-rolled
// dialogs that need their own panel markup. Owns three things: the portal, the
// full-viewport wrapper, and Escape-to-close.
//
// PORTAL TO <body>, and this is the whole point. `position: fixed` only means "the
// viewport" while no ancestor establishes a containing block for it — a transform,
// filter, backdrop-filter, contain, will-change or composited scroller anywhere up
// the tree silently re-parents it and then the ancestor's overflow clips it. That is
// exactly what split the two ingest dialogs: <CategoryFormModal> is a direct child of
// the page and dimmed the whole screen, while <WebhookDetailModal> renders four levels
// down inside a scrolling, overflow-hidden <ConsolePanel> — so its backdrop stopped at
// that panel's edges and the header and category rail stayed lit, reading as the
// background being cut off. Identical markup, different ancestry, different result.
// Rendered at <body> there is no ancestry left to matter, so every overlay behaves the
// same wherever in the tree it happens to be written.
export function Overlay({ onClose, staticBackdrop, wrapper = "items-center justify-center p-4", children }) {
  // document is undefined during SSR/prerender; portal only once mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;
  return createPortal(
    <div className={`fixed inset-0 z-50 flex ${wrapper}`}>
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={staticBackdrop ? undefined : onClose}
      />
      {children}
    </div>,
    document.body,
  );
}

// `hideScroll` keeps the body scrollable (wheel/touch/keyboard) but draws no
// scrollbar — for form modals where the bar clutters the panel edge.
// `staticBackdrop` makes the dialog "static": a stray click on the dim backdrop no
// longer dismisses it, so half-filled forms are never lost by accident. The X,
// Cancel and Escape still close it.
// `size` widens the dialog for form-heavy content ("xl" is the site editor's four
// sections). `wide` is the older boolean and still works. `subtitle` is the one
// line of context under the title — SiteFormModal hand-rolled its whole shell to
// get these two things, which is how it ended up with its own header and footer.
const MODAL_WIDTH = { md: "max-w-md", wide: "max-w-2xl", xl: "max-w-3xl" };

export function Modal({ open, onClose, title, subtitle, children, footer, wide, size, hideScroll, staticBackdrop }) {
  if (!open) return null;
  const width = MODAL_WIDTH[size] || (wide ? MODAL_WIDTH.wide : MODAL_WIDTH.md);
  return (
    <Overlay onClose={onClose} staticBackdrop={staticBackdrop}>
      <div
        className={`relative flex max-h-[85vh] w-full ${width} flex-col rounded-xl bg-[rgba(8,15,34,.93)] border border-nb-line backdrop-blur-md shadow-2xl animate-modal-in`}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-nb-line px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-nb-ink">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-nb-soft">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-nb-muted hover:text-nb-ink transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${hideScroll ? "scroll-none" : ""}`}>{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-nb-line px-5 py-4">{footer}</div>
        )}
      </div>
    </Overlay>
  );
}

// Right-side sliding sheet for detail views (person detail, investigation history…).
export function Drawer({ open, onClose, title, subtitle, children, width = "max-w-md" }) {
  if (!open) return null;
  return (
    <Overlay onClose={onClose} wrapper="justify-end">
      <div className={`relative h-full w-full ${width} bg-[rgba(8,15,34,.93)] border-l border-nb-line backdrop-blur-md shadow-2xl flex flex-col animate-modal-in`}>
        <div className="flex items-start justify-between border-b border-nb-line px-5 py-4 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-nb-ink truncate">{title}</h3>
            {subtitle && <p className="text-xs text-nb-muted mt-0.5 truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-nb-muted hover:text-nb-ink transition shrink-0 ml-3">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </Overlay>
  );
}

// A themed confirmation modal (replaces window.confirm). Drive it with a piece of
// state: setConfirm({ title, message, confirmLabel, danger, onConfirm }) to open,
// and render one <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />.
export function ConfirmDialog({ state, onClose, pending, staticBackdrop }) {
  const cfg = state || {};
  return (
    <Modal
      open={!!state}
      onClose={onClose}
      staticBackdrop={staticBackdrop}
      title={cfg.title || "Are you sure?"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {cfg.cancelLabel || "Cancel"}
          </Button>
          <Button
            variant={cfg.danger === false ? "primary" : "danger"}
            icon={cfg.icon}
            disabled={pending}
            onClick={() => cfg.onConfirm?.()}
          >
            {pending ? "Working…" : cfg.confirmLabel || "Delete"}
          </Button>
        </>
      }
    >
      {cfg.danger === false ? (
        <p className="text-sm text-nb-ink">{cfg.message}</p>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-base mt-0.5 shrink-0" />
          <span>{cfg.message || "This action cannot be undone."}</span>
        </div>
      )}
    </Modal>
  );
}

// columns: [{ key, label, render?, align? ("right"|"center"), className? }]
export function Table({ columns, rows, empty }) {
  if (!rows?.length) return empty || <EmptyState title="Nothing here yet" />;
  const alignCls = (a) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-nb-line bg-white/[.03]">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-nb-muted ${alignCls(c.align)}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id || i}
              className="border-b border-nb-line/60 transition last:border-0 hover:bg-white/5"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-3 text-nb-ink ${alignCls(c.align)} ${c.align === "right" ? "tabular-nums" : ""} ${c.className || ""}`}
                >
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
