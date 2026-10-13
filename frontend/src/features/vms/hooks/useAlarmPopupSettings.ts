"use client";

// WHAT THE OPERATOR'S ALERT SETTINGS MAKE OF A POP-UP (SCRUM-326, SCRUM-327): how
// long it stays, whether a critical waits for an answer, the sound switches on it
// (Enable sound while the browser holds it back, Silence while it rings), and
// "turn pop-ups off". The corner card and the Events page's alarm window offer the
// same, so they read it from one place.
import { toast } from "sonner";

import { clearAlarms, ringingTone, silenceAlarms, useAlarmQueue } from "../alarmQueue";
import { popupCloseMs, soundActive, useAlertPrefs } from "../alertPrefs";
import { unlockAlertSound } from "../alertSound";
import { useAlertSoundState } from "../components/EventAlertControl";
import type { AlarmSound } from "../components/EventToast";
import { useTicker } from "./useTicker";

export function useAlarmPopupSettings() {
  const alarms = useAlarmQueue();
  const { prefs, save } = useAlertPrefs();
  const state = useAlertSoundState();
  // A timed mute ends by itself: tick while one runs, so the pop-up follows it.
  const now = useTicker(15_000, prefs.muteUntil !== null);
  const audible = soundActive(prefs, now);

  const mute = () => {
    void save({ popup: false });
    // Turning pop-ups off means stop interrupting me — the whole pop-up goes. It
    // is the operator's setting: the top bar's Alerts switch turns it back on.
    clearAlarms();
    toast("Alert pop-ups off", {
      description: "The Events page keeps its own live feed. Turn them back on from Alerts in the top bar.",
      action: { label: "Undo", onClick: () => void save({ popup: true }) },
    });
  };

  const sound: AlarmSound = {
    held: audible && state === "blocked",
    ringing: audible && ringingTone(alarms, prefs) !== null,
    onSilence: silenceAlarms,
    onEnable: () => void unlockAlertSound(),
  };

  return { prefs, closeAfterMs: popupCloseMs(prefs), criticalStays: prefs.criticalStays, sound, mute };
}
