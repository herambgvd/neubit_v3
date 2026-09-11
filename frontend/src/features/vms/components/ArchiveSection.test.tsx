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
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import ArchiveSection from "./ArchiveSection";
import type { FederationNode } from "../types";


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

/**
 * AND THE SAME THINGS, ON THE SCREEN.
 *
 * The verdicts above are only worth anything if they reach an operator, so these
 * render the panel against a stubbed recorder and read what it says.
 */
const NODE = { id: "n1", name: "recorder-a" } as FederationNode;

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /vms/federation/nodes/n1/storage/archive": () => ({
      enabled: true,
      ready: false,
      blocked_reason: "the destination NAS share is not mounted",
      destination_name: "ReadyNAS",
      stats: { archived_segments: 12, archived_bytes: 1024, local_only: 412, cold_only: 3 },
    }),
    "GET /vms/federation/nodes/n1/storage/restore/ranges": () => ({ items: [], total: 0 }),
    "GET /vms/federation/nodes/n1/storage/restore/jobs": () => ({ items: [], total: 0 }),
    ...over,
  };
}

describe("the archive panel", () => {
  it("shows the recorder's reason when the archive cannot run", async () => {
    // "Enabled" is not "working". Without this sentence, 0 archived reads as
    // "nothing needed archiving" instead of "nothing ever will".
    stubApi(routes());
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText(/destination NAS share is not mounted/i)).toBeInTheDocument();
  });

  it("names the segments that have only one copy", async () => {
    stubApi(routes());
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText("Local only")).toBeInTheDocument();
    expect(screen.getByText("412")).toBeInTheDocument();
    expect(screen.getByText("no second copy")).toBeInTheDocument();
  });

  it("lists what survives in the archive alone, and says it is not lost", async () => {
    stubApi(
      routes({
        "GET /vms/federation/nodes/n1/storage/restore/ranges": () => ({
          items: [{ segment_path: "/a.mp4", started_at: "2026-08-01T10:00:00Z", size_bytes: 2048 }],
          total: 1,
        }),
      }),
    );
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText(/not on the timeline and they are not lost/i)).toBeInTheDocument();
  });

  it("calls a partial restore partial, not done", async () => {
    stubApi(
      routes({
        "GET /vms/federation/nodes/n1/storage/restore/jobs": () => ({
          items: [{ id: "j1", status: "done", requested: 50, restored: 40, failed: 10, created_at: "2026-08-01T10:00:00Z" }],
          total: 1,
        }),
      }),
    );
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText("40 of 50 recovered")).toBeInTheDocument();
  });

  it("says restoring is the recorder's to do rather than hiding a missing button", async () => {
    // The absence is the design — vms.storage.manage is not granted — so it is
    // stated. A missing control with no explanation is a bug report waiting.
    stubApi(routes());
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText(/recorder's to do/i)).toBeInTheDocument();
  });

  it("reports a recorder it cannot read instead of an empty archive", async () => {
    stubApi({
      "GET /vms/federation/nodes/n1/storage/archive": () => {
        throw new Error("unreachable");
      },
      "GET /vms/federation/nodes/n1/storage/restore/ranges": () => ({ items: [] }),
      "GET /vms/federation/nodes/n1/storage/restore/jobs": () => ({ items: [] }),
    });
    renderWithProviders(<ArchiveSection node={NODE} />);

    expect(await screen.findByText(/could not load the archive|unreachable/i)).toBeInTheDocument();
  });
});
