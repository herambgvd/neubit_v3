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
const verifyExport = vi.fn();
const exportManifestBlob = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api", () => ({
  vms: {
    federation: {
      actions: {
        createExport: (...a: unknown[]) => createExport(...a),
        getExport: (...a: unknown[]) => getExport(...a),
        downloadExportBlob: (...a: unknown[]) => downloadExportBlob(...a),
        verifyExport: (...a: unknown[]) => verifyExport(...a),
        exportManifestBlob: (...a: unknown[]) => exportManifestBlob(...a),
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

/**
 * THE EVIDENCE A FINISHED EXPORT CARRIES.
 *
 * A clip that leaves the building is only worth what can be said about it later.
 * The recorder hashes it, signs a manifest over that hash, and this panel is the
 * only place an operator ever sees either. Every claim on it is one somebody may
 * repeat in a statement, so a badge that is present when it should not be — or a
 * "tampered" with no numbers behind it — is worse than a blank panel.
 */
const DONE = {
  id: "job-1",
  status: "done",
  sha256: "a".repeat(64),
  signed: true,
  encode_mode: "copy",
};

/** The dialog only learns the hash, the signature and the encode mode from the
 *  POLL — the create response carries an id and a status and nothing else. So
 *  every assertion below has to travel through one real poll tick (2s), which is
 *  why this block is the slow one. Fake timers do not help: userEvent's own
 *  delays run on the same clock and the click never lands. */
async function pollTo(job: Record<string, unknown>) {
  createExport.mockResolvedValue({ id: "job-1", status: "running" });
  getExport.mockResolvedValue(job);
  const view = open();
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument(), {
    timeout: 4000,
  });
  return view;
}

describe("the tamper-evidence panel", () => {
  beforeEach(() => {
    createExport.mockReset();
    getExport.mockReset();
    verifyExport.mockReset();
    exportManifestBlob.mockReset();
  });

  it("picks the finished job up from the poll rather than making the operator reopen it", async () => {
    // The dialog is opened on a job that is still running. If the poll did not
    // replace the job, the panel would sit on "Export running…" forever and the
    // finished clip would only appear on a reopen.
    await pollTo(DONE);
    expect(screen.getByText("Export ready")).toBeInTheDocument();
  });

  it("claims a signature only for a job the recorder actually signed", async () => {
    // Signing is best-effort: a signing failure still produces a valid, hashed
    // clip. A badge shown regardless would put an Ed25519 claim on a manifest
    // that does not exist.
    const { unmount } = await pollTo(DONE);
    expect(screen.getByText(/Signed \(Ed25519\)/)).toBeInTheDocument();
    unmount();

    await pollTo({ ...DONE, signed: false });
    expect(screen.getByText("Not signed")).toBeInTheDocument();
    expect(screen.queryByText(/Signed \(Ed25519\)/)).not.toBeInTheDocument();
  });

  it("prints the clip's own SHA-256, which is what anybody checks it against", async () => {
    await pollTo(DONE);
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
  });

  it("says when the clip was re-encoded and is no longer the recorded bytes", async () => {
    // A stream copy is bit-identical to what was recorded; a re-encode is not.
    // On an evidence artefact that is a fact the recipient has to be told.
    const { unmount } = await pollTo(DONE);
    expect(screen.queryByText("Re-encoded")).not.toBeInTheDocument();
    unmount();

    await pollTo({ ...DONE, encode_mode: "reencode" });
    expect(screen.getByText("Re-encoded")).toBeInTheDocument();
  });

  it("confirms a clip that still hashes to its signed manifest", async () => {
    verifyExport.mockResolvedValue({ valid: true, signed_by_this_node: true });
    await pollTo(DONE);
    await userEvent.click(screen.getByRole("button", { name: /Verify signature/ }));
    expect(await screen.findByText("Verified authentic")).toBeInTheDocument();
  });

  it("shows both hashes when the clip no longer matches its manifest", async () => {
    // "Tampered" with no numbers behind it is not something anybody can act on,
    // and it is the one word on this panel that ends up in a report.
    verifyExport.mockResolvedValue({
      valid: false,
      reason: "tampered",
      detail: "The clip on disk does not hash to the value in its manifest.",
      expected_sha256: "b".repeat(64),
      actual_sha256: "c".repeat(64),
    });
    await pollTo(DONE);
    await userEvent.click(screen.getByRole("button", { name: /Verify signature/ }));

    expect(await screen.findByText("Not verified — tampered")).toBeInTheDocument();
    expect(screen.getByText(/does not hash to the value/)).toBeInTheDocument();
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("c".repeat(64))).toBeInTheDocument();
  });

  it("separates a valid manifest this recorder did not sign from a failure", async () => {
    // A manifest from before a key rotation, or from another recorder, is still
    // internally valid. Reporting it as a failure would have an operator discard
    // sound evidence; saying nothing would overstate what was proved.
    verifyExport.mockResolvedValue({ valid: true, signed_by_this_node: false });
    await pollTo(DONE);
    await userEvent.click(screen.getByRole("button", { name: /Verify signature/ }));

    expect(await screen.findByText("Verified authentic")).toBeInTheDocument();
    expect(screen.getByText(/predates a key rotation, or it came from another recorder/)).toBeInTheDocument();
  });

  it("downloads the manifest as its own file, beside the clip", async () => {
    // The manifest is the chain of custody. A download that produced the clip
    // again, or a file named .mp4, leaves the recipient nothing to verify with.
    exportManifestBlob.mockResolvedValue(new Blob(["{}"]));
    const createObjectURL = vi.fn(() => "blob:manifest");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      names.push(this.download);
    };

    await pollTo(DONE);
    await userEvent.click(screen.getByRole("button", { name: /Manifest/ }));
    await waitFor(() => expect(exportManifestBlob).toHaveBeenCalledWith("recorder-a", "job-1"));
    expect(names).toEqual(["Loading bay-job-1.manifest.json"]);

    HTMLAnchorElement.prototype.click = realClick;
    vi.unstubAllGlobals();
  });
});
