"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button, Card, Input } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import TwoFactorCard from "./TwoFactorCard";

export default function SecurityTab() {
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm: "" });
  const change = useMutation({
    mutationFn: () =>
      api.post("/auth/change-password", {
        current_password: form.current_password,
        new_password: form.new_password,
      }),
    onSuccess: () => {
      toast.success("Password changed. Other devices will be signed out.");
      setForm({ current_password: "", new_password: "", confirm: "" });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const mismatch = form.confirm.length > 0 && form.new_password !== form.confirm;
  const canSubmit = form.current_password && form.new_password && !mismatch && !change.isPending;

  return (
    <div className="grid gap-6 lg:grid-cols-2 items-start">
      <Card className="p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Change password</h2>
        <Input
          label="Current password"
          type="password"
          value={form.current_password}
          onChange={(e) => setForm({ ...form, current_password: e.target.value })}
        />
        <Input
          label="New password"
          type="password"
          value={form.new_password}
          onChange={(e) => setForm({ ...form, new_password: e.target.value })}
          hint="At least 8 characters, with a letter and a number. Cannot reuse a recent password."
        />
        <Input
          label="Confirm new password"
          type="password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
        />
        {mismatch && <p className="text-xs text-red-500">Passwords do not match.</p>}
        <Button variant="primary" disabled={!canSubmit} onClick={() => change.mutate()}>
          {change.isPending ? "Updating…" : "Update password"}
        </Button>
      </Card>

      <TwoFactorCard />
    </div>
  );
}
