/**
 * An export is the one thing on this screen that leaves the building: a clip an
 * operator hands to somebody else. So the dialog's headline has to be exact
 * about which of three things happened — the file is ready, the recorder failed,
 * or it is still working — and a status this console has not learned is the
 * third, never the first.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createExport = vi.fn();
const getExport = vi.fn();
const downloadExportBlob = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api", () => ({
  vms: {
    federation: {
      actions: {
        createExport: (...a: unknown[]) => createExport(...a),
        getExport: (...a: unknown[]) => getExport(...a),
        downloadExportBlob: (...a: unknown[]) => downloadExportBlob(...a),
        verifyExport: vi.fn(),
        exportManifestBlob: vi.fn(),
      },
    },
  },
}));

import ExportDialog, { exportProgress } from "./ExportDialog";

describe("exportProgress", () => {
  it("announces a finished export with the tick", () => {
    const p = exportProgress("done");
    expect(p.text).toBe("Export ready");
    expect(p.icon).toBe("heroicons-solid:check-circle");
  });

  it("announces a failed one with the cross", () => {
    expect(exportProgress("failed").text).toBe("Export failed");
  });

  it("keeps spinning on any other status, reading it back in the recorder's words", () => {
    expect(exportProgress("running").text).toBe("Export running…");
    expect(exportProgress("packaging").icon).toBe("svg-spinners:180-ring");
  });

  it("calls a job with no status yet queued rather than printing a gap", () => {
    expect(exportProgress(null).text).toBe("Export queued…");
    expect(exportProgress(undefined).text).toBe("Export queued…");
    expect(exportProgress("").text).toBe("Export queued…");
  });
});

/**
 * THE FOOTER'S ARMS GUARD EACH OTHER.
 *
 * One button is offered at a time and which one it is IS the operator's whole
 * next move. The arms run in the job's own order — nothing started, finished,
 * failed, still running — and the running arm is deliberately last, so a status
 * this console has never learned falls into it. That fallback is the point of
 * these tests: a Download offered for a job the recorder has not finished is a
 * dead link handed to somebody collecting evidence, and it looks identical to a
 * working one until they click it.
 */
const RANGE = { from: "2026-07-09T14:00:00Z", to: "2026-07-09T14:05:00Z" };

function open(props: Partial<{ nodeId: string; cameraId: string; cameraName: string }> = {}) {
  return render(
    <ExportDialog
      open
      nodeId="recorder-a"
      cameraId="cam-1"
      cameraName="Loading bay"
      range={RANGE}
      {...props}
    />,
  );
}

/** Start a job and let the dialog settle on whatever status the recorder gave. */
async function startJobAt(status: string | null) {
  createExport.mockResolvedValue({ id: "job-1", status });
  // The poll would ask again two seconds later; it never runs inside a test, and
  // answering with the same status keeps it honest if it ever does.
  getExport.mockResolvedValue({ id: "job-1", status });
  const view = open();
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(createExport).toHaveBeenCalled());
  return view;
}

const footerButtons = () =>
  screen.getAllByRole("button").map((b) => b.textContent?.trim() ?? "");

describe("ExportDialog footer", () => {
  beforeEach(() => {
    createExport.mockReset();
    getExport.mockReset();
    downloadExportBlob.mockReset();
  });

  it("offers Export, and nothing else, before a job exists", () => {
    open();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
  });

  it("will not start an export over a range that runs backwards", async () => {
    // `To` before `From` is a typo, not a request. Starting it would hand the
    // recorder a negative window and the operator a failure minutes later.
    render(
      <ExportDialog open nodeId="recorder-a" cameraId="cam-1" range={{ from: RANGE.to, to: RANGE.from }} />,
    );
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.getByText(/To must be after From/)).toBeInTheDocument();
  });

  it("offers Download only once the recorder says done", async () => {
    await startJobAt("done");
    expect(screen.getByRole("button", { name: /Download/ })).toBeEnabled();
    // And the dismiss reads Close, not Cancel: there is nothing left to cancel.
    // By text, because the modal's own X is also named "Close".
    expect(screen.getByText("Close")).toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("downloads the finished clip from the recorder that made it", async () => {
    const blob = new Blob(["mp4"]);
    downloadExportBlob.mockResolvedValue(blob);
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    await startJobAt("done");
    await userEvent.click(screen.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(downloadExportBlob).toHaveBeenCalledWith("recorder-a", "job-1"));
    vi.unstubAllGlobals();
  });

  it("offers Try again on a failure, and never a Download", async () => {
    await startJobAt("failed");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("puts the operator back on the form when Try again is pressed", async () => {
    // Retry clears the job rather than re-posting it: the range is very often
    // what was wrong, and re-sending it unchanged fails the same way.
    await startJobAt("failed");
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(createExport).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled spinner — never a Download — for a status it has never heard of", async () => {
    // THE ONE THAT MATTERS. `packaging` is a real recorder status this console
    // does not enumerate, and an unknown status must land on the running arm.
    for (const status of ["queued", "running", "packaging", "uploading", "", null]) {
      const { unmount } = await startJobAt(status);
      const exporting = screen.getByRole("button", { name: /Exporting…/ });
      expect(exporting, String(status)).toBeDisabled();
      expect(footerButtons(), String(status)).not.toContain("Download");
      createExport.mockReset();
      unmount();
    }
  });

  it("reads an unknown status back in the recorder's own word rather than inventing one", async () => {
    await startJobAt("packaging");
    expect(screen.getByText("Export packaging…")).toBeInTheDocument();
  });

  it("does not go on polling a job the recorder has already finished", async () => {
    // The poll effect returns early on a terminal status. Without that early
    // return a finished export keeps a request every two seconds running for as
    // long as the dialog is open — per operator, per recorder — and the traffic
    // is invisible because the screen looks correct the whole time.
    await startJobAt("done");
    await waitFor(() => expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument());
    expect(getExport).not.toHaveBeenCalled();
  });

  it("passes the watermark choice through to the recorder, because it changes the clip", async () => {
    // A watermarked export is re-encoded and no longer byte-identical to the
    // recording. Dropping the flag silently gives a different artefact than the
    // one the operator asked for.
    createExport.mockResolvedValue({ id: "job-1", status: "queued" });
    getExport.mockResolvedValue({ id: "job-1", status: "queued" });
    open();
    await userEvent.click(screen.getByRole("switch", { name: /watermark/i }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(createExport).toHaveBeenCalledWith(
        "recorder-a",
        "cam-1",
        expect.any(String),
        expect.any(String),
        true,
      ),
    );
  });
});
