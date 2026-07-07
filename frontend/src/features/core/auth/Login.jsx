"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import AuthShell from "@/components/AuthShell";

import { LoginForm } from "./components/LoginForm";
import { MfaForm } from "./components/MfaForm";

export default function LoginPage() {
  const { login, loginMfa } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        <MfaForm
          code={code}
          setCode={setCode}
          error={error}
          busy={busy}
          onSubmit={onSubmitCode}
          onBack={() => { setMfaToken(null); setCode(""); setError(""); }}
        />
      ) : (
        <LoginForm
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          error={error}
          busy={busy}
          onSubmit={onSubmit}
        />
      )}
    </AuthShell>
  );
}
