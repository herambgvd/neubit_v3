"use client";

// THE OPERATOR'S EVENT-ALERT SETTINGS (SCRUM-326, SCRUM-327).
//
// Whether an alarm interrupts — a popup card, a tone — is the operator's choice, the
// way Milestone's Smart Client keeps "show desktop notifications" and the alarm sound
// per user, and AutoVu lets a hotlist ring or stay silent. They live in the user's
// own preferences on the server (PATCH /auth/me/preferences, a partial merge), so an
// operator who turns the sound off finds it off at the next workstation too, and a
// popup muted from the card can be turned back on from My account → Preferences.

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { anprOf } from "./anprLib";
import { isAttentionSeverity } from "./constants";
import { DEFAULT_ALERT_SOUND, isAlertSoundId, type AlertSoundId, type AlertTone } from "./alertSound";

/** Which plate reads interrupt: every alerting read, block-list hits only, or none. */
export type AnprAlertMode = "all" | "hits" | "off";
/** The least severity that interrupts. */
export type AlertLevel = "alarm" | "critical";

export interface AlertPrefs {
  popup: boolean;
  /** On the Events page, open the alarm window in the middle of the page (SCRUM-327),
   *  as HikCentral's and DSS's monitoring screens do; off, the corner card. */
  popupOnEvents: boolean;
  /** Seconds a pop-up stays after the alarm in front arrived; 0 = until closed. */
  popupCloseSec: number;
  /** A critical keeps its pop-up up until someone answers it, whatever the time —
   *  Nx's forced acknowledgement, Genetec's "never auto-acknowledge an active one". */
  criticalStays: boolean;
  sound: boolean;
  /** 0–100. */
  volume: number;
  criticalSound: AlertSoundId;
  alarmSound: AlertSoundId;
  /** Keep ringing while a critical's pop-up is open — until it is answered. */
  repeatCritical: boolean;
  /** Keep ringing while an alarm's pop-up is open. On by default (SCRUM-327): a
   *  pop-up on screen is an alarm still waiting, and the sound says so for as
   *  long as it waits; the pop-up closes on its own, and the ring with it. */
  repeatAlarm: boolean;
  level: AlertLevel;
  anpr: AnprAlertMode;
  /** A timed mute: no tone until this moment (epoch ms). Avigilon and Genetec mute
   *  for a while rather than for good, so a mute for a phone call cannot outlive
   *  the shift. Null when the sound is not muted for a time. */
  muteUntil: number | null;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  popup: true,
  popupOnEvents: true,
  popupCloseSec: 15,
  criticalStays: true,
  sound: true,
  volume: 70,
  criticalSound: DEFAULT_ALERT_SOUND.critical,
  alarmSound: DEFAULT_ALERT_SOUND.alarm,
  repeatCritical: true,
  repeatAlarm: true,
  level: "alarm",
  anpr: "all",
  muteUntil: null,
};

/** The pop-up times on offer, in seconds; 0 keeps it until it is closed.
 *  Milestone's desktop notification stays 15 s. */
export const POPUP_CLOSE_OPTIONS = [10, 15, 30, 60, 0] as const;

