"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import NeubitAuthShell, {
  NbLabel,
  NbInput,
  NbSubmit,
} from "@/features/core/auth/components/NeubitAuthShell";

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
    <NeubitAuthShell>
      <h2 className="text-[19px] font-[650] tracking-[0.2px] text-[#f2f6ff]">
        Reset your password
      </h2>
      <p className="mb-5 mt-1 text-[11.5px] text-[#9a92c8]">
        {step === "request"
          ? "Enter your work email — we'll send a reset token."
          : "Enter the token from your email and choose a new password."}
      </p>

      {step === "request" ? (
        <form onSubmit={requestReset} noValidate>
          <div className="mb-3">
            <NbLabel>WORK EMAIL</NbLabel>
            <NbInput
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div className="mt-4">
            <NbSubmit loading={busy}>SEND RESET TOKEN →</NbSubmit>
          </div>
        </form>
      ) : (
        <form onSubmit={doReset} noValidate>
          <div className="mb-3">
            <NbLabel>RESET TOKEN</NbLabel>
            <NbInput
              id="token"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste token from email"
              className="font-mono"
            />
          </div>
          <div className="mb-3">
            <NbLabel>NEW PASSWORD</NbLabel>
            <NbInput
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>
          <div className="mt-4">
            <NbSubmit loading={busy}>SET NEW PASSWORD →</NbSubmit>
          </div>
          <button
            type="button"
            onClick={() => setStep("request")}
            className="mt-3 w-full text-center text-[11px] text-[#9a92c8] transition hover:text-[#cfd0f2]"
          >
            Didn&apos;t get it? Request again
          </button>
        </form>
      )}

      <div className="mt-5 border-t border-[rgba(160,150,245,.2)] pt-4 text-center">
        <Link
          href="/login"
          className="font-mono text-[11px] text-[#c4b5fd] transition hover:text-[#f2f6ff]"
        >
          ← Back to sign in
        </Link>
      </div>
    </NeubitAuthShell>
  );
}
