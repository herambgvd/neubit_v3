/**
 * The guided builder turns a payload NOBODY controls — whatever the vendor
 * pasted — into the webhook's transform map. Every property here is about not
 * losing or inventing a field on the way:
 *
 *   • the walk has to survive nesting, arrays, nulls and a sample that is not an
 *     object at all, because all four arrive in real vendor samples;
 *   • two leaves with the same last segment must not collapse onto one output
 *     key, or the operator silently loses a field they ticked;
 *   • the JSON parse error is DERIVED from the pasted text (a memo), not state
 *     written during render — that was a real defect, and it comes back the
 *     moment someone "simplifies" the memo into a useState + useEffect.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import PayloadFieldsBuilder, {
  fieldsToTransform,
  previewValue,
  transformToFields,
} from "./PayloadFieldsBuilder";
import type { BuilderField } from "../types";

/** The parent owns the state; this is the smallest honest stand-in for it. */
function Harness({ initialText = "" }: { initialText?: string }) {
  const [text, setText] = useState(initialText);
  const [fields, setFields] = useState<BuilderField[]>([]);
  return (
    <>
      <PayloadFieldsBuilder
        sampleText={text}
        onSampleTextChange={setText}
        fields={fields}
        onFieldsChange={setFields}
      />
      {/* The transform the parent would actually save, exposed so the test reads
          the OUTPUT of the builder rather than its internals. */}
      <pre data-testid="transform">{JSON.stringify(fieldsToTransform(fields))}</pre>
    </>
  );
}

const findFields = () => screen.getByRole("button", { name: /find fields|re-analyze/i });

/** Paste a sample and press the analyse button. */
async function analyse(sample: string) {
  const user = userEvent.setup();
  render(<Harness initialText={sample} />);
  await user.click(findFields());
  return user;
}

/** The sample <textarea>; the per-field name inputs are textboxes too. */
const sampleBox = () => screen.getAllByRole("textbox")[0];

