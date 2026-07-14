"use client";

// A tiny key→role map editor (directory group → role, or OIDC claim value → role).
// Renders the current pairs as removable rows + an add-row. Emits the plain object.
import { useState } from "react";
import { Icon } from "@iconify/react";

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
      <span className="mb-1.5 block text-sm font-medium text-foreground">{label}</span>
      <div className="rounded-lg border border-card-border">
        {entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted">No mappings — directory/SSO users fall back to the default role.</p>
        ) : (
          <div className="divide-y divide-card-border">
            {entries.map(([key, role]) => (
              <div key={key} className="flex items-center gap-2 px-3 py-2 text-sm">
                <code className="flex-1 truncate text-foreground">{key}</code>
                <Icon icon="heroicons-outline:arrow-right" className="text-xs text-muted" />
                <span className="rounded bg-hover px-2 py-0.5 text-xs text-foreground">{role}</span>
                {!disabled && (
                  <button className="text-muted transition hover:text-red-500" onClick={() => remove(key)} title="Remove">
                    <Icon icon="heroicons-outline:x-mark" className="text-base" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {!disabled && (
          <div className="flex items-center gap-2 border-t border-card-border p-2">
            <input
              value={k}
              onChange={(e) => setK(e.target.value)}
              placeholder={keyLabel}
              className="h-8 flex-1 rounded-md border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted"
            />
            <Icon icon="heroicons-outline:arrow-right" className="text-xs text-muted" />
            <input
              value={v}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="role"
              className="h-8 w-32 rounded-md border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted"
            />
            <button
              onClick={add}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground"
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
