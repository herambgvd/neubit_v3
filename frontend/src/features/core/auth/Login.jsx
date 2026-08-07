"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, apiError, tokens } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { FullPageLoader } from "@/components/ui/kit";

import NeubitAuthShell from "./components/NeubitAuthShell";
import { LoginForm } from "./components/LoginForm";
import { MfaForm } from "./components/MfaForm";

export default function LoginPage() {
  const { login, loginMfa, status } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState("");
  // Set post-mount only — reading localStorage during render would desync SSR.
  const [hadToken, setHadToken] = useState(false);

  useEffect(() => setHadToken(!!tokens.access), []);

  // Already signed in → the login page is a dead end; bounce to the console.
  useEffect(() => {
    if (status === "authed") router.replace("/home");
  }, [status, router]);

  // First run (no users yet) → setup wizard.
  useEffect(() => {
    api.get("/auth/setup-status").then((r) => {
      if (r.data?.needs_setup) router.replace("/setup");
    }).catch(() => {});
  }, [router]);

  // Hold the form back while a stored token is still being validated, so a
  // signed-in operator never sees the sign-in screen flash before the redirect.
  if (status === "authed" || (hadToken && status === "loading")) {
    return <FullPageLoader label="Redirecting" />;
  }

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
      // The backend's generic 422 envelope says nothing useful to an operator.
      setError(msg === "Request validation failed" ? "Check your email and password, then try again." : msg);
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
    <NeubitAuthShell>
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
    </NeubitAuthShell>
  );
}
