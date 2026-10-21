"use client";

// A LIVE SCREEN — one of this station's other monitors, with a live view of its
// own (SCRUM-336). Route /live-display/<key>, opened by the desktop app full
// screen on its monitor, or by the console's Screens menu in a browser window.
//
// It is the live wall itself (Streaming), immersive, keeping its grid under
// <key>. It sits OUTSIDE the (app) chrome on purpose: no header, and no alarm
// notifier — the main console raises alarms and sounds the siren, once. Every
// screen of a desk ringing for the same event is a desk nobody can think at.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { useAuth } from "@/lib/auth";
import { useIsDesktop } from "@/lib/desktop";

import Streaming from "./Streaming";
import { announceScreen, forgetScreen, isScreenKey } from "./liveScreens";

export interface LiveScreenProps {
  /** The `[screen]` route segment. */
  screenKey?: string | string[];
}

/** The screen's name, from `?name=`. Read from the location rather than with
 *  useSearchParams, which would need a Suspense boundary for no benefit here. */
function nameFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("name")?.trim().slice(0, 80) ?? "";
}

export default function LiveScreen({ screenKey }: Readonly<LiveScreenProps>) {
  const key = (Array.isArray(screenKey) ? screenKey[0] : screenKey) ?? "";
  const { status } = useAuth();
  const isDesktop = useIsDesktop();
  const [label] = useState(() => nameFromUrl() || "Screen");

  // The window's name in the taskbar and Alt-Tab — the desktop app titles its
  // window from it. Kept, not just set: the root layout's metadata title lands
  // after hydration and would otherwise put every screen back to "Neubit".
  useEffect(() => {
    const want = `${label} · Live`;
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => watch.disconnect();
  }, [label]);

  const close = useCallback(() => {
    // The browser's record goes first: a window that refuses to close (one the
    // operator opened by hand) is at least not offered back as a live screen.
    forgetScreen(key);
    window.close();
    // Still here a moment later: not a window a script may close.
    setTimeout(() => {
      if (!window.closed) toast.message("Close this tab to put the screen away.");
    }, 300);
  }, [key]);

  // Tell the console this screen is up, and close when it asks.
  useEffect(() => {
    if (!isScreenKey(key) || status !== "authed") return undefined;
    return announceScreen(key, () => window.close());
  }, [key, status]);

  if (!isScreenKey(key)) {
    return <ScreenMessage icon="heroicons:exclamation-triangle" text="This is not a screen of this station." />;
  }
  if (status === "loading") {
    return <ScreenMessage icon="svg-spinners:180-ring" text="Connecting…" />;
  }
  if (status !== "authed") {
    return (
      <ScreenMessage icon="heroicons-outline:lock-closed" text="Signed out. Sign in on the main console, then retry.">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-[8px] border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:border-white/40"
        >
          Retry
        </button>
      </ScreenMessage>
    );
  }

  return (
    <div className="fixed inset-0">
      <Streaming screen={{ key, label, onClose: close }} />
      {/* The desktop app makes its window full screen itself. A browser window
          needs one click from the operator, in that window — no page may take
          a monitor over by itself. */}
      {!isDesktop && <FullScreenPrompt />}
    </div>
  );
}

function FullScreenPrompt() {
  const [fullscreen, setFullscreen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (fullscreen || dismissed) return null;
  return (
    <div className="absolute bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-nb-teal/45 bg-nb-surface/95 p-1 shadow-2xl">
      <button
        type="button"
        onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)}
        className="inline-flex items-center gap-1.5 rounded-full bg-nb-teal/15 px-3 py-1.5 text-xs font-semibold text-nb-tealb hover:bg-nb-teal/25"
      >
        <Icon icon="heroicons-outline:arrows-pointing-out" className="text-sm" />
        Full screen on this monitor
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="Not now"
        aria-label="Not now"
        className="rounded-full p-1.5 text-nb-faint hover:text-nb-soft"
      >
        <Icon icon="heroicons-outline:x-mark" className="text-sm" />
      </button>
    </div>
  );
}

interface ScreenMessageProps {
  icon: string;
  text: string;
  children?: ReactNode;
}

function ScreenMessage({ icon, text, children }: Readonly<ScreenMessageProps>) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white/60">
      <Icon icon={icon} className="text-3xl" />
      <p className="text-sm">{text}</p>
      {children}
    </div>
  );
}
