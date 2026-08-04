"use client";

// Shared UI kit — reskinned to the NeuBit navy/teal command-console look. Panels
// are navy-glass (nb.line border, translucent navy bg, backdrop-blur); inputs use
// the nb.field surface with teal focus rings; labels/text follow the ink→muted→
// faint ramp. Status-semantic colours (green=ok, amber=warn, red=crit) are kept.
import { Icon } from "@iconify/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Card({ className = "", children }) {
  return (
    <div className={`rounded-lg bg-[rgba(8,15,34,.5)] border border-nb-line backdrop-blur-sm ${className}`}>{children}</div>
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
  success: "bg-nb-teal text-[#062330] font-semibold hover:bg-nb-tealb", // create actions — NeuBit teal
  danger: "bg-red-600 hover:bg-red-500 text-white", // delete actions
  secondary: "bg-transparent border border-nb-line text-nb-ink hover:bg-white/5",
  ghost: "bg-transparent text-nb-muted hover:text-nb-ink hover:bg-white/5",
};

export function Button({ variant = "primary", icon, className = "", children, ...props }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${className}`}
    >
      {icon && <Icon icon={icon} className="text-base" />}
      {children}
    </button>
  );
}

const FIELD =
  "w-full rounded-md border border-nb-line bg-nb-field px-3 py-2 text-sm text-nb-ink placeholder:text-nb-faint outline-none transition focus:border-nb-teal focus:ring-1 focus:ring-nb-teal/40";

export function Input({ label, hint, className = "", ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-nb-ink mb-1.5">{label}</span>}
      <input {...props} className={`${FIELD} ${className}`} />
      {hint && <span className="block text-xs text-nb-muted mt-1">{hint}</span>}
    </label>
  );
}

// Custom themed dropdown (replaces the native <select> for a consistent dark/light
// look). The options panel renders in a portal with fixed positioning so it never
// gets clipped by a scroll container (modals, tables). Drop-in compatible: emits
// onChange({ target: { value } }) like a native select.
export function Select({ label, options = [], value, onChange, disabled, placeholder, className = "" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { left, top?, bottom?, width }
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const selected = options.find((o) => String(o.value) === String(value ?? ""));
  const isPlaceholder = !selected || selected.value === "";
  const displayLabel = selected ? selected.label : placeholder || "Select…";

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    // Fixed-positioned panel can't follow ancestor scroll, so close on page/
    // container scroll — but NOT when the scroll happens INSIDE the panel itself
    // (the options list is `overflow-auto`; capture-phase would otherwise catch
    // the panel's own scroll and close it, making a long list impossible to
    // scroll through).
    function onScroll(e) {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const dropUp = window.innerHeight - r.bottom < 260 && r.top > 260;
      setPos({
        left: r.left,
        width: r.width,
        top: dropUp ? undefined : r.bottom + 4,
        bottom: dropUp ? window.innerHeight - r.top + 4 : undefined,
      });
    }
    setOpen((o) => !o);
  }

  function pick(v) {
    onChange?.({ target: { value: v } });
    setOpen(false);
  }

  return (
    <div className="block">
      {label && <span className="block text-sm font-medium text-nb-ink mb-1.5">{label}</span>}
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        className={`${FIELD} flex items-center justify-between text-left ${
          isPlaceholder ? "!text-nb-faint" : ""
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"} ${className}`}
      >
        <span className="truncate">{displayLabel}</span>
        <Icon
          icon="heroicons-outline:chevron-down"
          className={`text-base shrink-0 ml-2 text-nb-muted transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && !disabled && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 60 }}
            className="max-h-60 overflow-auto rounded-lg border border-nb-line bg-[rgba(8,15,34,.93)] backdrop-blur-md shadow-2xl py-1 animate-fade-in"
          >
            {options.map((o, i) => {
              const active = String(o.value) === String(value ?? "");
              return (
                <button
                  key={`${o.value ?? ""}-${i}`}
                  type="button"
                  onClick={() => pick(o.value)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition ${
                    active ? "text-nb-ink bg-nb-teal/10" : "text-nb-muted hover:text-nb-ink hover:bg-white/5"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {active && !isPlaceholder && <Icon icon="heroicons-outline:check" className="text-base shrink-0 text-nb-teal" />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

export function Textarea({ label, className = "", ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-nb-ink mb-1.5">{label}</span>}
      <textarea {...props} className={`${FIELD} ${className}`} />
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
      className={`relative flex items-center gap-3 overflow-hidden rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] backdrop-blur-sm px-4 py-3.5 ${className}`}
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

export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl bg-[rgba(8,15,34,.93)] border border-nb-line backdrop-blur-md shadow-2xl animate-modal-in`}
      >
        <div className="flex items-center justify-between border-b border-nb-line px-5 py-4">
          <h3 className="text-base font-semibold text-nb-ink">{title}</h3>
          <button onClick={onClose} className="text-nb-muted hover:text-nb-ink transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-nb-line px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

// Right-side sliding sheet for detail views (person detail, investigation history…).
export function Drawer({ open, onClose, title, subtitle, children, width = "max-w-md" }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose} />
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
    </div>
  );
}

// A themed confirmation modal (replaces window.confirm). Drive it with a piece of
// state: setConfirm({ title, message, confirmLabel, danger, onConfirm }) to open,
// and render one <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />.
export function ConfirmDialog({ state, onClose, pending }) {
  const cfg = state || {};
  return (
    <Modal
      open={!!state}
      onClose={onClose}
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
