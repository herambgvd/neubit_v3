"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { NbLabel, NbInput, NbSubmit, NbError, NbFieldError } from "./NeubitAuthShell";
import {
  GoogleGlyph,
  AppleGlyph,
  MicrosoftGlyph,
  EnterpriseSsoGlyph,
  PasskeyGlyph,
} from "./SsoGlyphs";

/* Honest SSO: the backend exposes only email+password (+TOTP). These
   providers exist for design parity but MUST NOT fabricate a session.
   Clicking surfaces a toast pointing the operator at their admin. */
const SSO_MESSAGE =
  "Single sign-on isn't configured for this directory yet — contact your administrator.";

const SSO_PROVIDERS = [
  { key: "google", label: "Google", Glyph: GoogleGlyph },
  { key: "apple", label: "Apple", Glyph: AppleGlyph },
  { key: "microsoft", label: "Microsoft", Glyph: MicrosoftGlyph },
  { key: "enterprise", label: "Enterprise SSO", Glyph: EnterpriseSsoGlyph },
];

function SsoButton({ label, Glyph, wide, onClick }) {
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

/* The backend answers an empty payload with a generic "Request validation
   failed" — useless to an operator. Catch the obvious cases here instead and
   say which field is wrong, in that field's own words. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(email, password) {
  const next = {};
  const trimmed = email.trim();
  if (!trimmed) next.email = "Work email is required.";
  else if (!EMAIL_RE.test(trimmed)) next.email = "Enter a valid work email, e.g. you@company.com.";
  if (!password) next.password = "Password is required.";
  return next;
}

export function LoginForm({ email, setEmail, password, setPassword, error, busy, onSubmit }) {
  const [show, setShow] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [fieldErrors, setFieldErrors] = useState({});

  const notifySso = (label) => toast(`${label}: single sign-on unavailable`, { description: SSO_MESSAGE });

  function handleSubmit(e) {
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
  const clearFieldError = (field) =>
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

      <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[1px] text-[#9a92c8]">
        <span className="h-px flex-1 bg-[rgba(160,150,245,.2)]" />
        OR CONTINUE WITH
        <span className="h-px flex-1 bg-[rgba(160,150,245,.2)]" />
      </div>

      <div className="grid grid-cols-2 gap-[9px]">
        {SSO_PROVIDERS.map(({ key, label, Glyph }) => (
          <SsoButton key={key} label={label} Glyph={Glyph} onClick={() => notifySso(label)} />
        ))}
        <SsoButton label="Passkey · this device" Glyph={PasskeyGlyph} wide onClick={() => notifySso("Passkey")} />
      </div>

      <div className="mt-[18px] border-t border-[rgba(160,150,245,.2)] pt-[13px] font-mono text-[10px] leading-[1.7] text-[#9a92c8]">
        <b className="text-[#cfd0f2]">MFA enforced</b> · dual-authorization on privileged roles · every sign-in
        audit-logged. Account logins federate through your identity provider (SAML / OIDC) — NeuBit stores no
        passwords. No social-media logins.
        <div className="mt-[9px] flex flex-wrap gap-[7px]">
          <span className="rounded-[12px] border border-[rgba(52,211,153,.4)] px-[10px] py-[3px] text-[9px] tracking-[0.6px] text-[#34d399]">
            IS 19319 · STQC
          </span>
          <span className="rounded-[12px] border border-[rgba(160,150,245,.2)] px-[10px] py-[3px] text-[9px] tracking-[0.6px] text-[#9a92c8]">
            ISO 27001-READY
          </span>
          <span className="rounded-[12px] border border-[rgba(160,150,245,.2)] px-[10px] py-[3px] text-[9px] tracking-[0.6px] text-[#9a92c8]">
            PERPETUAL LICENCE
          </span>
        </div>
      </div>
    </div>
  );
}
