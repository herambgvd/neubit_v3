"use client";

// A color swatch that wraps a native <input type="color"> in the kit look and
// keeps a text field in sync for precise hex entry.
export default function ColorField({ label, value, onChange }) {
  return (
    <div>
      <span className="block text-sm font-medium text-muted text-muted mb-1">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-lg border border-card-border border-card-border px-2 py-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent text-sm text-foreground text-foreground outline-none"
        />
      </div>
    </div>
  );
}
