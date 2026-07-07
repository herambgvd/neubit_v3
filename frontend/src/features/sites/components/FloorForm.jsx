"use client";

// Create/edit form for a floor (name, number, area, floor-plan image, description,
// active). Handles the floor-plan file pick + preview and the create-with-upload
// vs update(+optional replace) mutation split. Fills the Floors tab in-place.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { FieldLabel, fieldClass } from "@/components/common";
import { apiError, fileUrl } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { FInput, FTextarea, FCheckbox, ImagePreviewCard } from "./FormControls";

export default function FloorForm({ site, floor, onCancel, onSaved }) {
  const isEdit = !!floor;
  const [name, setName] = useState(floor?.name || "");
  const [floorNumber, setFloorNumber] = useState(floor?.floor_number ?? "");
  const [description, setDescription] = useState(floor?.description || "");
  const [floorplanFile, setFloorplanFile] = useState(null);
  const [existingFloorplanUrl] = useState(floor?.floorplan_url || "");
  const [selectedPreview, setSelectedPreview] = useState("");
  const [totalArea, setTotalArea] = useState(floor?.total_area ?? "");
  const [isActive, setIsActive] = useState(floor?.is_active !== false);
  const [errors, setErrors] = useState({});
  const previewUrl = selectedPreview || (existingFloorplanUrl ? fileUrl(existingFloorplanUrl) : "");

  useEffect(() => {
    if (!floorplanFile) {
      setSelectedPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(floorplanFile);
    setSelectedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [floorplanFile]);

  const saving = useMutation({
    mutationFn: async ({ body, file }) => {
      if (isEdit) {
        const updated = await sitesApi.floors.update(floor.floor_id, body);
        if (file) return sitesApi.floors.replaceFloorplan(floor.floor_id, file);
        return updated;
      }
      return sitesApi.floors.createWithUpload({
        site_id: site.site_id,
        name: body.name,
        floor_number: body.floor_number,
        description: body.description,
        total_area: body.total_area,
        file,
      });
    },
    onSuccess: () => {
      setErrors({});
      toast.success(isEdit ? "Floor updated" : "Floor created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!isEdit && !floorplanFile) next.floorplan = "Floor plan image is required";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      floor_number: floorNumber === "" ? null : Number(floorNumber),
      description: description.trim() || null,
      total_area: totalArea === "" ? null : Number(totalArea),
    };
    if (isEdit) body.is_active = isActive;
    saving.mutate({ body, file: floorplanFile });
  }

  function onPick(e) {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.type)) {
      toast.error("Use PNG, JPEG, WEBP, or SVG image");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Floor plan image must be 8 MiB or smaller");
      return;
    }
    setErrors((p) => {
      const n = { ...p };
      delete n.floorplan;
      return n;
    });
    setFloorplanFile(file);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit floor · ${floor.name}` : "Add floor"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FieldLabel required>Name</FieldLabel>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="Enter floor name"
            className={`${fieldClass} ${errors.name ? "!border-red-500" : ""}`}
          />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <FInput label="Floor number" type="number" value={floorNumber} onChange={setFloorNumber} placeholder="0 for ground" />
        <FInput label="Total area (m²)" type="number" step="any" value={totalArea} onChange={setTotalArea} placeholder="Total area in m²" />
        <div>
          <FieldLabel required={!isEdit}>Floor plan image</FieldLabel>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={onPick}
            className="mt-1 block w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground"
          />
          <p className="mt-1 text-[11px] text-muted">Allowed: PNG, JPEG, WEBP, SVG (max 8 MiB)</p>
          {errors.floorplan && <p className="mt-1 text-xs text-red-500">{errors.floorplan}</p>}
          <div className="mt-3">
            <ImagePreviewCard
              title="Preview"
              subtitle={
                floorplanFile
                  ? `${floorplanFile.name} · ${(floorplanFile.size / (1024 * 1024)).toFixed(2)} MiB`
                  : existingFloorplanUrl
                    ? "Currently uploaded floor plan"
                    : "No floor plan uploaded yet"
              }
              imageUrl={previewUrl}
              emptyText="Current uploaded image will appear here"
            />
          </div>
        </div>
        <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Floor description (optional)" />
        {isEdit && <FCheckbox label="Active" value={isActive} onChange={setIsActive} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending || (!isEdit && !floorplanFile)} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create floor"}
        </Button>
      </div>
    </form>
  );
}
