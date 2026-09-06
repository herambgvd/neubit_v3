// Lightweight auth: talks to /api/v1/auth, stores tokens, exposes a React hook.
// Deliberately standalone (localStorage + context) rather than wired into the
// DashCode Redux store, so it stays simple and portable across scenarios.
"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api, bootstrapSession, tokens } from "./api";
import type { AuthUser, Entitlements, LoginResponse, ModuleEntitlement } from "./types";

// The wire shapes live in lib/types (one interface per Pydantic model); they are
// re-exported here so `import type { AuthUser } from "@/lib/auth"` keeps working.
export type { AuthUser, Entitlements, ModuleEntitlement } from "./types";

export type AuthStatus = "loading" | "authed" | "anon";

export interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean; mfaToken?: string }>;
  loginMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Permission check against the user's role; "*" is admin. */
  can: (perm: string) => boolean;
  /** Whether the caller's tenant has a module on. Permissive when unknown. */
  hasModule: (key?: string | null) => boolean;
  entitlements: Entitlements | null;
  licenseState: string | null;
  reload: () => Promise<void>;
}

// null until a provider mounts — `useAuth` is what turns that into an error, so
// every consumer gets a non-null value.
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  // The caller's effective entitlements from GET /features (modules/limits/license
  // state), resolved from their tenant. null until loaded (nav treats that as
  // permissive so it doesn't flash-hide during the fetch).
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);

  const loadMe = useCallback(async () => {
    // The access token lives in memory, so after a reload there is none — probe
    // the httpOnly refresh cookie before deciding the visitor is signed out.
    // A signed-out visitor produces no failing request: /auth/refresh answers
    // 200 with a null token.
    if (!(await bootstrapSession())) {
      setStatus("anon");
      setEntitlements(null);
      return;
    }
    try {
      const { data } = await api.get<AuthUser>("/auth/me");
      setUser(data);
      setStatus("authed");
      // Load entitlements alongside identity; a failure here must not break auth,
      // so it degrades to null (permissive nav, no license banner).
      try {
        const feat = await api.get<Entitlements>("/features");
        setEntitlements(feat.data);
      } catch {
        setEntitlements(null);
      }
    } catch {
      tokens.clear();
      setUser(null);
      setEntitlements(null);
      setStatus("anon");
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await api.post<LoginResponse>("/auth/login", { email, password });
      // When 2FA is on, the backend withholds tokens and returns a challenge —
      // surface it so the caller can prompt for the authenticator code.
      if (data.mfa_required) return { mfaRequired: true, mfaToken: data.mfa_token ?? undefined };
      // Only the access token: the refresh token came back as an httpOnly cookie
      // the browser stores itself, invisible to this code.
      tokens.set(data.access_token);
      await loadMe();
      return { mfaRequired: false };
    },
    [loadMe]
  );

  // Second step of a 2FA login: exchange the challenge token + a TOTP/recovery
  // code for real tokens.
  const loginMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const { data } = await api.post<LoginResponse>("/auth/login/mfa", { mfa_token: mfaToken, code });
      tokens.set(data.access_token);
      await loadMe();
    },
    [loadMe]
  );

  const logout = useCallback(async () => {
    try {
      // No body: the endpoint revokes the token from the cookie and clears it.
      await api.post("/auth/logout");
    } catch {
      /* best-effort */
    }
    tokens.clear();
    setUser(null);
    setEntitlements(null);
    setStatus("anon");
  }, []);

  // permission check against the user's dynamic role ("*" = admin)
  const can = useCallback(
    (perm: string) => {
      const perms = user?.role?.permissions || [];
      return perms.includes("*") || perms.includes(perm);
    },
    [user]
  );

  // Module entitlement check: whether the caller's tenant has module `key` on.
  // Permissive when entitlements aren't loaded yet (avoids flash-hiding real nav)
  // and for keys not in the catalog (only known domain modules gate the nav).
  const hasModule = useCallback(
    (key?: string | null) => {
      if (!key) return true;
      if (!entitlements?.modules) return true;
      const mod = entitlements.modules.find((m: ModuleEntitlement) => m.key === key);
      return mod ? !!mod.enabled : true;
    },
    [entitlements]
  );

  const licenseState = entitlements?.license_state || null;

  return (
    <AuthContext.Provider
      value={{
        user,
        status,
        login,
        loginMfa,
        logout,
        can,
        hasModule,
        entitlements,
        licenseState,
        reload: loadMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
