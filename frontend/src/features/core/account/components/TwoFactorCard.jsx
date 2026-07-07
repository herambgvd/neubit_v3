"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge, Button, Card, Input, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { groupSecret } from "../format";
import RecoveryCodes from "./RecoveryCodes";

export default function TwoFactorCard() {
  const qc = useQueryClient();
  const { reload } = useAuth();
  const status = useQuery({
    queryKey: ["my-2fa"],
    queryFn: () => api.get("/auth/me/2fa").then((r) => r.data),
  });
  const enabled = status.data?.enabled;

  // Local flow state: 'idle' | 'enrolling' (secret shown, awaiting code) | codes shown.
  const [setup, setSetup] = useState(null); // { secret, otpauth_uri }
  const [code, setCode] = useState("");
  const [newCodes, setNewCodes] = useState(null);
  // For the enabled state: disabling / regenerating both need a current code.
  const [manageCode, setManageCode] = useState("");

  const begin = useMutation({
    mutationFn: () => api.post("/auth/me/2fa/setup").then((r) => r.data),
    onSuccess: (d) => {
      setSetup(d);
      setCode("");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const confirm = useMutation({
    mutationFn: () => api.post("/auth/me/2fa/confirm", { code: code.trim() }).then((r) => r.data),
    onSuccess: async (d) => {
      setSetup(null);
      setNewCodes(d.recovery_codes);
      await Promise.all([reload(), qc.invalidateQueries({ queryKey: ["my-2fa"] })]);
      toast.success("Two-factor authentication enabled");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const disable = useMutation({
    mutationFn: () => api.post("/auth/me/2fa/disable", { code: manageCode.trim() }),
    onSuccess: async () => {
      setManageCode("");
      await Promise.all([reload(), qc.invalidateQueries({ queryKey: ["my-2fa"] })]);
      toast.success("Two-factor authentication disabled");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const regen = useMutation({
    mutationFn: () =>
      api.post("/auth/me/2fa/recovery-codes", { code: manageCode.trim() }).then((r) => r.data),
    onSuccess: async (d) => {
      setManageCode("");
      setNewCodes(d.recovery_codes);
      await qc.invalidateQueries({ queryKey: ["my-2fa"] });
      toast.success("New recovery codes generated");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            Two-factor authentication
            <Badge color={enabled ? "green" : "neutral"}>{enabled ? "On" : "Off"}</Badge>
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Require a time-based code from an authenticator app at sign-in.
          </p>
        </div>
        <Icon icon="heroicons-outline:shield-check" className={`text-2xl ${enabled ? "text-green-500" : "text-muted"}`} />
      </div>

      {/* Freshly generated recovery codes take over the card until dismissed. */}
      {newCodes ? (
        <RecoveryCodes codes={newCodes} onClose={() => setNewCodes(null)} />
      ) : status.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : enabled ? (
        // --- enabled: regenerate codes / disable ---
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {status.data?.recovery_codes_remaining ?? 0} recovery code(s) remaining. Enter a current
            authenticator or recovery code to make changes.
          </p>
          <Input
            label="Authentication code"
            value={manageCode}
            onChange={(e) => setManageCode(e.target.value)}
            placeholder="123456"
          />
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!manageCode.trim() || regen.isPending} onClick={() => regen.mutate()}>
              {regen.isPending ? "Working…" : "Regenerate recovery codes"}
            </Button>
            <Button variant="danger" disabled={!manageCode.trim() || disable.isPending} onClick={() => disable.mutate()}>
              {disable.isPending ? "Working…" : "Disable 2FA"}
            </Button>
          </div>
        </div>
      ) : setup ? (
        // --- enrolling: show secret, ask for first code ---
        <div className="space-y-3">
          <p className="text-xs text-muted">
            In your authenticator app (Google Authenticator, Authy, 1Password…), add a new account
            and enter this setup key:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-card-border bg-hover/40 px-3 py-2 font-mono text-sm tracking-wider text-foreground break-all">
              {groupSecret(setup.secret)}
            </code>
            <Button
              variant="ghost"
              icon="heroicons-outline:clipboard-document"
              onClick={() => {
                navigator.clipboard?.writeText(setup.secret);
                toast.success("Setup key copied");
              }}
            />
          </div>
          <Input
            label="Enter the 6-digit code to confirm"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
          <div className="flex gap-2">
            <Button variant="primary" disabled={!code.trim() || confirm.isPending} onClick={() => confirm.mutate()}>
              {confirm.isPending ? "Verifying…" : "Verify & enable"}
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        // --- disabled: start enrolment ---
        <Button variant="primary" icon="heroicons-outline:shield-check" disabled={begin.isPending} onClick={() => begin.mutate()}>
          {begin.isPending ? "Preparing…" : "Enable two-factor authentication"}
        </Button>
      )}
    </Card>
  );
}
