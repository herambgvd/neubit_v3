/**
 * WHAT AN OPERATOR IS OFFERED, and why each control needs its own permission.
 *
 * This bar reaches a camera the VMS does not own. Every button is a request to
 * somebody else's recorder, and the five rights behind them are genuinely
 * different acts:
 *
 *   * vms.recording.control — start/stop, and retention-lock footage as evidence.
 *   * vms.config.manage     — reboot the camera. Authorship, not operation.
 *   * vms.playback.view     — export a clip.
 *   * vms.camera.tune       — drive a relay. The ONLY control here whose effect is
 *     outside the network: it opens a gate or sounds a siren. It is deliberately
 *     NOT config.manage — rewriting a relay's idle state stays on the recorder;
 *     pulsing one is an operator acting on the building in front of them.
 *
 * A control that would only ever be refused is ABSENT rather than disabled: a
 * greyed button still invites the press, and the refusal arrives as a toast long
 * after the operator has moved on.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

let perms: string[] = [];
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => perms.includes(p) }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../api", () => ({ vms: { federation: {} } }));
// Stubbed: the relay dialog reads the device's I/O over the network and is tested
// on its own. What matters here is whether this bar opens it at all.
vi.mock("./RelayModal", () => ({
  default: ({ cameraName }: { cameraName: string }) => <div>relay dialog for {cameraName}</div>,
}));

import FederatedCameraActions from "./FederatedCameraActions";

const CAMERA = {
  id: "fed:recorder-a:cam-1",
  node_id: "recorder-a",
  real_id: "cam-1",
  name: "Loading bay",
} as never;

function show(withPerms: string[]) {
  perms = withPerms;
  return render(<FederatedCameraActions camera={CAMERA} />);
}

describe("FederatedCameraActions", () => {
  it("renders nothing at all for an operator who holds none of the rights", () => {
    const { container } = show([]);
    // Not an empty toolbar: an empty bordered strip reads as a broken screen.
    expect(container).toBeEmptyDOMElement();
  });

  it("offers only what each right actually permits", () => {
    show(["vms.recording.control"]);
    expect(screen.getByRole("button", { name: /Rec/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hold 15 min/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reboot/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export clip/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Device I\/O/ })).not.toBeInTheDocument();
  });

  it("does not let playback.view reach a relay", () => {
    // Watching footage and opening a gate are not the same act, and a viewer
    // holding only playback must not be able to do the second.
    show(["vms.playback.view"]);
    expect(screen.getByRole("button", { name: /Export clip/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Device I\/O/ })).not.toBeInTheDocument();
  });

  it("gates the relay on camera.tune, not on config.manage", () => {
    show(["vms.config.manage"]);
    expect(screen.getByRole("button", { name: /Reboot/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Device I\/O/ })).not.toBeInTheDocument();

    show(["vms.camera.tune"]);
    expect(screen.getByRole("button", { name: /Device I\/O/ })).toBeInTheDocument();
  });

  it("opens the relay dialog rather than firing anything on the press", async () => {
    // A relay press is physical. The button reads the device first; it does not
    // pulse an output because somebody clicked the toolbar.
    show(["vms.camera.tune"]);
    expect(screen.queryByText(/relay dialog/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Device I\/O/ }));
    expect(screen.getByText("relay dialog for Loading bay")).toBeInTheDocument();
  });

  it("asks before rebooting a camera", async () => {
    show(["vms.config.manage"]);
    await userEvent.click(screen.getByRole("button", { name: /Reboot/ }));
    // A reboot drops the stream for everyone watching it, so it is confirmed —
    // and the dialog says what "drop offline" means rather than asking "are you
    // sure?" about a word the operator has to guess the cost of.
    expect(screen.getByText("Reboot camera?")).toBeInTheDocument();
    expect(screen.getByText(/drop offline for a minute/)).toBeInTheDocument();
  });
});
