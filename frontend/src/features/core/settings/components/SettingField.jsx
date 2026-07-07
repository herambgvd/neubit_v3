"use client";

// Renders one setting control based on its declared `type`. Distinct from the
// shared @/components/common Field: this one renders a bordered bool-toggle row
// for `type: "bool"` and an Input (text/number) otherwise, matching the general
// settings layout exactly.
import { Input, Toggle } from "@/components/ui/kit";

export default function SettingField({ item, value, onChange }) {
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
  return (
    <div className="py-3 border-b border-card-border last:border-0">
      <Input
        label={item.label}
        type={item.type === "number" ? "number" : "text"}
        value={value ?? ""}
        onChange={(e) => onChange(item.type === "number" ? Number(e.target.value) : e.target.value)}
        hint={item.description}
      />
    </div>
  );
}
