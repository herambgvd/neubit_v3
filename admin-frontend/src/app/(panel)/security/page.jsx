"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Monitor,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { toast } from "sonner";
import * as yup from "yup";

import { adminApi, apiError } from "@/lib/api";
import { useAdminForm } from "@/lib/useAdminForm";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  PageHeader,
  PasswordInput,
  QrCode,
  Skeleton,
} from "@/components/ui";

export default function SecurityPage() {
  return (
    <div>
      <PageHeader
        title="Security"
        description="Protect your super-admin account with two-factor authentication and manage active sessions."
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ChangePasswordCard />
        <TwoFactorCard />
        <div className="lg:col-span-2">
          <SessionsCard />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Two-factor -------------------------------- */

function TwoFactorCard() {
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["2fa"], queryFn: adminApi.twoFactorStatus });
  const enabled = !!data?.enabled;
  const refresh = () => qc.invalidateQueries({ queryKey: ["2fa"] });

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-accent">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Two-factor authentication</CardTitle>
            <p className="mt-0.5 text-xs text-muted">A time-based code (TOTP) required at every sign-in.</p>
          </div>
        </div>
        {!isLoading &&
          (enabled ? (
            <Badge tone="success" dot>
              Enabled
            </Badge>
          ) : (
            <Badge tone="warning" dot>
              Disabled
            </Badge>
          ))}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 rounded-lg" />
        ) : enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted">
              {data.recovery_codes_remaining} recovery code
              {data.recovery_codes_remaining === 1 ? "" : "s"} remaining.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setRegenerating(true)}>
                Regenerate recovery codes
              </Button>
              <Button variant="danger-outline" onClick={() => setDisabling(true)}>
                <ShieldOff className="h-4 w-4" /> Disable
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-md text-sm text-muted">
              Add a second layer of protection. You&apos;ll need an authenticator app such as Google
              Authenticator, 1Password, or Authy.
            </p>
            <Button onClick={() => setWizard(true)}>
              <ShieldCheck className="h-4 w-4" /> Enable 2FA
            </Button>
          </div>
        )}
      </CardContent>

      {wizard && (
        <SetupWizard
          open={wizard}
          onOpenChange={setWizard}
          onDone={() => {
            setWizard(false);
            refresh();
          }}
        />
      )}
      <CodeConfirmDialog
        open={disabling}
        onOpenChange={setDisabling}
        title="Disable two-factor authentication?"
        description="Enter a current authenticator or recovery code to turn off 2FA."
        confirmLabel="Disable 2FA"
        variant="danger"
        action={(code) => adminApi.twoFactorDisable(code)}
        onSuccess={() => {
          toast.success("Two-factor authentication disabled");
          setDisabling(false);
          refresh();
        }}
      />
      <RegenerateDialog open={regenerating} onOpenChange={setRegenerating} onDone={refresh} />
    </Card>
  );
}

