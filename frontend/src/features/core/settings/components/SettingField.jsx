"use client";

// Renders one setting control based on its declared `type`. Distinct from the
// shared @/components/common Field: this one renders a bordered bool-toggle row
// for `type: "bool"` and an Input (text/number) otherwise, matching the general
// settings layout exactly. Fields flagged `secret` render a masked password input
// with a show/hide eye toggle. `placeholder` (from the catalog) hints the input.
import { Icon } from "@iconify/react";
import { useState } from "react";

import { Input, Toggle } from "@/components/ui/kit";

export default function SettingField({ item, value, onChange }) {
  const [reveal, setReveal] = useState(false);

  if (item.type === "bool") {
    return (
      <div className="flex items-center justify-between gap-4 py-3 border-b border-card-border last:border-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{item.label}</div>
          {item.description && <div className="text-xs text-muted mt-0.5">{item.description}</div>}
        </div>
        <Toggle checked={!!value} onChange={(v) => onChange(v)} />
      </div>
    );
  }

  // Secret fields (API keys, passwords) mask their value and expose an eye toggle.
  if (item.secret) {
    return (
      <div className="py-3 border-b border-card-border last:border-0">
        <label className="block">
          <span className="block text-sm font-medium text-foreground mb-1.5">{item.label}</span>
          <div className="relative">
            <input
              type={reveal ? "text" : "password"}
              value={value ?? ""}
              placeholder={item.placeholder || ""}
              onChange={(e) => onChange(e.target.value)}
              className="w-full rounded-md border border-field bg-transparent px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "Hide value" : "Show value"}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-foreground transition"
            >
              <Icon icon={reveal ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="text-base" />
            </button>
          </div>
          {item.description && <span className="block text-xs text-muted mt-1">{item.description}</span>}
        </label>
      </div>
    );
  }

  return (
    <div className="py-3 border-b border-card-border last:border-0">
      <Input
        label={item.label}
        type={item.type === "number" ? "number" : "text"}
        value={value ?? ""}
        placeholder={item.placeholder || ""}
        onChange={(e) => onChange(item.type === "number" ? Number(e.target.value) : e.target.value)}
        hint={item.description}
      />
    </div>
  );
}
