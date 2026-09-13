"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_FONT,
  DEFAULT_SCALE,
  FONT_STORAGE_KEY,
  SCALE_STORAGE_KEY,
  parseFont,
  parseScale,
  type FontKey,
  type ScaleKey,
} from "@/lib/fonts/catalog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * Typeface + UI scale, chosen by the operator.
 *
 * TWO stores, on purpose, and they are not equal:
 *
 *  - localStorage is what the BOOT SCRIPT reads (see `app/layout.tsx`). It is the
 *    only store that can be read before first paint, so it is the one that stops
 *    the console flashing the default font on every navigation.
 *  - the user's server preferences carry the choice to a NEW browser. They cannot
 *    be read before paint — they arrive with `/auth/me`, long after.
 *
 * So local wins on this device, and the server value is adopted only when this
 * device has no choice of its own. Letting the server override a local pick would
 * mean the font visibly changes a second after every login.
 */

/** The keys the SERVER stores the same choice under, so it follows the operator. */
export const FONT_PREF_KEY = "ui_font";
export const SCALE_PREF_KEY = "ui_scale";

type Appearance = {
  font: FontKey;
  scale: ScaleKey;
  setFont: (font: FontKey) => void;
  setScale: (scale: ScaleKey) => void;
};

const AppearanceContext = createContext<Appearance>({
  font: DEFAULT_FONT,
  scale: DEFAULT_SCALE,
  setFont: () => {},
  setScale: () => {},
});

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / storage disabled — defaults are fine
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the DOM attribute below is what actually renders; persistence is a bonus */
  }
}

export function AppearanceProvider({ children }: { children?: ReactNode }) {
  const { user } = useAuth();

  // Lazy initialisers, so the very first client render already agrees with what
  // the boot script painted. On the server both fall back to the defaults, which
  // is exactly what `layout.tsx` renders into the markup.
  const [font, setFontState] = useState<FontKey>(() =>
    typeof window === "undefined" ? DEFAULT_FONT : parseFont(read(FONT_STORAGE_KEY)),
  );
  const [scale, setScaleState] = useState<ScaleKey>(() =>
    typeof window === "undefined" ? DEFAULT_SCALE : parseScale(read(SCALE_STORAGE_KEY)),
  );

  useEffect(() => {
    document.documentElement.dataset.font = font;
  }, [font]);

  useEffect(() => {
    document.documentElement.dataset.uiScale = scale;
  }, [scale]);

  // Only a signed-in user has preferences to merge into. Calling the endpoint
  // signed out would trip the 401 interceptor in lib/api.ts and bounce the
  // visitor to /login for nothing more than a font change.
  const remember = useCallback(
    (key: string, value: string) => {
      if (!user) return;
      api.patch("/auth/me/preferences", { preferences: { [key]: value } }).catch(() => {
        /* the choice already applied and is in localStorage; it just won't follow
           this operator to another browser */
      });
    },
    [user],
  );

  const setFont = useCallback(
    (next: FontKey) => {
      setFontState(next);
      write(FONT_STORAGE_KEY, next);
      remember(FONT_PREF_KEY, next);
    },
    [remember],
  );

  const setScale = useCallback(
    (next: ScaleKey) => {
      setScaleState(next);
      write(SCALE_STORAGE_KEY, next);
      remember(SCALE_PREF_KEY, next);
    },
    [remember],
  );

  // Adopt the server's choice ONCE, and only for a device that has none of its own.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !user) return;
    adopted.current = true;

    const prefs = (user.preferences ?? {}) as Record<string, unknown>;
    // setState in an effect, knowingly: the server's value cannot exist until
    // /auth/me has answered, which is long after this component first rendered.
    // Deriving it instead would revert the console to the default font the moment
    // the operator signs out, which is worse than one extra render at login.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (read(FONT_STORAGE_KEY) === null && prefs[FONT_PREF_KEY] !== undefined) {
      const next = parseFont(prefs[FONT_PREF_KEY]);
      setFontState(next);
      write(FONT_STORAGE_KEY, next);
    }
    if (read(SCALE_STORAGE_KEY) === null && prefs[SCALE_PREF_KEY] !== undefined) {
      const next = parseScale(prefs[SCALE_PREF_KEY]);
      setScaleState(next);
      write(SCALE_STORAGE_KEY, next);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [user]);

  // A stable identity here matters more than it looks: `children` is one element
  // the provider never rebuilds, so React skips the subtree on a re-render and
  // this value is the only thing that tells consumers the font or scale moved.
  const value = useMemo(() => ({ font, scale, setFont, setScale }), [font, scale, setFont, setScale]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export const useAppearance = () => useContext(AppearanceContext);
