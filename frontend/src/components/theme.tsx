"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";

// One frozen value, not a fresh object per render: a context value rebuilt on
// every provider render invalidates every `useTheme()` consumer, and this one
// never changes — the console has a single dark theme and no switch.
const THEME = { theme: "dark", toggle: () => {} };

const ThemeContext = createContext(THEME);

// DARK-ONLY. The console ships a single dark theme — there is no light mode and no
// user-facing switch. This provider stays so the `useTheme()` call sites keep
// working (and so a stale `theme: "light"` left in localStorage by an older build
// can never resurrect the light palette).
export function ThemeProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    try {
      localStorage.setItem("theme", "dark");
    } catch {
      /* private mode / storage disabled — the class above is what matters */
    }
  }, []);

  return (
    <ThemeContext.Provider value={THEME}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
