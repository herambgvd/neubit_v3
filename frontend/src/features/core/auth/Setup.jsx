"use client";

import { Icon } from "@iconify/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, apiError, tokens } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import AuthShell, { AuthInput, AuthLabel, AuthSubmit } from "@/components/AuthShell";

// First-run wizard: creates the very first administrator, then signs them in.
// Only reachable while the deployment has zero users (backend enforces this too).
export default function SetupPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const [form, setForm] = useState({ full_name: "", email: "", password: "", confirm: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  // If setup is already done, don't show the wizard.
  useEffect(() => {
    api
      .get("/auth/setup-status")
      .then((r) => {
        if (!r.data?.needs_setup) router.replace("/login");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const canSubmit = form.email && form.password && !mismatch && !busy;

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/setup", {
        email: form.email,
        password: form.password,
        full_name: form.full_name || null,
      });
      tokens.set(data.access_token, data.refresh_token);
      await reload();
      toast.success("Welcome — your workspace is ready");
      router.replace("/");
    } catch (err) {
      toast.error(apiError(err, "Setup failed"));
    } finally {
      setBusy(false);
    }
  }

  if (checking) return null;

  return (
    <AuthShell
      eyebrow="First-run setup"
      title="Welcome — let's get set up"
      subtitle="Create the first administrator account for this deployment."
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <AuthLabel htmlFor="full_name">Full name</AuthLabel>
          <AuthInput
            id="full_name"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            placeholder="Jane Doe"
          />
        </div>
        <div className="space-y-1.5">
          <AuthLabel htmlFor="email">Work email</AuthLabel>
          <AuthInput
            id="email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="admin@company.com"
          />
        </div>
        <div className="space-y-1.5">
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <div className="relative">
            <AuthInput
              id="password"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="At least 8 chars, a letter and a number"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 transition hover:text-white/70"
              aria-label={show ? "Hide password" : "Show password"}
            >
              <Icon icon={show ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <AuthLabel htmlFor="confirm">Confirm password</AuthLabel>
          <AuthInput
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            placeholder="Re-enter password"
          />
          {mismatch && <p className="mt-1 text-xs text-red-400">Passwords do not match.</p>}
        </div>
        <AuthSubmit loading={busy} disabled={!canSubmit}>
          Create admin &amp; continue
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
