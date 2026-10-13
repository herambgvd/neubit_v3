"use client";

// Mounts the alarm notifier once, app-wide.
//
// A component rather than a hook call in the shell because the shell is a server
// boundary's child and this needs the client router; and because the hook must
// have exactly ONE subscriber — two would queue every alarm twice.
//
// The hook fills the alarm queue; AlarmCorner shows it — in the bottom-right
// corner on most pages, at the top right of the Events page.
//
// It also owns the alert tone's two app-wide duties (SCRUM-326): unlocking the
// browser's audio on the operator's first click or key, and ringing again while
// the pop-up holds an alarm nobody has answered or silenced — Milestone's
// "repeat sound until the alarm is looked at" — for the priorities the operator
// repeats. The repeat is one looping sound, not a timer (SCRUM-327): it rings on
// time in a background tab too. A timed mute ends by itself, so the clock ticks
// while one runs.
import { useEffect } from "react";

import AlarmCorner from "./AlarmCorner";
import { useAlertSoundState } from "./EventAlertControl";
import { ringingTone, useAlarmQueue } from "../alarmQueue";
import { soundActive, soundFor, useAlertPrefs } from "../alertPrefs";
import { installAlertSoundUnlock, prepareAlertSounds, startAlertLoop, stopAlertLoop } from "../alertSound";
import { useEventNotifier } from "../hooks/useEventNotifier";
import { useTicker } from "../hooks/useTicker";

export default function EventNotifierHost() {
  useEventNotifier();
  const { prefs } = useAlertPrefs();
  const alarms = useAlarmQueue();
  const sound = useAlertSoundState();
  const now = useTicker(15_000, prefs.muteUntil !== null);
  const tone = soundActive(prefs, now) ? ringingTone(alarms, prefs) : null;
  const id = tone ? soundFor(prefs, tone) : null;
  const volume = prefs.volume;

  useEffect(() => installAlertSoundUnlock(), []);

  // The operator's two sounds, built as soon as the browser allows sound, so the
  // first alarm does not wait on the synthesis.
  const { criticalSound, alarmSound } = prefs;
  useEffect(() => {
    if (sound !== "ready") return;
    const t = setTimeout(() => prepareAlertSounds([criticalSound, alarmSound]), 0);
    return () => clearTimeout(t);
  }, [sound, criticalSound, alarmSound]);

  // `sound` is a dependency so a repeat held back by the browser starts the moment
  // the operator's first click lets it.
  useEffect(() => {
    if (!tone || !id || sound !== "ready") return;
    startAlertLoop(tone, volume, id);
    return () => stopAlertLoop();
  }, [tone, id, sound, volume]);

  return <AlarmCorner />;
}
