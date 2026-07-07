"use client";

// Floorplan upload modal for the floor-plan editor. Ported from neubit_v2 → kit + tokens.
import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { sites } from "@/lib/api/sites";

const ACCEPT = "image/png,image/jpeg,image/svg+xml,image/webp";
const ACCEPT_DISPLAY = "PNG · JPG · SVG · WEBP";
const MAX_BYTES = 8 * 1024 * 1024;

export function FloorUploadModal({ open, onClose, floor, onUploaded }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const reset = () => {
    setFile(null);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const close = () => {
    if (uploading) return;
    reset();
    onClose?.();
  };

  const onPick = (f) => {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.error(`File exceeds ${Math.round(MAX_BYTES / (1024 * 1024))} MB`);
      return;
    }
    setFile(f);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    onPick(e.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!file || !floor) return;
    setUploading(true);
    try {
      const updated = await sites.floors.replaceFloorplan(floor.floor_id, file);
      toast.success("Floor plan uploaded");
      onUploaded?.(updated);
      reset();
      onClose?.();
    } catch (err) {
      toast.error(apiError(err, "Upload failed"));
    } finally {
      setUploading(false);
    }
  };

  if (!floor) return null;

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={`Upload floor plan — ${floor.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || uploading} icon="heroicons-outline:arrow-up-tray">
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">Accepted formats: {ACCEPT_DISPLAY}. Max 8 MB.</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          dragOver ? "border-blue-500 bg-blue-500/10" : "border-card-border bg-hover/40 hover:bg-hover"
        }`}
      >
        <Icon icon="heroicons-outline:document-arrow-up" className="mb-2 text-3xl text-muted" />
        <div className="text-sm font-medium text-foreground">
          {file ? file.name : "Drop a file here or click to browse"}
        </div>
        <div className="mt-1 text-xs text-muted">
          {file ? `${Math.round(file.size / 1024)} KB · ${file.type || "unknown"}` : ACCEPT_DISPLAY}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </div>

      {floor.floorplan_url && !file && (
        <div className="mt-4 rounded-md border border-card-border bg-hover/40 px-3 py-2 text-xs text-muted">
          Existing floor plan will be replaced.
        </div>
      )}
    </Modal>
  );
}
