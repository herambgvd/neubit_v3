"use client";

import { createContext, useContext, useEffect } from "react";

const ThemeContext = createContext({ theme: "dark", toggle: () => {} });

// DARK-ONLY. The console ships a single dark theme — there is no light mode and no
// user-facing switch. This provider stays so the `useTheme()` call sites keep
// working (and so a stale `theme: "light"` left in localStorage by an older build
// can never resurrect the light palette).
export function ThemeProvider({ children }: any) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    try {
      localStorage.setItem("theme", "dark");
    } catch {
      /* private mode / storage disabled — the class above is what matters */
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme: "dark", toggle: () => {} }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
