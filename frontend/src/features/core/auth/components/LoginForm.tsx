"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Icon } from "@iconify/react";

import { NbLabel, NbInput, NbSubmit, NbError, NbFieldError } from "./NeubitAuthShell";

/* ───────────────────────────────────────────────────────────────────────────
   SOCIAL / FEDERATED SIGN-IN — TURNED OFF, NOT DELETED (2026-08-31)
   ───────────────────────────────────────────────────────────────────────────
   Advertising a sign-in method that cannot sign anyone in is the same failure
   as any other confident wrong answer, so the whole block is commented out
   rather than left to toast an apology. What was actually behind each button,
   checked against this stack rather than assumed:

     Google / Apple / Microsoft — NOTHING. There is no per-provider OAuth
       anywhere in core. Purely decorative.
     Passkey · this device      — NOTHING. No WebAuthn code exists in the
       backend at all; nothing calls navigator.credentials in the frontend.
     Enterprise SSO             — the CAPABILITY is real: core serves
       GET /auth/sso/login and POST /auth/sso/callback (OIDC authorization
       code), and Settings → Security has an SsoCard to configure it. But this
       page never called those routes — the button only raised a toast — and on
       this deployment `sso_configs` is empty, so the endpoint answers 404 "no
       SSO configured for this tenant". SAML is a `provider` enum value marked
       `# oidc | saml (future)` and has no implementation.

   TO TURN ENTERPRISE SSO BACK ON: configure a provider in Settings → Security,
   then uncomment the block below and give the Enterprise button a real handler
   that GETs `/auth/sso/login`, redirects to the returned `authorization_url`,
   and POSTs the code back to `/auth/sso/callback` — a toast is not a login.
   The other four need a backend before they need a button.

   The glyphs live on in ./SsoGlyphs.tsx, unimported, waiting.

import { toast } from "sonner";
import {
  GoogleGlyph,
  AppleGlyph,
  MicrosoftGlyph,
  EnterpriseSsoGlyph,
  PasskeyGlyph,
} from "./SsoGlyphs";

const SSO_MESSAGE =
  "Single sign-on isn't configured for this directory yet — contact your administrator.";

const SSO_PROVIDERS = [
  { key: "google", label: "Google", Glyph: GoogleGlyph },
  { key: "apple", label: "Apple", Glyph: AppleGlyph },
  { key: "microsoft", label: "Microsoft", Glyph: MicrosoftGlyph },
  { key: "enterprise", label: "Enterprise SSO", Glyph: EnterpriseSsoGlyph },
];

function SsoButton({ label, Glyph, wide, onClick }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={SSO_MESSAGE}
      aria-label={`${label} — sign-on not configured`}
      className={
        "flex items-center justify-center gap-[9px] rounded-[10px] border border-[rgba(160,150,245,.2)] bg-[rgba(20,14,44,.45)] px-2 py-[10px] text-[12px] text-[#cfd0f2] transition hover:border-[rgba(167,139,250,.6)] hover:text-[#f2f6ff] hover:shadow-[0_0_14px_rgba(167,139,250,.2)] " +
        (wide ? "col-span-2" : "")
      }
    >
      <Glyph />
      {label}
    </button>
  );
}
   ─────────────────────────────────────────────────────────────────────── */

