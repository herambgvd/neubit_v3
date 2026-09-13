/**
 * The node pane renders "This recorder reports no disk usage." whenever the
 * percentage is null, so null has to mean exactly one thing: the recorder did
 * not measure. Every test here is about not printing that sentence over a
 * reading that exists, and not inventing one that does not.
 */
import { describe, expect, it } from "vitest";

import { usedPercent } from "./FederationNodeDetail";

describe("usedPercent", () => {
  it("prefers the percentage the recorder computed itself", () => {
    expect(usedPercent({ used_percent: 42, total_bytes: 100, used_bytes: 90 })).toBe(42);
  });

  it("derives one from bytes when the recorder reported no percentage", () => {
    expect(usedPercent({ total_bytes: 200, used_bytes: 50 })).toBe(25);
  });

  it("reports a measured-empty disk as 0%, not as unmeasured", () => {
    // A fresh archive volume reports used_bytes: 0. Treating that as "no usage
    // reported" hides a disk the recorder did read, on the one pane an operator
    // opens to find out whether it did.
    expect(usedPercent({ total_bytes: 1_000, used_bytes: 0 })).toBe(0);
    expect(usedPercent({ used_percent: 0, total_bytes: 1_000, used_bytes: 0 })).toBe(0);
  });

  it("says nothing rather than dividing by a total it does not have", () => {
    expect(usedPercent({ used_bytes: 50 })).toBeNull();
    expect(usedPercent({ total_bytes: 0, used_bytes: 0 })).toBeNull();
    expect(usedPercent({})).toBeNull();
    expect(usedPercent(undefined)).toBeNull();
  });
});
