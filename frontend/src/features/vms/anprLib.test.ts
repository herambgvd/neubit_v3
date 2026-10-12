import { describe, expect, it } from "vitest";
import { anprInvestigateHref, anprListLabel, anprOf, anprStills, confidencePct } from "./anprLib";

const event = {
  event_type: "anpr",
  raw: {
    node_id: "node-1",
    payload: {
      anpr: { read_id: "r1", plate: "PB10GN4497", list: "block", list_label: "Stolen", confidence: 0.99 },
      linked_camera_ids: ["hall", "", "gate"],
    },
  },
};

describe("anprOf", () => {
  it("reads the plate a recorder's plate-read event carries", () => {
    expect(anprOf(event)).toEqual({
      readId: "r1",
      nodeId: "node-1",
      plate: "PB10GN4497",
      noPlate: false,
      list: "block",
      listLabel: "Stolen",
      confidence: 0.99,
      linkedCameraIds: ["hall", "gate"],
    });
  });

  it("is nothing for any other event", () => {
    expect(anprOf({ event_type: "motion", raw: event.raw })).toBeNull();
    expect(anprOf(null)).toBeNull();
  });
});

describe("anprInvestigateHref", () => {
  it("opens the ANPR camera and its linked cameras at the read, once each", () => {
    const a = anprOf(event)!;
    const href = anprInvestigateHref("anpr-cam", { ...a, linkedCameraIds: ["hall", "anpr-cam"] }, "2026-10-12T06:54:31Z");
    const q = new URLSearchParams(href.split("?")[1]);
    expect(q.getAll("camera")).toEqual(["anpr-cam", "hall"]);
    expect(q.get("t")).toBe("2026-10-12T06:54:31Z");
  });
});

describe("words", () => {
  it("names lists and confidence", () => {
    expect(anprListLabel("block", "Stolen")).toBe("Block list: Stolen");
    expect(anprListLabel("")).toBe("Not listed");
    expect(confidencePct(0.634)).toBe("63%");
    expect(confidencePct(null)).toBe("—");
  });

  it("orders stills plate first and leaves out linked frames", () => {
    expect(anprStills(["linked-hall", "scene", "plate", "evidence"])).toEqual(["plate", "scene", "evidence"]);
  });
});
