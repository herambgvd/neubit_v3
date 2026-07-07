"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
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

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const data = await adminApi.login(email.trim(), password);
      // MFA is ignored for the admin console v1 — we only need the access token.
      if (!data?.access_token) {
        throw new Error("This account cannot access the admin console.");
      }
      tokens.set(data.access_token);
      toast.success("Signed in");
      router.push("/tenants");
    } catch (err) {
      const msg = apiError(err, "Login failed");
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
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
            placeholder="admin@yourcompany.com"
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
              placeholder="••••••••"
              required
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <AuthError>{error}</AuthError>
        <AuthSubmit loading={busy}>Sign in to console</AuthSubmit>
      </form>
    </AuthShell>
  );
}
