import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_PREFS,
  alertPrefsOf,
  alertPrefsPatch,
  alertToneFor,
  popupCloseMs,
  soundActive,
  soundFor,
} from "./alertPrefs";

const plate = (list: string, severity: string) => ({
  event_type: "anpr",
  severity,
  raw: { node_id: "n1", payload: { anpr: { read_id: "r1", plate: "PB10GN4497", list } } },
});

describe("alertPrefsOf", () => {
  it("is the defaults for an operator who never changed anything", () => {
    expect(alertPrefsOf(undefined)).toEqual(DEFAULT_ALERT_PREFS);
    expect(alertPrefsOf({ notify_email: false })).toEqual(DEFAULT_ALERT_PREFS);
  });

  it("reads what the operator saved, and ignores what is not a setting", () => {
    expect(
      alertPrefsOf({
        event_alert_popup: false,
        event_alert_sound: false,
        event_alert_volume: 140,
        event_alert_level: "critical",
        event_alert_anpr: "hits",
        event_alert_repeat_critical: "yes",
      }),
    ).toEqual({
      ...DEFAULT_ALERT_PREFS,
      popup: false,
      sound: false,
      volume: 100,
      repeatCritical: true,
      level: "critical",
      anpr: "hits",
    });
    expect(alertPrefsOf({ event_alert_volume: "loud", event_alert_anpr: "some" })).toEqual(DEFAULT_ALERT_PREFS);
  });

  it("saves only the keys that changed", () => {
    expect(alertPrefsPatch({ sound: false, volume: undefined })).toEqual({ event_alert_sound: false });
  });
});

describe("alertToneFor", () => {
  const d = DEFAULT_ALERT_PREFS;

  it("rings for alarms and criticals, never below", () => {
    expect(alertToneFor({ severity: "alarm" }, d)).toBe("alarm");
    expect(alertToneFor({ severity: "CRITICAL" }, d)).toBe("critical");
    expect(alertToneFor({ severity: "warning" }, d)).toBeNull();
    expect(alertToneFor({ severity: "info" }, d)).toBeNull();
  });

  it("keeps an alarm quiet for an operator who asked for criticals only", () => {
    expect(alertToneFor({ severity: "alarm" }, { ...d, level: "critical" })).toBeNull();
    expect(alertToneFor({ severity: "critical" }, { ...d, level: "critical" })).toBe("critical");
  });

  it("applies the plate rule to plate reads only", () => {
    const hits = { ...d, anpr: "hits" as const };
    expect(alertToneFor(plate("visitor", "alarm"), hits)).toBeNull();
    expect(alertToneFor(plate("block", "critical"), hits)).toBe("critical");
    expect(alertToneFor({ event_type: "motion", severity: "alarm" }, hits)).toBe("alarm");
    expect(alertToneFor(plate("block", "critical"), { ...d, anpr: "off" })).toBeNull();
  });
});

describe("a timed mute", () => {
  it("keeps the tone quiet until it runs out, and then lets it ring", () => {
    const prefs = alertPrefsOf({ event_alert_mute_until: 10_000 });
    expect(prefs.muteUntil).toBe(10_000);
    expect(soundActive(prefs, 9_999)).toBe(false);
    expect(soundActive(prefs, 10_000)).toBe(true);
  });

  it("does not wake a sound the operator turned off", () => {
    expect(soundActive(alertPrefsOf({ event_alert_sound: false, event_alert_mute_until: 1 }), 5)).toBe(false);
  });

  it("is cleared by saving null", () => {
    expect(alertPrefsPatch({ muteUntil: null })).toEqual({ event_alert_mute_until: null });
  });
});

describe("the pop-up and the sounds (SCRUM-327)", () => {
  it("pops up on the Events page too, for 15 s, and holds a critical — by default", () => {
    const d = alertPrefsOf(undefined);
    expect(d.popupOnEvents).toBe(true);
    expect(popupCloseMs(d)).toBe(15_000);
    expect(d.criticalStays).toBe(true);
    // The ring lasts as long as the pop-up, for alarms too.
    expect(d.repeatAlarm).toBe(true);
  });

  it("reads the operator's time, and 0 as 'until I close it'", () => {
    expect(popupCloseMs(alertPrefsOf({ event_alert_popup_close_sec: 60 }))).toBe(60_000);
    expect(popupCloseMs(alertPrefsOf({ event_alert_popup_close_sec: 0 }))).toBeNull();
    // Not one of the offered times: the default, not a 7-second pop-up.
    expect(popupCloseMs(alertPrefsOf({ event_alert_popup_close_sec: 7 }))).toBe(15_000);
  });

  it("keeps the security sound picked for each priority, and a yelp and a hi-lo by default", () => {
    const p = alertPrefsOf({ event_alert_critical_sound: "warble", event_alert_alarm_sound: "horn" });
    expect(soundFor(p, "critical")).toBe("warble");
    expect(soundFor(p, "alarm")).toBe("horn");
    const d = alertPrefsOf(undefined);
    expect([soundFor(d, "critical"), soundFor(d, "alarm")]).toEqual(["yelp", "hilo"]);
    // The medical pulses and the chime are gone: an old pick is the default again.
    expect(alertPrefsOf({ event_alert_critical_sound: "pulse", event_alert_alarm_sound: "chime" })).toMatchObject({
      criticalSound: "yelp",
      alarmSound: "hilo",
    });
  });

  it("saves the new settings under their own keys", () => {
    expect(alertPrefsPatch({ popupOnEvents: false, popupCloseSec: 30, alarmSound: "whoop", repeatAlarm: true })).toEqual({
      event_alert_popup_on_events: false,
      event_alert_popup_close_sec: 30,
      event_alert_alarm_sound: "whoop",
      event_alert_repeat_alarm: true,
    });
  });
});
