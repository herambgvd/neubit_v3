/**
 * What a finished reconcile looks like.
 *
 * The colour and the icon on a sync row used to be decided by two separate
 * ternary chains, and the icon's chain had arms for "succeeded" and "failed"
 * only. Everything else — including PARTIAL, the run that copied some of the
 * cardholders and gave up on the rest, and any status the controller starts
 * sending tomorrow — fell through to the animated spinner. A run that ended
 * hours ago with half a door's population missing rendered as work in progress.
 *
 * So the rule pinned here is: a spinner means running, and nothing else does.
 */
import { describe, expect, it } from "vitest";

import { jobVerdict } from "./SyncTab";

const SPINNER = "svg-spinners:180-ring";

describe("jobVerdict", () => {
  it("spins only for a run that is actually still going", () => {
    expect(jobVerdict("running").icon).toBe(SPINNER);
    expect(jobVerdict("pending").icon).toBe(SPINNER);

    for (const status of ["success", "completed", "succeeded", "partial", "failed", "error"]) {
      expect(jobVerdict(status).icon).not.toBe(SPINNER);
    }
  });

  it("does not let a partial run pass for a clean one", () => {
    const partial = jobVerdict("partial");
    expect(partial.tone).toContain("amber");
    expect(partial.icon).not.toBe(jobVerdict("success").icon);
  });

  it("admits it does not recognise a status instead of guessing", () => {
    // Neither green, nor red, nor spinning: the controller may grow a status
    // this console has never heard of, and "no idea" is the honest render.
    const unknown = jobVerdict("reticulating");
    expect(unknown.icon).toBe("heroicons-outline:question-mark-circle");
    expect(unknown.tone).toContain("muted");
    expect(jobVerdict(null)).toEqual(unknown);
    expect(jobVerdict("")).toEqual(unknown);
  });

  it("reads the status whatever case it arrives in", () => {
    expect(jobVerdict("SUCCESS")).toEqual(jobVerdict("success"));
    expect(jobVerdict("Failed")).toEqual(jobVerdict("failed"));
  });
});
