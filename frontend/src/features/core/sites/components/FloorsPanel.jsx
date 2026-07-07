"use client";

// "Floors" tab body — lists a site's floors with add/edit/delete and a button to
// open the full-screen floor-plan editor. Owns its own floors query, delete
// mutation, and the in-place FloorForm.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Spinner } from "@/components/ui/kit";
import { apiError, fileUrl } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { FloorPlanEditorModal } from "@/components/floor-builder/floor-plan-editor";
import FloorForm from "./FloorForm";

export default function FloorsPanel({ site }) {
  const qc = useQueryClient();
  const floorsQ = useQuery({
    queryKey: ["floors-list", site.site_id],
    queryFn: () => sitesApi.floors.list({ site_id: site.site_id, limit: 100 }),
  });

  const items = floorsQ.data?.items || [];
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editorFloor, setEditorFloor] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => sitesApi.floors.remove(id),
    onSuccess: () => {
      toast.success("Floor removed");
      qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Floors</h3>
          <p className="text-xs text-muted">
            {items.length} floor(s) in <span className="font-medium">{site.name}</span>.
          </p>
        </div>
        {!creating && !editing && (
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setCreating(true)} className="!px-3 !py-1.5 text-xs">
            Add floor
          </Button>
        )}
      </div>

      {(creating || editing) && (
        <FloorForm
          site={site}
          floor={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] });
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {!creating && !editing &&
        (floorsQ.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="!h-4 !w-4" /> Loading floors…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-6 py-10 text-center text-sm text-muted">
            No floors yet. Click <b>Add floor</b> to create one.
          </div>
        ) : (
          <ul className="rounded-lg border border-card-border divide-y divide-card-border bg-card">
            {items.map((f) => (
              <li key={f.floor_id} className="flex items-start gap-3 px-4 py-3 hover:bg-hover">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 overflow-hidden border border-card-border">
                  {f.floorplan_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fileUrl(f.floorplan_url)} alt={f.name} className="h-full w-full object-cover" />
                  ) : (
                    <Icon icon="heroicons-outline:square-3-stack-3d" className="text-base" />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{f.name}</span>
                    {typeof f.floor_number === "number" && (
                      <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">L{f.floor_number}</span>
                    )}
                    <span className="text-[10px] rounded-full bg-green-500/10 text-green-500 px-1.5 py-0.5 font-medium">
                      {f.zone_count ?? 0} zone(s)
                    </span>
                    {f.is_active === false && (
                      <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">Inactive</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {f.total_area ? `${f.total_area} m² · ` : ""}
                    {f.description || "No description"}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setEditorFloor(f)} title="Open floor plan editor" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-blue-500">
                    <Icon icon="heroicons-outline:map" className="text-sm" />
                  </button>
                  <button onClick={() => setEditing(f)} title="Edit" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                    <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        title: "Delete floor?",
                        message: `Delete floor "${f.name}" and all its zones?`,
                        confirmLabel: "Delete",
                        onConfirm: () => {
                          remove.mutate(f.floor_id);
                          setConfirm(null);
                        },
                      })
                    }
                    title="Delete"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 hover:text-red-600"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-sm" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      <FloorPlanEditorModal
        open={!!editorFloor}
        floor={editorFloor}
        onClose={() => setEditorFloor(null)}
        onSaved={() => qc.invalidateQueries({ queryKey: ["floors-list", site.site_id] })}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
