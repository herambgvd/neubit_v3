import { describe, expect, it } from "vitest";
import {
  anprConfidenceText,
  anprInvestigateHref,
  anprListLabel,
  anprOf,
  anprSceneStill,
  anprVehicleText,
  confidencePct,
  matchesEventSearch,
} from "./anprLib";

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

  it("says when the camera reported no confidence, instead of a bare dash", () => {
    expect(anprConfidenceText(null)).toBe("Not reported by the camera");
    expect(anprConfidenceText(0.9)).toBe("90%");
  });

  it("describes the vehicle only from what the camera reported", () => {
    expect(anprVehicleText({ vehicle_color: "White", vehicle_brand: " Toyota ", vehicle_type: "car" })).toBe("White Toyota car");
    expect(anprVehicleText({ vehicle_type: "" })).toBe("");
    expect(anprVehicleText(null)).toBe("");
  });

  it("shows the scene of a read first, the plate crop only as a last resort", () => {
    expect(anprSceneStill(["plate", "linked-hall", "scene"])).toBe("scene");
    expect(anprSceneStill(["plate", "vehicle"])).toBe("vehicle");
    expect(anprSceneStill(["plate"])).toBe("plate");
    expect(anprSceneStill(["linked-hall"])).toBeNull();
  });
});

describe("matchesEventSearch", () => {
  it("finds a plate in the title however it is typed", () => {
    expect(matchesEventSearch("Plate PB10GN4497 · Gate ANPR", " pb10gn ")).toBe(true);
    expect(matchesEventSearch("Plate PB10GN4497 · Gate ANPR", "HR87")).toBe(false);
    expect(matchesEventSearch(null, "PB10")).toBe(false);
    expect(matchesEventSearch(null, "  ")).toBe(true);
  });
});
