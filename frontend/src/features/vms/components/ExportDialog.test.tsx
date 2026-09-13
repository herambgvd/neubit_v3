/**
 * An export is the one thing on this screen that leaves the building: a clip an
 * operator hands to somebody else. So the dialog's headline has to be exact
 * about which of three things happened — the file is ready, the recorder failed,
 * or it is still working — and a status this console has not learned is the
 * third, never the first.
 */
import { describe, expect, it } from "vitest";

import { exportProgress } from "./ExportDialog";

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
