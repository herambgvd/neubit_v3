/**
 * The words under the SLA ring. The ring itself only ever shows a duration, so
 * this line is the whole of what that duration MEANS, and four different
 * nothings have to stay apart in it:
 *
 *   no alarm picked · an alarm with no time limit · one already overdue ·
 *   one whose clock stopped when it closed
 *
 * Collapse any two and the ring reads as a live countdown when it is not one.
 */
import { describe, expect, it } from "vitest";

import type { InstancePublic } from "../../types";

import { ringSubtitle } from "./SlaRing";

const incident = (over: Partial<InstancePublic>) => ({ status: "open", sla_hours: 4, ...over }) as InstancePublic;
const live = { overdue: false };

describe("ringSubtitle", () => {
  it("says nothing is selected rather than showing an empty limit", () => {
    expect(ringSubtitle(null, null)).toBe("no alarm selected");
    expect(ringSubtitle(undefined, null)).toBe("no alarm selected");
  });

  it("tells an alarm with no time limit from one with time left", () => {
    expect(ringSubtitle(incident({}), null)).toBe("no time limit");
    expect(ringSubtitle(incident({}), live)).toBe("of 4h");
  });

  it("says overdue even for an alarm that is closed", () => {
    // Overdue outranks closed: a resolved alarm that blew its deadline has to
    // keep saying so, or the breach disappears the moment somebody closes it.
    expect(ringSubtitle(incident({ status: "resolved" }), { overdue: true })).toBe("overdue");
  });

  it("stops the countdown once the alarm is terminal", () => {
    expect(ringSubtitle(incident({ status: "resolved" }), live)).toBe("closed");
    expect(ringSubtitle(incident({ status: "cancelled" }), live)).toBe("closed");
  });

  it("prints a dash for a limit the record does not carry", () => {
    expect(ringSubtitle(incident({ sla_hours: null }), live)).toBe("of —h");
  });
});
