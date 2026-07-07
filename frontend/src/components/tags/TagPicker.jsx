"use client";

// TagPicker — a small, non-invasive tag-assignment control for ANY entity
// (a site or a zone today). Shows the tags currently attached to the entity as
// colored chips (each removable), plus an "Add tag" popover listing the tenant's
// tags to attach. Backed by the generic /tags assign/unassign + forEntity API.
//
// Props:
//   • entityType  — e.g. "site" | "zone"
//   • entityId    — the target entity's id
//   • size        — "sm" (default) | "xs" chip sizing
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";

export default function TagPicker({ entityType, entityId, size = "sm" }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const attachedKey = ["tags-for", entityType, entityId];
  const attachedQ = useQuery({
    queryKey: attachedKey,
    queryFn: () => tagsApi.forEntity(entityType, entityId),
    enabled: !!entityType && !!entityId,
  });
  const allQ = useQuery({
    queryKey: ["tags-list"],
    queryFn: () => tagsApi.list({ limit: 200, is_active: true }),
    enabled: open,
  });

  const attached = attachedQ.data || [];
  const attachedIds = useMemo(() => new Set(attached.map((t) => t.tag_id)), [attached]);
  const available = (allQ.data?.items || []).filter((t) => !attachedIds.has(t.tag_id));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: attachedKey });
    qc.invalidateQueries({ queryKey: ["tags-list"] });
  };

  const assign = useMutation({
    mutationFn: (tagId) => tagsApi.assign(tagId, { entity_type: entityType, entity_id: entityId }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const unassign = useMutation({
    mutationFn: (tagId) => tagsApi.unassign(tagId, { entity_type: entityType, entity_id: entityId }),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });

  const chipCls =
    size === "xs"
      ? "text-[10px] px-1.5 py-0.5 gap-1"
      : "text-xs px-2 py-1 gap-1.5";

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-1.5">
      {attached.map((t) => (
        <span
          key={t.tag_id}
          className={`inline-flex items-center rounded-full border font-medium ${chipCls}`}
          style={{
            background: `${t.color || "#3B82F6"}1a`,
            color: t.color || "#3B82F6",
            borderColor: `${t.color || "#3B82F6"}33`,
          }}
        >
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: t.color || "#3B82F6" }} />
          {t.name}
          <button
            type="button"
            title="Remove tag"
            onClick={() => unassign.mutate(t.tag_id)}
            className="ml-0.5 opacity-60 hover:opacity-100"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-[11px]" />
          </button>
        </span>
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center rounded-full border border-dashed border-card-border text-muted hover:bg-hover hover:text-foreground ${chipCls}`}
        >
          <Icon icon="heroicons-outline:plus" className="text-[11px]" />
          Tag
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div className="absolute left-0 z-40 mt-1 w-56 rounded-lg border border-card-border bg-card shadow-xl p-1">
              {allQ.isLoading ? (
                <div className="px-3 py-3 text-xs text-muted">Loading tags…</div>
              ) : available.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted">
                  {(allQ.data?.items || []).length === 0 ? "No tags yet. Create one in Config → Tags." : "All tags already applied."}
                </div>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {available.map((t) => (
                    <li key={t.tag_id}>
                      <button
                        type="button"
                        onClick={() => assign.mutate(t.tag_id)}
                        disabled={assign.isPending}
                        className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-hover"
                      >
                        <span className="h-3 w-3 rounded-full border border-card-border shrink-0" style={{ background: t.color || "#3B82F6" }} />
                        <span className="truncate">{t.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
