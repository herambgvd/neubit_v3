"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError, tokens } from "@/lib/api";
import AuthShell, { AuthInput, AuthLabel, AuthSubmit, AuthError } from "@/components/AuthShell";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Second-factor challenge state.
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");

  function finish(data) {
    if (!data?.access_token) {
      throw new Error("This account cannot access the admin console.");
    }
    tokens.set(data.access_token);
    toast.success("Signed in");
    router.push("/dashboard");
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const data = await adminApi.login(email.trim(), password);
      if (data?.mfa_required) {
        // First factor OK — switch to the code step.
        setMfaToken(data.mfa_token);
        setBusy(false);
        return;
      }
      finish(data);
    } catch (err) {
      const msg = apiError(err, "Login failed");
      setError(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  async function onSubmitMfa(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      finish(await adminApi.loginMfa(mfaToken, code.trim()));
    } catch (err) {
      const msg = apiError(err, "Invalid code");
      setError(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  if (mfaToken) {
    return (
      <AuthShell
        productName="Neubit"
        eyebrow="Two-factor authentication"
        title="Enter your code"
        subtitle="Open your authenticator app and enter the 6-digit code, or use a recovery code."
      >
        <form onSubmit={onSubmitMfa} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="code">Authentication code</AuthLabel>
            <AuthInput
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoFocus
              required
              className="text-center text-lg tracking-[0.4em]"
            />
          </div>
          <AuthError>{error}</AuthError>
          <AuthSubmit loading={busy}>Verify &amp; sign in</AuthSubmit>
          <button
            type="button"
            onClick={() => {
              setMfaToken("");
              setCode("");
              setError("");
            }}
            className="w-full text-center text-xs text-muted transition hover:text-foreground"
          >
            ← Back to sign in
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      productName="Neubit"
      eyebrow="Super-admin"
      title="Neubit Admin"
      subtitle="Platform super-admin console — manage tenants, licenses and access."
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <AuthLabel htmlFor="email">Work email</AuthLabel>
          <AuthInput
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your email"
            autoFocus
            required
          />
        </div>

        <div className="space-y-1.5">
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <div className="relative">
            <AuthInput
              id="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition"
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <AuthError>{error}</AuthError>
        <AuthSubmit loading={busy}>Sign in to console</AuthSubmit>
        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
          <ShieldCheck className="h-3.5 w-3.5" />
          Protected by two-factor authentication when enabled.
        </p>
      </form>
    </AuthShell>
  );
}