/* The backend answers an empty payload with a generic "Request validation
   failed" — useless to an operator. Catch the obvious cases here instead and
   say which field is wrong, in that field's own words. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface LoginFieldErrors {
  email?: string;
  password?: string;
}

function validate(email: string, password: string): LoginFieldErrors {
  const next: LoginFieldErrors = {};
  const trimmed = email.trim();
  if (!trimmed) next.email = "Work email is required.";
  else if (!EMAIL_RE.test(trimmed)) next.email = "Enter a valid work email, e.g. you@company.com.";
  if (!password) next.password = "Password is required.";
  return next;
}

export interface LoginFormProps {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  /** The sign-in error banner; "" hides it. */
  error: string;
  busy: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function LoginForm({ email, setEmail, password, setPassword, error, busy, onSubmit }: LoginFormProps) {
  const [show, setShow] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});

  // const notifySso = (label) => toast(`${label}: single sign-on unavailable`, { description: SSO_MESSAGE });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const next = validate(email, password);
    setFieldErrors(next);
    if (Object.keys(next).length) {
      e.preventDefault();
      document.getElementById(next.email ? "email" : "password")?.focus();
      return;
    }
    onSubmit(e);
  }

  // Clear a field's complaint as soon as the operator starts fixing it.
  const clearFieldError = (field: keyof LoginFieldErrors) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  return (
    <div>
      <h2 className="text-[19px] font-[650] tracking-[0.2px] text-[#f2f6ff]">Sign in</h2>
      <p className="mb-5 mt-1 text-[11.5px] text-[#9a92c8]">to your command console</p>

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div>
          <NbLabel>WORK EMAIL</NbLabel>
          <NbInput
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => { setEmail(e.target.value); clearFieldError("email"); }}
            placeholder="you@company.com"
            invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            required
          />
          <NbFieldError id="email-error">{fieldErrors.email}</NbFieldError>
        </div>

        <div>
          <NbLabel>PASSWORD</NbLabel>
          <div className="relative">
            <NbInput
              id="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearFieldError("password"); }}
              placeholder="••••••••••"
              className="pr-10"
              invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? "password-error" : undefined}
              required
            />
            <button
              type="button"
              aria-label={show ? "Hide password" : "Show password"}
              onClick={() => setShow((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a92c8] transition hover:text-[#cfd0f2]"
            >
              <Icon icon={show ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="h-4 w-4" />
            </button>
          </div>
          <NbFieldError id="password-error">{fieldErrors.password}</NbFieldError>
        </div>

        <div className="flex items-center justify-between pb-1 pt-0.5">
          <label className="flex cursor-pointer items-center gap-[7px] text-[11px] text-[#9a92c8]">
            <input
              type="checkbox"
              checked={keepSignedIn}
              onChange={(e) => setKeepSignedIn(e.target.checked)}
              style={{ accentColor: "#22d3ee" }}
            />
            Keep me signed in on this console
          </label>
          <Link href="/forgot-password" className="text-[11px] text-[#c4b5fd] hover:text-[#67e8f9]">
            Forgot?
          </Link>
        </div>

        <NbError>{error}</NbError>
        <NbSubmit loading={busy}>SIGN IN →</NbSubmit>
      </form>

      {/* The "OR CONTINUE WITH" divider and the five provider buttons lived here.
          Commented out with the block at the top of this file — see it for what
          each one was actually connected to and what turning them back on takes.

      <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[1px] text-[#9a92c8]">
        <span className="h-px flex-1 bg-[rgba(160,150,245,.2)]" />
        OR CONTINUE WITH
        <span className="h-px flex-1 bg-[rgba(160,150,245,.2)]" />
      </div>

      <div className="grid grid-cols-2 gap-[9px]">
        {SSO_PROVIDERS.map(({ key, label, Glyph }: any) => (
          <SsoButton key={key} label={label} Glyph={Glyph} onClick={() => notifySso(label)} />
        ))}
        <SsoButton label="Passkey · this device" Glyph={PasskeyGlyph} wide onClick={() => notifySso("Passkey")} />
      </div>
      */}

      {/* NO FOOTER. It carried a line about audit logging and two-step
          verification, and three badges — IS 19319 · STQC, ISO 27001-READY,
          PERPETUAL LICENCE.

          The line was true but is not this screen's job: a person signing in is
          not deciding whether to trust the product, they already have an account.
          The badges are claims about the company, on the one page whose only task
          is to take a password — and "ISO 27001-READY" is a claim about intent
          rather than a certification anybody holds.

          What was here before that was worse and is documented so it does not
          come back: "MFA enforced · dual-authorization on privileged roles ·
          logins federate through your identity provider (SAML / OIDC) — NeuBit
          stores no passwords." MFA is available, not enforced; dual-authorization
          is about privileged ACTIONS, not signing in; SAML is unimplemented and
          OIDC unconfigured; and the no-passwords line was contradicted by the
          field directly above it. */}
    </div>
  );
}