describe("walking an arbitrary sample", () => {
  it("lists every leaf of a nested object by its dotted path", async () => {
    await analyse('{"device":{"name":"Cam-04","mac":"AA:BB"},"alarm":{"type":"motion"}}');

    expect(screen.getByText("device.name")).toBeInTheDocument();
    expect(screen.getByText("device.mac")).toBeInTheDocument();
    expect(screen.getByText("alarm.type")).toBeInTheDocument();
    expect(screen.getByText(/3 fields found/)).toBeInTheDocument();
  });

  it("walks an array's first element only, since the rest repeat its shape", async () => {
    await analyse('{"events":[{"code":"E1"},{"code":"E2"},{"code":"E3"}]}');

    expect(screen.getByText("events[0].code")).toBeInTheDocument();
    expect(screen.queryByText("events[1].code")).not.toBeInTheDocument();
    expect(screen.getByText(/1 field found/)).toBeInTheDocument();
  });

  it("keeps a null-valued key as a field rather than dropping the address", async () => {
    await analyse('{"device":{"floor":null}}');

    expect(screen.getByText("device.floor")).toBeInTheDocument();
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("keeps an empty array as one leaf instead of recursing into nothing", async () => {
    await analyse('{"tags":[]}');

    expect(screen.getByText("tags")).toBeInTheDocument();
    expect(screen.getByText(/1 field found/)).toBeInTheDocument();
  });

  it("finds nothing under an empty object, and says so instead of erroring", async () => {
    await analyse('{"meta":{}}');

    expect(screen.queryByText(/fields found/)).not.toBeInTheDocument();
    expect(screen.getByTestId("transform")).toHaveTextContent("{}");
  });

  it("finds nothing in a sample that is not an object, rather than throwing", async () => {
    await analyse("42");

    expect(screen.queryByText(/fields found/)).not.toBeInTheDocument();
    expect(screen.getByTestId("transform")).toHaveTextContent("{}");
  });

  it("gives two leaves that share a last segment DISTINCT output keys", async () => {
    // Both end in `name`; one output key for both would drop a field the
    // operator ticked, and the loss is invisible in the saved transform.
    await analyse('{"device":{"name":"Cam-04"},"site":{"name":"HQ"}}');

    const transform = JSON.parse(screen.getByTestId("transform").textContent || "{}") as Record<
      string,
      string
    >;
    expect(Object.values(transform).sort()).toEqual(["device.name", "site.name"]);
    expect(Object.keys(transform)).toHaveLength(2);
  });
});

describe("the auto-tick heuristic", () => {
  it("pre-ticks the device-identifying keys and leaves unknown ones alone", async () => {
    await analyse('{"device":{"mac":"AA:BB","vendor_blob":"zzz"}}');

    const transform = JSON.parse(screen.getByTestId("transform").textContent || "{}") as Record<
      string,
      string
    >;
    expect(transform).toEqual({ mac: "device.mac" });
  });

  it("only writes a field into the transform once it is ticked", async () => {
    const user = await analyse('{"device":{"vendor_blob":"zzz"}}');
    expect(screen.getByTestId("transform")).toHaveTextContent("{}");

    await user.click(screen.getByRole("checkbox"));

    expect(screen.getByTestId("transform")).toHaveTextContent('{"vendor_blob":"device.vendor_blob"}');
  });
});

describe("the JSON parse error", () => {
  it("is shown on the first paint of a bad sample, computed from the text itself", () => {
    // No `await`, no `waitFor`: a memo answers within the render that produced
    // it. State written during render would need a second pass to show this.
    render(<Harness initialText="{not json" />);

    expect(screen.getByText(/JSON error:/)).toBeInTheDocument();
    expect(findFields()).toBeDisabled();
  });

  it("renders that error without React complaining about a render-phase update", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<Harness initialText="{not json" />);

    expect(screen.getByText(/JSON error:/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("tracks the pasted text both ways — appearing and clearing with it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = sampleBox();

    await user.type(box, "{{bad");
    expect(screen.getByText(/JSON error:/)).toBeInTheDocument();

    await user.clear(box);
    await user.type(box, '{{"a":1}');
    expect(screen.queryByText(/JSON error:/)).not.toBeInTheDocument();
    expect(findFields()).toBeEnabled();
  });

  it("refuses to analyse an empty sample without calling it an error", () => {
    render(<Harness />);

    expect(screen.queryByText(/JSON error:/)).not.toBeInTheDocument();
    expect(findFields()).toBeDisabled();
  });
});

describe("re-analysing a changed sample", () => {
  it("preserves the operator's edits for paths that are still there", async () => {
    const user = await analyse('{"device":{"vendor_blob":"zzz"}}');
    await user.click(screen.getByRole("checkbox"));
    const nameInput = screen.getByDisplayValue("vendor_blob");
    await user.clear(nameInput);
    await user.type(nameInput, "blob");

    // A wider sample: the edited row must survive, the new leaf must appear.
    const box = sampleBox();
    await user.clear(box);
    await user.type(box, '{{"device":{{"vendor_blob":"zzz","mac":"AA"}}');
    await user.click(findFields());

    const transform = JSON.parse(screen.getByTestId("transform").textContent || "{}") as Record<
      string,
      string
    >;
    expect(transform).toEqual({ blob: "device.vendor_blob", mac: "device.mac" });
  });
});

describe("the shape converters the parent form round-trips through", () => {
  it("keeps only ticked, named, resolvable rows in the saved transform", () => {
    expect(
      fieldsToTransform([
        { path: "a.b", name: "keep", checked: true },
        { path: "a.c", name: "dropped", checked: false },
        { path: "a.d", name: "", checked: true },
        { path: "", name: "nopath", checked: true },
      ]),
    ).toEqual({ keep: "a.b" });
  });

  it("tolerates no field list at all", () => {
    expect(fieldsToTransform(null)).toEqual({});
    expect(fieldsToTransform(undefined)).toEqual({});
  });

  it("rebuilds an editable, all-ticked list from a saved transform", () => {
    expect(transformToFields({ title: "event.name" })).toEqual([
      { path: "event.name", name: "title", checked: true },
    ]);
    expect(transformToFields(null)).toEqual([]);
  });

  it("survives a saved transform whose value is not a string", () => {
    expect(transformToFields({ title: 7 })).toEqual([{ path: "", name: "title", checked: true }]);
  });
});

describe("previewValue", () => {
  const sample = { device: { name: "Cam-04" }, events: [{ code: "E1" }] };

  it.each([
    ["a nested path", "device.name", "Cam-04"],
    ["an indexed path", "events[0].code", "E1"],
    ["a path that is not there", "device.serial", undefined],
    ["a path through a missing parent", "nope.deep", undefined],
  ])("resolves %s", (_label, path, expected) => {
    expect(previewValue(sample, path)).toEqual(expected);
  });

  it("resolves nothing without a sample or without a path", () => {
    expect(previewValue(null, "device.name")).toBeUndefined();
    expect(previewValue(sample, "")).toBeUndefined();
  });
});
