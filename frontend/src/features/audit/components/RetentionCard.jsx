"use client";

// Admin-only card: view/adjust audit retention and purge old entries now.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Card, ConfirmDialog, Input } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";

export default function RetentionCard() {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ["audit-retention"],
    queryFn: () => api.get("/audit/retention").then((r) => r.data),
  });
  const [days, setDays] = useState("");
  const [confirm, setConfirm] = useState(null);
  useEffect(() => {
    if (info.data) setDays(String(info.data.retention_days ?? 0));
  }, [info.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["audit-retention"] });
    qc.invalidateQueries({ queryKey: ["audit"] });
  };

  const savePolicy = useMutation({
    mutationFn: () => api.put("/settings", { values: { audit_retention_days: Number(days) || 0 } }),
    onSuccess: () => {
      invalidate();
      toast.success("Retention policy saved");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const purge = useMutation({
    mutationFn: () => api.post("/audit/purge", {}),
    onSuccess: (r) => {
      invalidate();
      setConfirm(null);
      toast.success(`Purged ${r.data.deleted} entr${r.data.deleted === 1 ? "y" : "ies"}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const policyDays = Number(days) || 0;

  return (
    <Card className="p-5 mb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Data retention</h2>
          <p className="text-xs text-muted mt-0.5">
            {info.data ? `${info.data.total} entries stored.` : "—"} Automatically delete entries
            older than the window below. 0 keeps them forever.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-40">
            <Input
              label="Retention (days)"
              type="number"
              min="0"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <Button variant="primary" disabled={savePolicy.isPending} onClick={() => savePolicy.mutate()}>
            {savePolicy.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="danger"
            icon="heroicons-outline:trash"
            disabled={purge.isPending || policyDays <= 0}
            title={policyDays <= 0 ? "Set a positive retention window first" : "Delete entries older than the window now"}
            onClick={() =>
              setConfirm({
                title: "Purge audit entries",
                message: `Permanently delete audit entries older than ${policyDays} days? This cannot be undone.`,
                confirmLabel: "Purge now",
                onConfirm: () => purge.mutate(),
              })
            }
          >
            {purge.isPending ? "Purging…" : "Purge now"}
          </Button>
        </div>
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={purge.isPending} />
    </Card>
  );
}
