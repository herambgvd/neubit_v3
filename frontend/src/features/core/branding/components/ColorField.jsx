"use client";

import { FieldLabel } from "@/components/common";

// A color swatch that wraps a native <input type="color"> in the kit look and
// keeps a text field in sync for precise hex entry.
export default function ColorField({ label, value, onChange }) {
  return (
    <div>
      <FieldLabel className="mb-1.5 block">{label}</FieldLabel>
      <div className="flex items-center gap-2 rounded-md border border-nb-line bg-nb-field px-2 py-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded-sm border-0 bg-transparent p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent text-sm text-nb-ink outline-hidden"
        />
      </div>
    </div>
  );
}
