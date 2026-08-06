"use client";

// A tiny key→role map editor (directory group → role, or OIDC claim value → role).
// Renders the current pairs as removable rows + an add-row. Emits the plain object.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { FieldLabel } from "@/components/common";

export default function RoleMapEditor({ label, keyLabel = "Group", value = {}, onChange, disabled }) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const entries = Object.entries(value);

  const add = () => {
    const key = k.trim();
    const role = v.trim();
    if (!key || !role) return;
    onChange({ ...value, [key]: role });
    setK("");
    setV("");
  };
  const remove = (key) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  return (
    <div>
      <FieldLabel className="mb-1.5 block">{label}</FieldLabel>
      <div className="rounded-lg border border-nb-line">
        {entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-nb-muted">No mappings — directory/SSO users fall back to the default role.</p>
        ) : (
          <div className="divide-y divide-nb-line">
            {entries.map(([key, role]) => (
              <div key={key} className="flex items-center gap-2 px-3 py-2 text-sm">
                <code className="flex-1 truncate text-nb-ink">{key}</code>
                <Icon icon="heroicons-outline:arrow-right" className="text-xs text-nb-muted" />
                <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-nb-ink">{role}</span>
                {!disabled && (
                  <button className="text-nb-muted transition hover:text-red-500" onClick={() => remove(key)} title="Remove">
                    <Icon icon="heroicons-outline:x-mark" className="text-base" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {!disabled && (
          <div className="flex items-center gap-2 border-t border-nb-line p-2">
            <input
              value={k}
              onChange={(e) => setK(e.target.value)}
              placeholder={keyLabel}
              className="h-8 flex-1 rounded-md border border-nb-line bg-transparent px-2.5 text-sm text-nb-ink outline-none focus:border-nb-teal"
            />
            <Icon icon="heroicons-outline:arrow-right" className="text-xs text-nb-muted" />
            <input
              value={v}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="role"
              className="h-8 w-32 rounded-md border border-nb-line bg-transparent px-2.5 text-sm text-nb-ink outline-none focus:border-nb-teal"
            />
            <button
              onClick={add}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-nb-line text-nb-muted transition hover:text-nb-ink"
              title="Add mapping"
            >
              <Icon icon="heroicons-outline:plus" className="text-base" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
