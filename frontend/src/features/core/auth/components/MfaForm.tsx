"use client";

import type { SyntheticEvent } from "react";
import { Icon } from "@iconify/react";

import { NbLabel, NbInput, NbSubmit, NbError } from "./NeubitAuthShell";

export interface MfaFormProps {
  code: string;
  setCode: (value: string) => void;
  /** The verification error banner; "" hides it. */
  error: string;
  busy: boolean;
  onSubmit: (e: SyntheticEvent<HTMLFormElement>) => void;
  onBack: () => void;
}

export function MfaForm({ code, setCode, error, busy, onSubmit, onBack }: Readonly<MfaFormProps>) {
  return (
    <div>
      <h2 className="text-[19px] font-[650] tracking-[0.2px] text-nb-ink">Verify it&apos;s you</h2>
      <p className="mb-5 mt-1 text-[11.5px] text-nb-faint">two-factor authentication required</p>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="flex items-start gap-3 rounded-[10px] border border-nb-teal/25 bg-nb-teal/6 px-3 py-2.5">
          <Icon icon="heroicons-outline:key" className="mt-0.5 h-4 w-4 shrink-0 text-nb-tealb" />
          <div className="text-[11.5px] text-nb-muted">
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
          className="w-full text-center text-[11px] text-nb-faint transition hover:text-nb-muted"
        >
          ← Use a different account
        </button>
      </form>
    </div>
  );
}
