"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@iconify/react";

import { AuthInput, AuthLabel, AuthSubmit, AuthError } from "@/components/AuthShell";

export function LoginForm({ email, setEmail, password, setPassword, error, busy, onSubmit }) {
  const [show, setShow] = useState(false);

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <AuthLabel htmlFor="email">Work email</AuthLabel>
        <AuthInput
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
        />
      </div>
      <div className="space-y-1.5">
        <AuthLabel
          htmlFor="password"
          action={
            <Link href="/forgot-password" className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
              Forgot password?
            </Link>
          }
        >
          Password
        </AuthLabel>
        <div className="relative">
          <AuthInput
            id="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            className="pr-10"
            required
          />
          <button
            type="button"
            aria-label={show ? "Hide password" : "Show password"}
            onClick={() => setShow((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition"
          >
            <Icon icon={show ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="h-4 w-4" />
          </button>
        </div>
      </div>
      <AuthError>{error}</AuthError>
      <AuthSubmit loading={busy}>Sign in</AuthSubmit>
      <p className="text-center text-xs text-white/35">
        By continuing you agree to your organization&apos;s acceptable use policy.
      </p>
    </form>
  );
}
