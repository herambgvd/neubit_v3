"use client";

// Single-frame snapshot preview for a saved camera. Fetches
// GET /vms/cameras/{id}/snapshot (JWT-authorized) as a blob → object URL, so the
// image request carries the bearer token (a plain <img src> wouldn't). This is the
// P1 stand-in for live video — the real player lands in P2.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { api } from "@/lib/api";
import { vms } from "../api";

export default function SnapshotModal({ camera, onClose }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get(vms.cameras.snapshotUrl(camera.id), { responseType: "blob" })
      .then((r) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.data);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError("Snapshot unavailable — camera offline or media plane not connected (P2).");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [camera.id, nonce]);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Snapshot — ${camera.name}`}
      wide
      footer={
        <>
          <Button variant="secondary" icon="heroicons-outline:arrow-path" onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </Button>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-card-border bg-background">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-base" /> Grabbing frame…
          </span>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-sm text-muted">
            <Icon icon="heroicons-outline:exclamation-triangle" className="text-2xl text-amber-500" />
            {error}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`${camera.name} snapshot`} className="max-h-full max-w-full object-contain" />
        )}
      </div>
    </Modal>
  );
}
