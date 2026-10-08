"use client";

import { Icon } from "@iconify/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";

import { api, apiError, tokens } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { SetupStatus, TokenOut } from "../types";
import NeubitAuthShell, { NbError, NbFieldError, NbInput, NbLabel, NbSubmit } from "./components/NeubitAuthShell";

// First-run wizard: creates the very first administrator, then signs them in.
// Only reachable while the deployment has zero users (backend enforces this too).
// A deployment can also keep setup to the server itself (the native appliance:
// it answers on the LAN before anyone owns it); a browser elsewhere is then told
// where to finish instead of being shown a form the server will refuse.
//
// Same shell as the sign-in page: this is the first screen an operator sees on a
// fresh install, and the one they see every day after it must look like it.
export default function SetupPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const [form, setForm] = useState({ full_name: "", email: "", password: "", confirm: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [elsewhere, setElsewhere] = useState(false);

  // If setup is already done, don't show the wizard.
  useEffect(() => {
    api
      .get<SetupStatus>("/auth/setup-status")
      .then((r) => {
        if (!r.data?.needs_setup) {
          router.replace("/login");
          return;
        }
        setElsewhere(r.data.setup_here === false);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const canSubmit = form.email && form.password && !mismatch && !busy;

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<TokenOut>("/auth/setup", {
        email: form.email,
        password: form.password,
        full_name: form.full_name || null,
      });
      tokens.set(data.access_token);
      await reload();
      toast.success("Welcome — your workspace is ready");
      router.replace("/home");
    } catch (err) {
      setError(apiError(err, "Setup failed"));
    } finally {
      setBusy(false);
    }
  }

  if (checking) return null;

  if (elsewhere) {
    return (
      <NeubitAuthShell hint="Only the server itself can create the first administrator.">
        <p className="font-mono text-[10px] tracking-[1.6px] text-[#67e8f9]">FIRST-RUN SETUP</p>
        <h2 className="mt-1 text-[19px] font-[650] tracking-[0.2px] text-[#f2f6ff]">
          Finish setting up on the server
        </h2>
        <p className="mt-3 text-[12.5px] leading-relaxed text-[#cfd0f2]">
          This Neubit VMS has no administrator yet. For security, the first one can only be created on the
          server itself.
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-[#cfd0f2]">
          On the server, open the Neubit VMS app, or a browser at{" "}
          <span className="font-semibold text-[#f2f6ff]">http://localhost</span>. Create the administrator
          there, then sign in from here.
        </p>
      </NeubitAuthShell>
    );
  }

  return (
    <NeubitAuthShell hint="This account is created once, when the system is new.">
      <p className="font-mono text-[10px] tracking-[1.6px] text-[#67e8f9]">FIRST-RUN SETUP</p>
      <h2 className="mt-1 text-[19px] font-[650] tracking-[0.2px] text-[#f2f6ff]">Create the administrator</h2>
      <p className="mb-5 mt-1 text-[11.5px] text-[#9a92c8]">
        The first account on this Neubit VMS. It can manage everything, including other users.
      </p>

      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <div>
          <NbLabel htmlFor="full_name">Full name</NbLabel>
          <NbInput
            id="full_name"
            autoComplete="name"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            placeholder="Jane Doe"
          />
        </div>
        <div>
          <NbLabel htmlFor="email">Work email</NbLabel>
          <NbInput
            id="email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="admin@company.com"
          />
        </div>
        <div>
          <NbLabel htmlFor="password">Password</NbLabel>
          <div className="relative">
            <NbInput
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
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a92c8] hover:text-[#cfd0f2]"
              aria-label={show ? "Hide password" : "Show password"}
            >
              <Icon icon={show ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div>
          <NbLabel htmlFor="confirm">Confirm password</NbLabel>
          <NbInput
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            placeholder="Re-enter password"
            invalid={mismatch}
            aria-describedby={mismatch ? "confirm-error" : undefined}
          />
          <NbFieldError id="confirm-error">{mismatch ? "Passwords do not match." : null}</NbFieldError>
        </div>

        <NbError>{error}</NbError>
        <NbSubmit loading={busy} disabled={!canSubmit}>
          CREATE ADMINISTRATOR →
        </NbSubmit>
      </form>
    </NeubitAuthShell>
  );
}
