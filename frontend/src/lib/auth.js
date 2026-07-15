// Lightweight auth: talks to /api/v1/auth, stores tokens, exposes a React hook.
// Deliberately standalone (localStorage + context) rather than wired into the
// DashCode Redux store, so it stays simple and portable across scenarios.
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { api, tokens } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | authed | anon
  // The caller's effective entitlements from GET /features (modules/limits/license
  // state), resolved from their tenant. null until loaded (nav treats that as
  // permissive so it doesn't flash-hide during the fetch).
  const [entitlements, setEntitlements] = useState(null);

  const loadMe = useCallback(async () => {
    if (!tokens.access) {
      setStatus("anon");
      setEntitlements(null);
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
      setStatus("authed");
      // Load entitlements alongside identity; a failure here must not break auth,
      // so it degrades to null (permissive nav, no license banner).
      try {
        const feat = await api.get("/features");
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
    async (email, password) => {
      const { data } = await api.post("/auth/login", { email, password });
      // When 2FA is on, the backend withholds tokens and returns a challenge —
      // surface it so the caller can prompt for the authenticator code.
      if (data.mfa_required) return { mfaRequired: true, mfaToken: data.mfa_token };
      tokens.set(data.access_token, data.refresh_token);
      await loadMe();
      return { mfaRequired: false };
    },
    [loadMe]
  );

  // Second step of a 2FA login: exchange the challenge token + a TOTP/recovery
  // code for real tokens.
  const loginMfa = useCallback(
    async (mfaToken, code) => {
      const { data } = await api.post("/auth/login/mfa", { mfa_token: mfaToken, code });
      tokens.set(data.access_token, data.refresh_token);
      await loadMe();
    },
    [loadMe]
  );

  const logout = useCallback(async () => {
    try {
      if (tokens.refresh) await api.post("/auth/logout", { refresh_token: tokens.refresh });
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
    (perm) => {
      const perms = user?.role?.permissions || [];
      return perms.includes("*") || perms.includes(perm);
    },
    [user]
  );

  // Module entitlement check: whether the caller's tenant has module `key` on.
  // Permissive when entitlements aren't loaded yet (avoids flash-hiding real nav)
  // and for keys not in the catalog (only known domain modules gate the nav).
  const hasModule = useCallback(
    (key) => {
      if (!key) return true;
      if (!entitlements?.modules) return true;
      const mod = entitlements.modules.find((m) => m.key === key);
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
