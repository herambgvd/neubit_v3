"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "dark", toggle: () => {} });

// Simple Vercel-style theme: toggles the `dark` class on <html> and persists the
// choice. The no-FOUC script in app/layout.tsx sets the initial class before paint.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("theme") : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage cannot be read while rendering on the server; reading it after mount is what keeps the first client paint identical to the server's.
    setTheme(saved === "light" ? "light" : "dark");
  }, []);

  const apply = useCallback((next: Theme) => {
    setTheme(next);
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", next === "dark");
      localStorage.setItem("theme", next);
    }
  }, []);

  // `theme` is the only dependency that can change: `apply` reads its argument,
  // not the current theme, so the toggle below is the only thing that has to be
  // rebuilt when the theme flips. Without this every consumer of the context
  // re-renders on each ThemeProvider render, memoized or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggle: () => apply(theme === "dark" ? "light" : "dark") }),
    [theme, apply]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext);
