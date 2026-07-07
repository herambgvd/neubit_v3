"use client";

import { Icon } from "@iconify/react";

import { AuthInput, AuthLabel, AuthSubmit, AuthError } from "@/components/AuthShell";

export function MfaForm({ code, setCode, error, busy, onSubmit, onBack }) {
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="flex items-start gap-3 rounded-lg border border-cyan-400/20 bg-cyan-500/5 px-3 py-2.5">
        <Icon icon="heroicons-outline:key" className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
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
        onClick={onBack}
        className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition"
      >
        ← Use a different account
      </button>
    </form>
  );
}