const KEYS = {
  popup: "event_alert_popup",
  popupOnEvents: "event_alert_popup_on_events",
  popupCloseSec: "event_alert_popup_close_sec",
  criticalStays: "event_alert_critical_stays",
  sound: "event_alert_sound",
  volume: "event_alert_volume",
  criticalSound: "event_alert_critical_sound",
  alarmSound: "event_alert_alarm_sound",
  repeatCritical: "event_alert_repeat_critical",
  repeatAlarm: "event_alert_repeat_alarm",
  level: "event_alert_level",
  anpr: "event_alert_anpr",
  muteUntil: "event_alert_mute_until",
} as const satisfies Record<keyof AlertPrefs, string>;

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** The settings out of the user's preferences JSON; anything unset or malformed is the default. */
export function alertPrefsOf(prefs: Record<string, unknown> | null | undefined): AlertPrefs {
  const p = prefs ?? {};
  const d = DEFAULT_ALERT_PREFS;
  const volume = p[KEYS.volume];
  const level = p[KEYS.level];
  const anpr = p[KEYS.anpr];
  const until = p[KEYS.muteUntil];
  const close = p[KEYS.popupCloseSec];
  const criticalSound = p[KEYS.criticalSound];
  const alarmSound = p[KEYS.alarmSound];
  return {
    popup: bool(p[KEYS.popup], d.popup),
    popupOnEvents: bool(p[KEYS.popupOnEvents], d.popupOnEvents),
    popupCloseSec: (POPUP_CLOSE_OPTIONS as readonly unknown[]).includes(close) ? (close as number) : d.popupCloseSec,
    criticalStays: bool(p[KEYS.criticalStays], d.criticalStays),
    sound: bool(p[KEYS.sound], d.sound),
    volume: typeof volume === "number" && Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : d.volume,
    criticalSound: isAlertSoundId(criticalSound) ? criticalSound : d.criticalSound,
    alarmSound: isAlertSoundId(alarmSound) ? alarmSound : d.alarmSound,
    repeatCritical: bool(p[KEYS.repeatCritical], d.repeatCritical),
    repeatAlarm: bool(p[KEYS.repeatAlarm], d.repeatAlarm),
    level: level === "critical" || level === "alarm" ? level : d.level,
    anpr: anpr === "all" || anpr === "hits" || anpr === "off" ? anpr : d.anpr,
    muteUntil: typeof until === "number" && Number.isFinite(until) ? until : null,
  };
}

/** Whether a tone may sound at `now`: sound on, and no timed mute still running. */
export function soundActive(prefs: AlertPrefs, now: number): boolean {
  return prefs.sound && !(prefs.muteUntil !== null && now < prefs.muteUntil);
}

/** The sound the operator picked for a priority. */
export function soundFor(prefs: AlertPrefs, tone: AlertTone): AlertSoundId {
  return tone === "critical" ? prefs.criticalSound : prefs.alarmSound;
}

/** How long a pop-up stays, in ms; null keeps it until it is closed. */
export function popupCloseMs(prefs: AlertPrefs): number | null {
  return prefs.popupCloseSec > 0 ? prefs.popupCloseSec * 1000 : null;
}

/** The preferences patch for a change of some settings. */
export function alertPrefsPatch(change: Partial<AlertPrefs>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change) as [keyof AlertPrefs, unknown][]) {
    if (v !== undefined) out[KEYS[k]] = v;
  }
  return out;
}

type AlertableEvent = { event_type?: string | null; severity?: string | null; raw?: unknown };

/** The tone an event raises under these settings, or null when it must stay quiet.
 *  The same answer decides the popup, so a card never appears silently for one
 *  operator and rings for another under the same settings. */
export function alertToneFor(event: AlertableEvent, prefs: AlertPrefs): AlertTone | null {
  const sev = String(event.severity || "").toLowerCase();
  if (!isAttentionSeverity(sev)) return null;
  if (prefs.level === "critical" && sev !== "critical") return null;
  const plate = anprOf(event);
  if (plate) {
    if (prefs.anpr === "off") return null;
    if (prefs.anpr === "hits" && plate.list !== "block") return null;
  }
  return sev === "critical" ? "critical" : "alarm";
}

/** The signed-in operator's settings, and a way to change some of them. */
export function useAlertPrefs() {
  const { user, reload } = useAuth();
  const prefs = alertPrefsOf(user?.preferences as Record<string, unknown> | undefined);
  const save = useMutation({
    mutationFn: (change: Partial<AlertPrefs>) =>
      api.patch("/auth/me/preferences", { preferences: alertPrefsPatch(change) }),
    onSuccess: () => reload(),
    onError: (e) => toast.error(apiError(e, "Could not save the alert settings")),
  });
  return { prefs, save: (change: Partial<AlertPrefs>) => save.mutateAsync(change), saving: save.isPending };
}
