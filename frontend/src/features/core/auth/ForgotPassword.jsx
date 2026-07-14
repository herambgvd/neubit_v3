"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import AuthShell, { AuthInput, AuthLabel, AuthSubmit } from "@/components/AuthShell";

// Two-step reset: (1) request a token by email, (2) enter the token + new password.
// An invite/reset email links here with ?token=... so we jump straight to step 2.
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState("request"); // "request" | "reset"
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // If the user arrived from an emailed link (?token=...), prefill + skip to step 2.
  // Read from window.location directly to avoid the useSearchParams Suspense rule.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) {
      setToken(t);
      setStep("reset");
    }
  }, []);

  async function requestReset(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/auth/forgot-password", { email });
      toast.success("If that account exists, a reset token was emailed");
      setStep("reset");
    } catch (err) {
      toast.error(apiError(err, "Could not request reset"));
    } finally {
      setBusy(false);
    }
  }

  async function doReset(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { token, new_password: password });
      toast.success("Password updated — sign in");
      router.push("/login");
    } catch (err) {
      toast.error(apiError(err, "Reset failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Reset"
      title="Reset your password"
      subtitle={
        step === "request"
          ? "Enter your email and we'll send a reset token."
          : "Enter the token from your email and choose a new password."
      }
    >
      {step === "request" ? (
        <form onSubmit={requestReset} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="email">Work email</AuthLabel>
            <AuthInput
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <AuthSubmit loading={busy}>Send reset token</AuthSubmit>
        </form>
      ) : (
        <form onSubmit={doReset} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="token">Reset token</AuthLabel>
            <AuthInput
              id="token"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste token from email"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <AuthLabel htmlFor="new-password">New password</AuthLabel>
            <AuthInput
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>
          <AuthSubmit loading={busy}>Set new password</AuthSubmit>
          <button
            type="button"
            onClick={() => setStep("request")}
            className="w-full text-center text-xs text-white/40 transition hover:text-white/70"
          >
            Didn&apos;t get it? Request again
          </button>
        </form>
      )}

      <div className="mt-6 text-center">
        <Link href="/login" className="font-mono text-[11px] text-white/40 transition hover:text-white/70">
          ← Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
