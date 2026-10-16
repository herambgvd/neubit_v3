/**
 * PTZ ON THE CAMERAS PAGE OPENS ON DEMAND (SCRUM-332).
 *
 * The detail pane used to mount the PTZ panel over the picture for every PTZ
 * camera, with nothing to close it. As on the live wall, the player's control bar
 * now offers a PTZ key: the panel opens from it, closes from it or from its own
 * close key, and every camera starts with it closed.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import type { EstateFederatedCamera } from "../types";
import FederatedCameraDetail from "./FederatedCameraDetail";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock("../api", () => ({
  vms: { federation: { live: vi.fn(), talk: { capability: vi.fn(() => new Promise(() => {})) } } },
}));
vi.mock("./FederatedCameraActions", () => ({ default: () => null }));
// The player itself is out of scope: render only the controls the pane hands it.
vi.mock("./LivePlayer", () => ({
  default: ({ extraControls }: Readonly<{ extraControls?: React.ReactNode }>) => <div>{extraControls}</div>,
  PlayerBtn: ({ title, onClick, active }: Readonly<{ title: string; onClick?: () => void; active?: boolean }>) => (
    <button type="button" aria-label={title} aria-pressed={active} onClick={onClick} />
  ),
}));
vi.mock("./PtzOverlay", () => ({
  default: ({ title, onClose }: Readonly<{ title?: string; onClose?: () => void }>) => (
    <section aria-label="PTZ panel">
      {title}
      <button type="button" aria-label="Close PTZ control" onClick={onClose} />
    </section>
  ),
}));

const dome = (over: Partial<EstateFederatedCamera> = {}): EstateFederatedCamera => ({
  id: "fed:rec-a:cam-1",
  real_id: "cam-1",
  name: "Gate dome",
  status: "online",
  federated: true,
  ptz_capable: true,
  node_id: "rec-a",
  node_name: "Rec A",
  site_id: "s1",
  site_name: "HQ",
  ...over,
});

const pane = (camera = dome()) => renderWithProviders(<FederatedCameraDetail camera={camera} />);
const panel = () => screen.queryByRole("region", { name: "PTZ panel" });
const openKey = () => screen.getByLabelText("PTZ control — move, zoom and presets");

describe("PTZ on a camera's detail pane", () => {
  it("starts closed, so nothing sits on the picture unasked", () => {
    pane();
    expect(panel()).toBeNull();
    expect(openKey().getAttribute("aria-pressed")).toBe("false");
  });

  it("opens from the player's PTZ key, with the camera's name", () => {
    pane();
    fireEvent.click(openKey());
    expect(panel()).toHaveTextContent("Gate dome");
  });

  it("closes from its own close key", () => {
    pane();
    fireEvent.click(openKey());
    fireEvent.click(within(screen.getByRole("region", { name: "PTZ panel" })).getByLabelText("Close PTZ control"));
    expect(panel()).toBeNull();
  });

  it("closes from the PTZ key, which shows pressed while it is open", () => {
    pane();
    fireEvent.click(openKey());
    const key = screen.getAllByLabelText("Close PTZ control")[0];
    expect(key.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(key);
    expect(panel()).toBeNull();
  });

  it("offers no PTZ key on a camera without a head", () => {
    pane(dome({ ptz_capable: false }));
    expect(screen.queryByLabelText(/PTZ control/)).toBeNull();
  });

  it("offers no PTZ key on an offline camera, which nothing would answer", () => {
    pane(dome({ status: "offline" }));
    expect(screen.queryByLabelText(/PTZ control/)).toBeNull();
  });
});
