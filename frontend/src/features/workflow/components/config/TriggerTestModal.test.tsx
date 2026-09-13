/**
 * A dry run answers two questions, and this modal is where somebody decides a
 * trigger is finished: does the event MATCH, and would an incident actually be
 * raised. A trigger can match and still create nothing — suppressed, throttled,
 * pointed at a SOP that is gone — so "matched" is an amber answer, not a green
 * one. Signing a trigger off on a match alone is how an alarm nobody receives
 * gets shipped.
 */
import { describe, expect, it } from "vitest";

import { triggerVerdict } from "./TriggerTestModal";

describe("triggerVerdict", () => {
  it("is green only when an incident would actually be raised", () => {
    expect(triggerVerdict({ would_create: true }).tone).toBe("ok");
  });

  it("keeps a match that creates nothing separate from a clean fire", () => {
    const v = triggerVerdict({ would_create: false });
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("no incident would be created");
  });

  it("treats a trigger missing from the response as no match", () => {
    // `find` returns undefined when the simulator did not list this trigger at
    // all, and that is a negative answer — never an unknown to be waved through.
    expect(triggerVerdict(undefined).tone).toBe("bad");
    expect(triggerVerdict({}).tone).toBe("warn");
  });
});