function SetupWizard({ open, onOpenChange, onDone }) {
  const [step, setStep] = useState("scan"); // scan → codes
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState([]);

  const setupQ = useQuery({
    queryKey: ["2fa", "setup"],
    queryFn: adminApi.twoFactorSetup,
    enabled: open && step === "scan",
    staleTime: 0,
    gcTime: 0,
  });

  const confirm = useMutation({
    mutationFn: () => adminApi.twoFactorConfirm(code.trim()),
    onSuccess: (res) => {
      setRecovery(res?.recovery_codes || []);
      setStep("codes");
      toast.success("Two-factor authentication enabled");
    },
    onError: (err) => toast.error(apiError(err, "Invalid code")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {step === "scan" ? (
          <>
            <DialogHeader
              title="Set up authenticator"
              description="Scan this QR code with your authenticator app, then enter the 6-digit code it shows."
            />
            <div className="flex flex-col items-center gap-4">
              {setupQ.isLoading ? (
                <Skeleton className="h-48 w-48 rounded-lg" />
              ) : setupQ.isError ? (
                <p className="text-sm text-danger">{apiError(setupQ.error, "Could not start setup")}</p>
              ) : (
                <>
                  <QrCode value={setupQ.data?.otpauth_uri} />
                  <div className="w-full rounded-lg border border-card-border bg-hover px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-muted">Manual entry key</div>
                    <div className="select-all break-all font-mono text-xs text-foreground">
                      {setupQ.data?.secret}
                    </div>
                  </div>
                </>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (code.trim()) confirm.mutate();
                }}
                className="w-full space-y-3"
              >
                <Field label="Verification code">
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    className="text-center text-lg tracking-[0.4em]"
                  />
                </Field>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={confirm.isPending} disabled={!code.trim()}>
                    Verify &amp; enable
                  </Button>
                </DialogFooter>
              </form>
            </div>
          </>
        ) : (
          <>
            <DialogHeader
              title="Save your recovery codes"
              description="Store these somewhere safe. Each code works once if you lose your authenticator. They won't be shown again."
            />
            <RecoveryCodes codes={recovery} />
            <DialogFooter>
              <Button onClick={onDone}>
                <Check className="h-4 w-4" /> I&apos;ve saved them
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RegenerateDialog({ open, onOpenChange, onDone }) {
  const [recovery, setRecovery] = useState(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setRecovery(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        {recovery ? (
          <>
            <DialogHeader
              title="New recovery codes"
              description="Your old codes are now invalid. Save these somewhere safe."
            />
            <RecoveryCodes codes={recovery} />
            <DialogFooter>
              <Button
                onClick={() => {
                  setRecovery(null);
                  onOpenChange(false);
                  onDone?.();
                }}
              >
                <Check className="h-4 w-4" /> Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <CodeConfirmBody
            title="Regenerate recovery codes"
            description="Enter a current authenticator or recovery code to generate a fresh set."
            confirmLabel="Regenerate"
            action={(code) => adminApi.twoFactorRecoveryCodes(code)}
            onCancel={() => onOpenChange(false)}
            onSuccess={(res) => setRecovery(res?.recovery_codes || [])}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecoveryCodes({ codes }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => codes.join("\n"), [codes]);

  function copy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  function download() {
    const blob = new Blob([text + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neubit-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-card-border bg-hover p-4 font-mono text-sm">
        {codes.map((c) => (
          <div key={c} className="select-all text-center text-foreground">
            {c}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="outline" size="sm" onClick={download}>
          <Download className="h-3.5 w-3.5" /> Download
        </Button>
      </div>
    </div>
  );
}

// A dialog that collects a TOTP/recovery code and runs `action(code)`.
function CodeConfirmDialog({ open, onOpenChange, title, description, confirmLabel, variant, action, onSuccess }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <CodeConfirmBody
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          variant={variant}
          action={action}
          onCancel={() => onOpenChange(false)}
          onSuccess={onSuccess}
        />
      </DialogContent>
    </Dialog>
  );
}

function CodeConfirmBody({ title, description, confirmLabel, variant = "primary", action, onCancel, onSuccess }) {
  const [code, setCode] = useState("");
  const mut = useMutation({
    mutationFn: () => action(code.trim()),
    onSuccess: (res) => onSuccess?.(res),
    onError: (err) => toast.error(apiError(err, "Invalid code")),
  });
  return (
    <>
      <DialogHeader title={title} description={description} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) mut.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Authenticator or recovery code">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="text-center text-lg tracking-[0.4em]"
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant={variant} loading={mut.isPending} disabled={!code.trim()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/* ----------------------------- Change password ----------------------------- */

const pwSchema = yup.object({
  current_password: yup.string().required("Current password is required"),
  new_password: yup.string().min(8, "At least 8 characters").required("New password is required"),
  confirm_password: yup
    .string()
    .oneOf([yup.ref("new_password")], "Passwords do not match")
    .required("Please confirm your password"),
});

function ChangePasswordCard() {
  const form = useAdminForm(pwSchema, {
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const { errors } = form.formState;

  const save = useMutation({
    mutationFn: (v) => adminApi.changePassword(v.current_password, v.new_password),
    onSuccess: () => {
      form.reset();
      toast.success("Password changed — please sign in again");
      // Force a fresh login with the new password (also clears the refresh cookie).
      // Hard-navigate so no stale cached session survives.
      adminApi.logout();
      setTimeout(() => {
        window.location.href = "/login";
      }, 900);
    },
    onError: (err) => toast.error(apiError(err, "Could not change password")),
  });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-accent">
          <KeyRound className="h-4 w-4" />
        </div>
        <div>
          <CardTitle>Password</CardTitle>
          <p className="mt-0.5 text-xs text-muted">Change the password for your super-admin account.</p>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Current password" required error={errors.current_password?.message} className="sm:col-span-2">
            <PasswordInput autoComplete="current-password" invalid={!!errors.current_password} {...form.register("current_password")} />
          </Field>
          <Field label="New password" required error={errors.new_password?.message}>
            <PasswordInput autoComplete="new-password" invalid={!!errors.new_password} {...form.register("new_password")} />
          </Field>
          <Field label="Confirm new password" required error={errors.confirm_password?.message}>
            <PasswordInput autoComplete="new-password" invalid={!!errors.confirm_password} {...form.register("confirm_password")} />
          </Field>
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" loading={save.isPending}>
              Update password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- Sessions --------------------------------- */

function fmtTs(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Best-effort friendly device name from a user-agent string.
function deviceName(ua) {
  if (!ua) return "Unknown device";
  const browser = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

function SessionsCard() {
  const qc = useQueryClient();
  const [revokeOthers, setRevokeOthers] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["sessions"], queryFn: adminApi.listSessions });
  const sessions = Array.isArray(data) ? data : [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });

  const revokeOne = useMutation({
    mutationFn: (id) => adminApi.revokeSession(id),
    onSuccess: () => {
      toast.success("Session revoked");
      refresh();
    },
    onError: (err) => toast.error(apiError(err, "Could not revoke session")),
  });

  const revokeAll = useMutation({
    mutationFn: () => adminApi.revokeOtherSessions(),
    onSuccess: () => {
      toast.success("Signed out of other devices");
      setRevokeOthers(false);
      refresh();
    },
    onError: (err) => toast.error(apiError(err, "Could not revoke sessions")),
  });

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-accent">
            <Monitor className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Active sessions</CardTitle>
            <p className="mt-0.5 text-xs text-muted">Devices currently signed in to your account.</p>
          </div>
        </div>
        {sessions.length > 1 && (
          <Button variant="outline" size="sm" onClick={() => setRevokeOthers(true)}>
            Sign out others
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-5">
            <Skeleton className="h-10 rounded-lg" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="p-5 text-sm text-muted">No active sessions.</p>
        ) : (
          <ul className="divide-y divide-card-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{deviceName(s.user_agent)}</span>
                    {s.current && (
                      <Badge tone="accent" dot>
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {s.ip || "unknown IP"} · last active {fmtTs(s.last_used_at || s.created_at)}
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="danger-outline"
                    size="sm"
                    loading={revokeOne.isPending && revokeOne.variables === s.id}
                    onClick={() => revokeOne.mutate(s.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={revokeOthers}
        onOpenChange={setRevokeOthers}
        title="Sign out other devices?"
        description="Every session except this one will be signed out immediately."
        confirmLabel="Sign out others"
        loading={revokeAll.isPending}
        onConfirm={() => revokeAll.mutate()}
      />
    </Card>
  );
}
