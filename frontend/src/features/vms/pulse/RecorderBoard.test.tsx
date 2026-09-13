/**
 * The System-Monitor board is the ONE screen in Pulse whose payload nobody has
 * validated. `app/vms/pulse/router.py` says so in as many words — the board is
 * "passed through rather than reshaped", because a field this service has never
 * heard of is still a field an operator needs to see. The estate roll-up coerces
 * (`int(cameras.get("total") or 0)` in rollup.node_view); this route does not.
 *
 * So every figure here arrives as whatever the recorder sent, and the failure
 * this file guards is not a crash. It is the board looking answered: a camera
 * count slot that reads "[object Object]", or a recording count that reads
 * "NaN", from a recorder one schema version away from ours.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import RecorderBoard from "./RecorderBoard";
import type { NodeSysmon } from "../types";

/** A recorder that reports its counts as structured objects rather than ints —
 *  the shape a `{value, unit}`-style board would send. Nothing in the VMS
 *  rejects it, so the console is where it either reads or lies. */
const STRUCTURED = {
  node_id: "n1",
  node_name: "north",
  verdict: { level: "ok", headline: "Recorder healthy" },
  sensors_reported: true,
  system: {},
  cameras: {
    total: { value: 4 },
    online: { value: 3 },
    recording_active: { value: 3 },
    items: [{ id: { value: "c1" }, name: { value: "Ramp" }, status: { value: "online" } }],
  },
  volumes: [],
} as unknown as NodeSysmon;

describe("a recorder whose board is not the shape we expect", () => {
  it("never prints an object's type name where a number belongs", () => {
    renderWithProviders(<RecorderBoard board={STRUCTURED} />);
    expect(document.body.textContent).not.toContain("[object Object]");
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("shows the counts as numbers, so the strip reads as a count either way", () => {
    renderWithProviders(<RecorderBoard board={STRUCTURED} />);
    // Not the recorder's 3 and 4 — those were never numbers. The point is that
    // the slot holds a count, not a rendered object.
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("still reads a board that IS the shape we expect", () => {
    const ok = {
      node_id: "n1",
      node_name: "north",
      verdict: { level: "ok", headline: "Recorder healthy" },
      sensors_reported: true,
      system: {},
      cameras: { total: 4, online: 3, recording_active: 3, recording_gap_free: true, items: [] },
      volumes: [],
    } as unknown as NodeSysmon;
    renderWithProviders(<RecorderBoard board={ok} />);
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
  });
});
