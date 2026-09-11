/**
 * "IS IT WORKING" IS NOT "IS IT ON".
 *
 * The archive is what makes an empty stretch of timeline mean "restore this"
 * rather than "this is gone". So the two states that must never be confused are
 * an archive that is off and an archive that is on and cannot run: both protect
 * exactly nothing, and only one of them looks like a problem.
 *
 * The same applies to a restore. A job that recovered 40 of 50 segments is neither
 * done nor failed, and calling it done is how the missing ten go unnoticed until
 * somebody goes looking for them.
 */
import { describe, expect, it } from "vitest";

import { archiveVerdict, jobVerdict } from "./ArchiveSection";

describe("what the archive is actually doing", () => {
  it("calls a running archive running", () => {
    expect(archiveVerdict({ enabled: true, ready: true })).toEqual({
      tone: "good",
      text: "Running",
    });
  });

  it("shows the recorder's own reason when it is on and blocked", () => {
    // The whole point of the panel. Without this, "0 archived" reads as "nothing
    // needed archiving" when it means "nothing ever will".
    const v = archiveVerdict({
      enabled: true,
      ready: false,
      blocked_reason: "the destination NAS share is not mounted",
    });
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("not mounted");
  });

  it("prefers the recorder's reason over a generic not-ready", () => {
    // Both branches warn, so asserting the tone alone would pass with the reason
    // dropped — and "not ready" sends somebody looking, while "pool offline" tells
    // them where. The TEXT is the thing being pinned.
    const v = archiveVerdict({
      enabled: true,
      ready: false,
      blocked_reason: "pool offline",
      last_run_at: "2026-08-12T10:29:05Z",
      last_error: null,
    });
    expect(v).toEqual({ tone: "warn", text: "pool offline" });
  });

  it("says an archive that is off leaves footage with no second copy", () => {
    const v = archiveVerdict({ enabled: false });
    expect(v.tone).toBe("idle");
    expect(v.text).toContain("no second copy");
  });

  it("reports nothing rather than guessing when the recorder said nothing", () => {
    expect(archiveVerdict(undefined).tone).toBe("idle");
  });
});

describe("how a restore went", () => {
  it("calls a complete restore recovered", () => {
    expect(jobVerdict({ id: "j", status: "done", requested: 10, restored: 10, failed: 0 })).toEqual({
      tone: "good",
      text: "10 recovered",
    });
  });

  it("refuses to call a partial restore done", () => {
    const v = jobVerdict({ id: "j", status: "done", requested: 50, restored: 40, failed: 10 });
    expect(v.tone).toBe("warn");
    expect(v.text).toBe("40 of 50 recovered");
  });

  it("catches a short restore even when nothing was counted as failed", () => {
    // `done` with restored < requested happens when segments went missing from the
    // archive between the request and the run. Trusting the status word alone
    // would show that as a success.
    const v = jobVerdict({ id: "j", status: "done", requested: 50, restored: 40, failed: 0 });
    expect(v.tone).toBe("warn");
  });

  it("leaves a job still running alone", () => {
    expect(jobVerdict({ id: "j", status: "running", requested: 10, restored: 3 }).tone).toBe("idle");
  });

  it("calls a failed job failed", () => {
    expect(jobVerdict({ id: "j", status: "failed", requested: 10, restored: 0, failed: 10 }).tone).toBe("bad");
  });
});
