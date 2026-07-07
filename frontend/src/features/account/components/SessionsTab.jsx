"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Badge, Button, Card, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { deviceLabel, fmt } from "../format";

export default function SessionsTab() {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () => api.get("/auth/me/sessions").then((r) => r.data),
  });

  const revoke = useMutation({
    mutationFn: (id) => api.delete(`/auth/me/sessions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-sessions"] });
      toast.success("Session revoked");
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post("/auth/me/sessions/revoke-others"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-sessions"] });
      toast.success("Signed out of other devices");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const items = sessions.data || [];
  const hasOthers = items.some((s) => !s.current);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Active sessions</h2>
          <p className="text-xs text-muted mt-0.5">Devices currently signed in to your account.</p>
        </div>
        {hasOthers && (
          <Button variant="secondary" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
            {revokeOthers.isPending ? "Working…" : "Sign out others"}
          </Button>
        )}
      </div>

      {sessions.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-card-border">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <div className="h-9 w-9 rounded-full bg-hover flex items-center justify-center shrink-0">
                <Icon icon="heroicons-outline:computer-desktop" className="text-base text-muted" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground flex items-center gap-2">
                  {deviceLabel(s.user_agent)}
                  {s.current && <Badge color="green">This device</Badge>}
                </div>
                <div className="text-xs text-muted truncate">
                  {s.ip || "unknown IP"} · active {fmt(s.last_used_at || s.created_at)}
                </div>
              </div>
              {!s.current && (
                <Button variant="ghost" icon="heroicons-outline:trash" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
