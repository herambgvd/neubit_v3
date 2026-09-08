/**
 * `remaining` is the only arithmetic on the License page, and it is the reading
 * an operator acts on: a date alone leaves them counting days by hand, and the
 * amber threshold is what turns "renew sometime" into "renew this week".
 */
import { describe, expect, it } from "vitest";

import { fmtDate, remaining } from "./licenseFormat";

const NOW = Date.parse("2026-03-01T12:00:00Z");

describe("remaining", () => {
  it("counts the days left", () => {
    expect(remaining("2026-03-15T12:00:00Z", NOW)?.days).toBe(14);
    expect(remaining("2026-03-15T12:00:00Z", NOW)?.label).toBe("14 days left");
  });

  it("warns inside thirty days and stays quiet outside", () => {
    const soon = remaining("2026-03-20T12:00:00Z", NOW)!;
    const far = remaining("2027-03-20T12:00:00Z", NOW)!;
    expect(soon.tone).toContain("warn");
    expect(far.tone).not.toContain("warn");
    expect(far.tone).not.toContain("crit");
  });

  it("says expired, with how long ago, once the date has passed", () => {
    const past = remaining("2026-02-25T12:00:00Z", NOW)!;
    expect(past.days).toBeLessThan(0);
    expect(past.label).toBe("Expired 4d ago");
    expect(past.tone).toContain("crit");
  });

  it("treats the last day as critical, not as a comfortable day left", () => {
    // 11 hours left rounds to 0 days: "1 day left" would be wrong in the one
    // case where being wrong costs a lapsed licence.
    expect(remaining("2026-03-01T23:00:00Z", NOW)!.label).toBe("Expires today");
    expect(remaining("2026-03-01T23:00:00Z", NOW)!.tone).toContain("crit");
  });

  it("is null when there is no expiry to read", () => {
    // A perpetual licence has no countdown; inventing one would be a lie.
    expect(remaining(null, NOW)).toBeNull();
    expect(remaining("not a date", NOW)).toBeNull();
  });
});

describe("fmtDate", () => {
  it("returns the raw string it cannot parse rather than 'Invalid Date'", () => {
    expect(fmtDate("whenever")).toBe("whenever");
    expect(fmtDate(null)).toBe("—");
  });
});
