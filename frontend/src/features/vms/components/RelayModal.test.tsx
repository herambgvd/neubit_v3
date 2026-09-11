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

import { relayBehaviour, sharedChannels } from "./RelayModal";

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
