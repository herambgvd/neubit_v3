"use client";

// 2FA-enforcement policy (P6-D). Enforce two-factor across the tenant, optionally
// narrowed to specific roles, plus an idle-session timeout. GET/PUT /security/policy.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Input, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { security } from "../api";
import SecuritySection from "./SecuritySection";

export default function PolicyCard({ canManage }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["security-policy"], queryFn: () => security.policy.get() });

  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!q.data) return;
    setForm({
      require_2fa: q.data.require_2fa ?? false,
      require_2fa_roles: (q.data.require_2fa_roles || []).join(", "),
      session_idle_minutes: q.data.session_idle_minutes ?? 0,
    });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      security.policy.update({
        require_2fa: form.require_2fa,
        require_2fa_roles: form.require_2fa_roles
          .split(/[,\n]/)
          .map((r) => r.trim())
          .filter(Boolean),
        session_idle_minutes: Number(form.session_idle_minutes) || 0,
      }),
    onSuccess: () => {
      toast.success("2FA policy saved");
      qc.invalidateQueries({ queryKey: ["security-policy"] });
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  return (
    <SecuritySection
      title="Two-factor authentication policy"
      desc="Enforce TOTP two-factor for users. Users who log in without an enrolled second factor are required to enroll before they can continue."
      icon="heroicons-outline:shield-check"
      loading={q.isLoading || !form}
      error={q.isError ? apiError(q.error, "Failed to load policy") : null}
      action={
        canManage &&
        form && (
          <Button variant="primary" icon="heroicons-outline:check" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )
      }
    >
      {form && (
        <div className="space-y-4">
          <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
            <div>
              <span className="text-sm text-foreground">Require 2FA</span>
              <p className="text-xs text-muted">Force all users (or the roles below) to enroll a second factor.</p>
            </div>
            <Toggle
              checked={form.require_2fa}
              onChange={(v) => setForm((f) => ({ ...f, require_2fa: v }))}
              disabled={!canManage}
            />
          </label>
          <Input
            label="Restrict to roles (optional, comma-separated)"
            value={form.require_2fa_roles}
            onChange={(e) => setForm((f) => ({ ...f, require_2fa_roles: e.target.value }))}
            disabled={!canManage || !form.require_2fa}
            placeholder="admin, operator (blank = everyone)"
            hint="Leave blank to enforce for every user. Enter role names to enforce only for those roles."
          />
          <Input
            label="Session idle timeout (minutes)"
            type="number"
            value={form.session_idle_minutes}
            onChange={(e) => setForm((f) => ({ ...f, session_idle_minutes: e.target.value }))}
            disabled={!canManage}
            placeholder="0 = no idle timeout"
            hint="Sign users out after this many minutes of inactivity. 0 disables the idle timeout."
          />
        </div>
      )}
    </SecuritySection>
  );
}
