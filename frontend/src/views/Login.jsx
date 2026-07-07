"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import AuthShell, { AuthInput, AuthLabel, AuthSubmit, AuthError } from "@/components/AuthShell";

export default function LoginPage() {
  const { login, loginMfa } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState("");

  // First run (no users yet) → setup wizard.
  useEffect(() => {
    api.get("/auth/setup-status").then((r) => {
      if (r.data?.needs_setup) router.replace("/setup");
    }).catch(() => {});
  }, [router]);

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await login(email.trim(), password);
      if (res?.mfaRequired) {
        setMfaToken(res.mfaToken);
        setCode("");
        return;
      }
      toast.success("Signed in");
      router.push("/home");
    } catch (err) {
      const msg = apiError(err, "Login failed");
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await loginMfa(mfaToken, code.trim());
      toast.success("Signed in");
      router.push("/home");
    } catch (err) {
      setError(apiError(err, "Invalid code"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      productName="Neubit"
      eyebrow={mfaToken ? "Two-Factor" : "Sign In"}
      title={mfaToken ? "Verify it's you" : "Sign in to Neubit"}
      subtitle={
        mfaToken
          ? "Enter the 6-digit code from your authenticator app to finish signing in."
          : "Use your operator credentials to access the console."
      }
    >
      {mfaToken ? (
        <form onSubmit={onSubmitCode} className="space-y-5" noValidate>
          <div className="flex items-start gap-3 rounded-lg border border-cyan-400/20 bg-cyan-500/5 px-3 py-2.5">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div className="text-xs text-slate-300">
              Open your authenticator app and enter the current 6-digit code. You can also use a backup code.
            </div>
          </div>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="mfa-code">Authentication code</AuthLabel>
            <AuthInput
              id="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoFocus
              required
              className="text-center text-base font-mono tracking-[0.4em]"
            />
          </div>
          <AuthError>{error}</AuthError>
          <AuthSubmit loading={busy}>Verify and sign in</AuthSubmit>
          <button
            type="button"
            onClick={() => { setMfaToken(null); setCode(""); setError(""); }}
            className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition"
          >
            ← Use a different account
          </button>
        </form>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="email">Work email</AuthLabel>
            <AuthInput
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </div>
          <div className="space-y-1.5">
            <AuthLabel
              htmlFor="password"
              action={
                <Link href="/forgot-password" className="text-xs font-medium text-cyan-300 hover:text-cyan-200">
                  Forgot password?
                </Link>
              }
            >
              Password
            </AuthLabel>
            <div className="relative">
              <AuthInput
                id="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="pr-10"
                required
              />
              <button
                type="button"
                aria-label={show ? "Hide password" : "Show password"}
                onClick={() => setShow((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <AuthError>{error}</AuthError>
          <AuthSubmit loading={busy}>Sign in</AuthSubmit>
          <p className="text-center text-xs text-slate-500">
            By continuing you agree to your organization&apos;s acceptable use policy.
          </p>
        </form>
      )}
    </AuthShell>
  );
}
