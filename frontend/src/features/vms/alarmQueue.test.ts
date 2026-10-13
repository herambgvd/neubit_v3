import { beforeEach, describe, expect, it } from "vitest";

import type { NormalizedVmsEvent } from "./eventLib";
import { alarmQueue, clearAlarms, pushAlarm, ringingTone, silenceAlarms } from "./alarmQueue";

const alarm = (key: string, severity: string) => ({
  key,
  event: { severity, event_type: "tamper" } as NormalizedVmsEvent,
  cameraName: "Gate",
  recorderName: null,
  raisedAt: Date.now(),
});

const BOTH = { repeatCritical: true, repeatAlarm: true };
const CRITICAL_ONLY = { repeatCritical: true, repeatAlarm: false };

beforeEach(() => clearAlarms());

describe("silencing the ringing (SCRUM-326)", () => {
  it("quiets what rings now, keeps it on the card, and the next critical rings again", () => {
    pushAlarm(alarm("a", "critical"));
    expect(ringingTone(alarmQueue(), CRITICAL_ONLY)).toBe("critical");

    silenceAlarms();
    expect(alarmQueue()).toHaveLength(1);
    expect(ringingTone(alarmQueue(), CRITICAL_ONLY)).toBeNull();

    pushAlarm(alarm("b", "critical"));
    expect(ringingTone(alarmQueue(), CRITICAL_ONLY)).toBe("critical");
  });

  it("repeats an alarm only when the operator repeats alarms", () => {
    pushAlarm(alarm("a", "alarm"));
    expect(ringingTone(alarmQueue(), CRITICAL_ONLY)).toBeNull();
    expect(ringingTone(alarmQueue(), BOTH)).toBe("alarm");
  });

  it("rings the worst priority waiting", () => {
    pushAlarm(alarm("a", "alarm"));
    pushAlarm(alarm("b", "critical"));
    expect(ringingTone(alarmQueue(), BOTH)).toBe("critical");
    expect(ringingTone(alarmQueue(), { repeatCritical: false, repeatAlarm: true })).toBe("alarm");
  });
});

describe("the order (SCRUM-327)", () => {
  it("puts a critical in front of every alarm, and the newest first among equals", () => {
    pushAlarm(alarm("a1", "alarm"));
    pushAlarm(alarm("c1", "critical"));
    pushAlarm(alarm("a2", "alarm"));
    pushAlarm(alarm("c2", "critical"));
    expect(alarmQueue().map((a) => a.key)).toEqual(["c2", "c1", "a2", "a1"]);
  });

  it("reads the severity in any case", () => {
    pushAlarm(alarm("a", "alarm"));
    pushAlarm(alarm("c", "CRITICAL"));
    expect(alarmQueue()[0].key).toBe("c");
  });
});
