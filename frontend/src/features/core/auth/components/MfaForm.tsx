"use client";

import { Icon } from "@iconify/react";

import { NbLabel, NbInput, NbSubmit, NbError } from "./NeubitAuthShell";

export function MfaForm({ code, setCode, error, busy, onSubmit, onBack }: any) {
  return (
    <div>
      <h2 className="text-[19px] font-[650] tracking-[0.2px] text-[#f2f6ff]">Verify it&apos;s you</h2>
      <p className="mb-5 mt-1 text-[11.5px] text-[#9a92c8]">two-factor authentication required</p>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="flex items-start gap-3 rounded-[10px] border border-[rgba(34,211,238,.25)] bg-[rgba(34,211,238,.06)] px-3 py-2.5">
          <Icon icon="heroicons-outline:key" className="mt-0.5 h-4 w-4 shrink-0 text-[#67e8f9]" />
          <div className="text-[11.5px] text-[#cfd0f2]">
            Open your authenticator app and enter the current 6-digit code. You can also use a backup code.
          </div>
        </div>

        <div>
          <NbLabel>AUTHENTICATION CODE</NbLabel>
          <NbInput
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            autoFocus
            required
            className="text-center font-mono text-base tracking-[0.4em]"
          />
        </div>

        <NbError>{error}</NbError>
        <NbSubmit loading={busy}>VERIFY AND SIGN IN →</NbSubmit>
        <button
          type="button"
          onClick={onBack}
          className="w-full text-center text-[11px] text-[#9a92c8] transition hover:text-[#cfd0f2]"
        >
          ← Use a different account
        </button>
      </form>
    </div>
  );
}
