"use client";

// THE ALERTS SWITCH in the top bar — mute and unmute, popups on and off, for every
// alarm and event, from any page (SCRUM-326).
//
// Alarm consoles keep this one click away: Smart Client's alarm sound and desktop
// notifications, Security Desk's mute. An operator taking a phone call mutes; a
// shift that ends unmutes for the next one. Burying it in a settings page means it
// is never turned back on, so the bar shows the state at a glance — a struck-out
// speaker when muted, an amber dot when the browser is still holding the sound back
// — and opens a small menu with both switches, a test tone and the full settings.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

import { Toggle } from "@/components/ui/kit";

import { soundActive, useAlertPrefs } from "../alertPrefs";
import { useTicker } from "../hooks/useTicker";
import {
  DEFAULT_ALERT_SOUND,
  alertSoundState,
  playAlertTone,
  subscribeAlertSound,
  unlockAlertSound,
  type AlertSoundId,
  type AlertSoundState,
  type AlertTone,
} from "../alertSound";

/** The timed mutes on offer: long enough for a call or a handover, short enough
 *  that a forgotten mute ends by itself. */
const MUTE_FOR: { label: string; ms: number }[] = [
  { label: "15 min", ms: 15 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
];

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where the full alert settings live. */
export const ALERT_SETTINGS_HREF = "/account?tab=preferences";

const serverState = (): AlertSoundState => "blocked";

/** Whether the tone can sound right now, kept current. */
export function useAlertSoundState(): AlertSoundState {
  return useSyncExternalStore(subscribeAlertSound, alertSoundState, serverState);
}

/** Play a priority's sound once, unlocking the browser's audio first (this is a
 *  click). A test, not a ring: it plays over a repeat rather than yielding to it. */
export async function testAlertTone(
  volume: number,
  tone: AlertTone = "alarm",
  id: AlertSoundId = DEFAULT_ALERT_SOUND[tone],
): Promise<boolean> {
  await unlockAlertSound();
  return playAlertTone(tone, volume, id, { preview: true });
}

export default function EventAlertControl() {
  const { prefs, save } = useAlertPrefs();
  const sound = useAlertSoundState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The same dismissal contract as the bell beside it: outside click, Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node | null)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A timed mute ends by itself: tick while one runs, so the bar follows it.
  const now = useTicker(15_000, prefs.muteUntil !== null);
  const audible = soundActive(prefs, now);
  const pausedUntil = prefs.sound && !audible ? prefs.muteUntil : null;
  const held = audible && sound === "blocked";
  let label = "Alerts: sound on";
  if (!prefs.sound) label = "Alerts: sound muted";
  else if (pausedUntil) label = `Alerts: sound muted until ${clock(pausedUntil)}`;
  else if (held) label = "Alerts: click to let the browser play the alert sound";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          // The click itself is the gesture the browser waits for.
          if (held) void unlockAlertSound();
          setOpen((o) => !o);
        }}
        className={`relative rounded-md p-2 transition ${open ? "bg-hover text-foreground" : "text-muted hover:bg-hover hover:text-foreground"}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon icon={audible ? "heroicons-outline:speaker-wave" : "heroicons-outline:speaker-x-mark"} className="text-lg" />
        {held && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-400" aria-hidden />}
        {!prefs.popup && (
          <Icon icon="heroicons-outline:bell-slash" className="absolute -bottom-0.5 -right-0.5 text-[11px] text-muted" aria-hidden />
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-[60] mt-2 w-72 overflow-hidden rounded-lg border border-card-border bg-card shadow-2xl">
          <div className="border-b border-card-border px-4 py-2.5 text-sm font-semibold text-foreground">Event alerts</div>
          <div className="space-y-3 px-4 py-3">
            <Switch
              title="Alert sound"
              desc={prefs.sound ? "A tone for every alarm and plate hit" : "Muted — alarms arrive silently"}
              checked={prefs.sound}
              onChange={(v) => {
                if (v) void unlockAlertSound();
                void save({ sound: v, muteUntil: null });
              }}
            />
            {prefs.sound &&
              (pausedUntil ? (
                <div className="flex items-center gap-2 text-[11px] text-amber-200">
                  <span>Muted until {clock(pausedUntil)}</span>
                  <button
                    type="button"
                    onClick={() => void save({ muteUntil: null })}
                    className="ml-auto rounded-md border border-card-border px-2 py-0.5 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
                  >
                    Unmute now
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span>Mute for</span>
                  {MUTE_FOR.map((m) => (
                    <button
                      key={m.ms}
                      type="button"
                      onClick={() => void save({ muteUntil: Date.now() + m.ms })}
                      className="rounded-md border border-card-border px-2 py-0.5 transition hover:bg-hover hover:text-foreground"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ))}
            <Switch
              title="Alert pop-ups"
              desc={prefs.popup ? "A card in the corner on other pages" : "Off — alarms only reach the Events page"}
              checked={prefs.popup}
              onChange={(v) => void save({ popup: v })}
            />
            {held && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                The browser holds sound back until you click in the console. That click just happened — the next alarm will sound.
              </p>
            )}
            {sound === "unsupported" && (
              <p className="text-[11px] text-muted">This browser cannot play the alert sound.</p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-card-border px-4 py-2.5">
            <button
              type="button"
              onClick={() => void testAlertTone(prefs.volume, "alarm", prefs.alarmSound)}
              className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:play" className="text-xs" /> Test sound
            </button>
            <Link
              href={ALERT_SETTINGS_HREF}
              onClick={() => setOpen(false)}
              className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-sky-400 transition hover:text-sky-300"
            >
              <Icon icon="heroicons-outline:adjustments-horizontal" className="text-xs" /> More settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Switch({
  title,
  desc,
  checked,
  onChange,
}: Readonly<{ title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }>) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-foreground">{title}</div>
        <div className="text-[11px] text-muted">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
