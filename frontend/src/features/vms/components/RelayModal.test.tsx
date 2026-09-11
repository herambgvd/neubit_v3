/**
 * THE ONE CONTROL THAT MOVES SOMETHING IN THE WORLD.
 *
 * A relay opens a gate or sounds a siren, and two facts about it are easy to get
 * wrong in a way nobody notices until a gate is left open.
 *
 * FIRST, whether it comes back on its own. Monostable returns after its delay,
 * bistable stays where it is put — and a device that reported NEITHER has said
 * nothing. Printing "it returns on its own" from a missing field is the sentence
 * an operator would act on, so a missing mode must produce no sentence at all.
 *
 * SECOND, what it reaches. On a multi-channel encoder the relay belongs to the
 * BOX, so driving it from one camera's page acts wherever the other channels are
 * wired. Those channels are named before the button rather than discovered after.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import RelayModal, { relayBehaviour, sharedChannels } from "./RelayModal";

describe("what happens after the relay is driven", () => {
  it("says a monostable relay returns, and after how long", () => {
    expect(relayBehaviour({ token: "r1", settings: { mode: "Monostable", delay_seconds: 5 } })).toBe(
      "returns on its own after 5s",
    );
  });

  it("says a monostable relay returns even with no delay reported", () => {
    expect(relayBehaviour({ token: "r1", settings: { mode: "Monostable" } })).toBe(
      "returns on its own",
    );
  });

  it("says a bistable relay stays put", () => {
    expect(relayBehaviour({ token: "r1", settings: { mode: "Bistable" } })).toBe(
      "stays until it is set back",
    );
  });

  it("says NOTHING when the device did not report a mode", () => {
    // The load-bearing case. A null mode is the device staying silent; inventing
    // "it returns on its own" here is how a gate stays open overnight.
    expect(relayBehaviour({ token: "r1", settings: { mode: null } })).toBeNull();
    expect(relayBehaviour({ token: "r1" })).toBeNull();
    expect(relayBehaviour({ token: "r1", settings: {} })).toBeNull();
  });
});

describe("what else the relay reaches", () => {
  it("names the other channels sharing the device", () => {
    expect(
      sharedChannels({ channel_names: ["Channel 1", "Channel 2", "Channel 5"] }, "Channel 2"),
    ).toEqual(["Channel 1", "Channel 5"]);
  });

  it("says nothing when this camera is the only channel on the box", () => {
    // A warning about nobody else is noise, and noise is how the real warning
    // stops being read.
    expect(sharedChannels({ channel_names: ["Channel 2"] }, "Channel 2")).toEqual([]);
    expect(sharedChannels({}, "Channel 2")).toEqual([]);
    expect(sharedChannels(undefined, "Channel 2")).toEqual([]);
  });

  it("drops blank names rather than showing an empty one", () => {
    expect(sharedChannels({ channel_names: ["", "Channel 1"] }, "Channel 2")).toEqual(["Channel 1"]);
  });
});

/**
 * AND ON THE SCREEN, where the consequences are.
 *
 * The two functions above decide what an operator is told; these check they are
 * told it BEFORE the button, which is the whole difference between a warning and
 * a post-mortem.
 */
const IO = {
  device_host: "192.168.1.100",
  channels_on_device: 3,
  channel_names: ["Channel 1", "Channel 2", "Channel 5"],
  relay_state_readable: false,
  relay_state_detail:
    "ONVIF provides no way to read a relay's present state; it is reported only as an event.",
  device_io_supported: true,
  digital_inputs: [],
  relay_outputs: [{ token: "relay0", settings: { mode: "Bistable", idle_state: "closed" } }],
};

const ROUTE = "GET /vms/federation/nodes/n1/cameras/c1/io";

function render(io: Record<string, unknown> = IO) {
  stubApi({ [ROUTE]: () => io });
  return renderWithProviders(
    <RelayModal nodeId="n1" cameraId="c1" cameraName="Channel 2" onClose={() => {}} />,
  );
}

describe("the relay dialog", () => {
  it("names the other channels the device carries, before anything is pressed", async () => {
    // One box, three channels. Driving a relay from Channel 2's page acts wherever
    // the others are wired, and that has to be readable in advance.
    render();
    expect(await screen.findByText(/Channel 1, Channel 5 share these relays/)).toBeInTheDocument();
  });

  it("offers verbs, not a switch", async () => {
    // There is no readable relay position, so a toggle would render one we made up.
    render();
    expect(await screen.findByRole("button", { name: "Set active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set inactive" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("carries the recorder's own sentence about why", async () => {
    render();
    expect(await screen.findByText(/no way to read a relay's present state/i)).toBeInTheDocument();
  });

  it("asks before it acts, and says what the drive reaches", async () => {
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Set active" }));

    expect(await screen.findByText(/Set relay relay0 active\?/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.100/)).toBeInTheDocument();
    // Twice on purpose: once on the row as a fact about the relay, once in the
    // confirmation as a consequence of the thing about to happen.
    expect(screen.getAllByText(/stays until it is set back/).length).toBeGreaterThan(1);
  });

  it("says a device offers no relays rather than showing an empty list", async () => {
    render({ ...IO, relay_outputs: [], device_io_supported: false });
    expect(await screen.findByText(/offers no Device I\/O service/i)).toBeInTheDocument();
  });
});
