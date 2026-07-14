"use client";

// SelectMenu — the polished, theme-consistent dropdown that replaces the native
// <select> everywhere a form field needs a picker. The trigger is styled with the
// SAME `fieldClass` as text inputs so a select sits flush next to inputs in a form
// (native <select> boxes were the main "this doesn't look enterprise" tell).
//
// The options panel renders in a PORTAL with fixed positioning so it never gets
// clipped by a scroll container (modals, tables, the app shell). It drops up when
// there's no room below, scrolls a long list, and is keyboard-navigable.
//
// Drop-in compatible with a native select: emits `onChange({ target: { value } })`.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

import { fieldClass } from "./Field";

export default function SelectMenu({
  options = [],
  value,
  onChange,
  disabled = false,
  placeholder = "Select…",
  className = "",
  id,
  name,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { left, top?, bottom?, width }
  const [activeIdx, setActiveIdx] = useState(-1);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const selected = options.find((o) => String(o.value) === String(value ?? ""));
  const isPlaceholder = !selected || selected.value === "" || selected.value == null;
  const displayLabel = selected ? selected.label : placeholder;

  const place = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const dropUp = window.innerHeight - r.bottom < 280 && r.top > 280;
    setPos({
      left: r.left,
      width: r.width,
      top: dropUp ? undefined : r.bottom + 4,
      bottom: dropUp ? window.innerHeight - r.top + 4 : undefined,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    // The fixed panel can't follow ancestor scroll → close on page/container
    // scroll. But NOT when the scroll originates inside the panel itself (the
    // options list is scrollable); capture-phase would otherwise close a long
    // list the instant you try to scroll it.
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
    setOpen((o) => {
      const next = !o;
      if (next) setActiveIdx(options.findIndex((o2) => String(o2.value) === String(value ?? "")));
      return next;
    });
  }

  function pick(v) {
    onChange?.({ target: { value: v } });
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle();
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) pick(opt.value);
    }
  }

  // Keep the active option scrolled into view while arrow-navigating.
  useEffect(() => {
    if (!open || activeIdx < 0 || !panelRef.current) return;
    const el = panelRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        name={name}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${fieldClass} flex items-center justify-between text-left ${
          isPlaceholder ? "!text-muted" : ""
        } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-muted"} ${className}`}
      >
        <span className="truncate">{displayLabel}</span>
        <Icon
          icon="heroicons-outline:chevron-down"
          className={`ml-2 shrink-0 text-base text-muted transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && !disabled && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 70 }}
            className="max-h-64 overflow-auto rounded-lg border border-card-border bg-card py-1 shadow-2xl animate-fade-in"
          >
            {options.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted">No options</div>
            ) : (
              options.map((o, i) => {
                const active = String(o.value) === String(value ?? "");
                const highlighted = i === activeIdx;
                return (
                  <button
                    key={`${o.value}-${i}`}
                    type="button"
                    data-idx={i}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => pick(o.value)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition ${
                      highlighted ? "bg-hover" : ""
                    } ${active ? "text-foreground" : "text-muted hover:text-foreground"}`}
                  >
                    <span className="truncate">{o.label}</span>
                    {active && !isPlaceholder && (
                      <Icon icon="heroicons-outline:check" className="shrink-0 text-base text-foreground" />
                    )}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
