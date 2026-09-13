/**
 * WHICH CONTROL A FIELD TYPE ACTUALLY GETS, and where an error is shown.
 *
 * A dynamic form is authored by somebody who never sees this file: they pick a
 * type in the builder and trust that `rating` is five stars, `date` is a date
 * picker and `multiselect` is a list of tick boxes. The renderer is the only
 * thing that keeps that promise, and it keeps it through a switch whose arms
 * are one line each — the shape most likely to lose an arm silently. A wrong
 * arm does not throw: the field renders, it just renders as a text box, and the
 * form still submits. Nothing else in this console would notice.
 *
 * The second half is the error class. `errCls` is computed once and threaded
 * into each control, which is what makes "the invalid field is the one outlined
 * in red" true. Threaded into the wrong one, or dropped from an arm, and the
 * viewer is sent to correct a field that is fine while the broken one looks
 * ordinary — the message below still names the right field, so the two disagree.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import FormRenderer from "./FormRenderer";
import type { FormFieldSchema, FormFieldValue } from "../../types";

/** `#ff-<id>` is the id every arm puts on the control it owns. */
const CONTROL = "#ff-q";

function show(field: Partial<FormFieldSchema>, props: Partial<{
  value: FormFieldValue;
  onChange: (v: FormFieldValue) => void;
  error: string | null;
  disabled: boolean;
}> = {}) {
  const full = { id: "q", label: "Question", type: "text", ...field } as FormFieldSchema;
  return render(<FormRenderer field={full} value={props.value} {...props} />);
}

const control = (c: HTMLElement) => c.querySelector(CONTROL);

describe("the control each field type renders", () => {
  it("gives a textarea its own element, not a one-line input", () => {
    // A "describe what happened" box that renders one line tall is the single
    // most reported form complaint, and it is invisible in a schema diff.
    const { container } = show({ type: "textarea" });
    expect(control(container)?.tagName).toBe("TEXTAREA");
  });

  it("gives number, date, datetime and file their native input types", () => {
    // The browser's own picker and keypad ride on these. `datetime` is the one
    // that does not match its own name — the HTML type is datetime-local.
    for (const [type, inputType] of [
      ["number", "number"],
      ["date", "date"],
      ["datetime", "datetime-local"],
      ["file", "file"],
    ] as const) {
      const { container, unmount } = show({ type });
      expect(control(container)?.getAttribute("type"), type).toBe(inputType);
      unmount();
    }
  });

  it("maps email and phone onto the keyboards they need, and anything else onto text", () => {
    for (const [type, inputType] of [
      ["email", "email"],
      ["phone", "tel"],
      ["text", "text"],
      // A type this renderer has never heard of falls back to text rather than
      // to whichever arm happened to be last. Not in `FieldType` — which is the
      // point: a row stored before the type was retired still has to render.
      ["signature", "text"],
    ] as [string, string][]) {
      const { container, unmount } = show({ type: type as FormFieldSchema["type"] });
      expect(control(container)?.getAttribute("type"), type).toBe(inputType);
      unmount();
    }
  });

  it("renders a select as the picker trigger, carrying the placeholder", () => {
    const { container } = show({
      type: "select",
      options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Bravo" }],
    });
    const trigger = control(container);
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger).toHaveTextContent("— select —");
  });

  it("renders a radio group as one radio per option, grouped under the field's name", () => {
    show({
      type: "radio",
      options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Bravo" }],
    });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // One NAME across the group is what makes them mutually exclusive; without
    // it every option is its own group and a viewer can pick all of them.
    expect(radios.every((r) => r.getAttribute("name") === "ff-q")).toBe(true);
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("renders a multiselect as tick boxes, and a rating as five stars", () => {
    const { unmount } = show({
      type: "multiselect",
      options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Bravo" }],
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    unmount();

    show({ type: "rating" });
    // Titled rather than named: the button's content is the star itself.
    expect(screen.getAllByTitle(/of 5$/)).toHaveLength(5);
  });

  it("says so rather than rendering an empty box when an option list is empty", () => {
    // An option-driven control with no options is an authoring mistake. A blank
    // bordered rectangle reads as a control that failed to load.
    const { unmount } = show({ type: "multiselect", options: [] });
    expect(screen.getByText("No options")).toBeInTheDocument();
    unmount();

    show({ type: "radio", options: [] });
    expect(screen.getByText("No options")).toBeInTheDocument();
  });

  it("renders a boolean as one inline checkbox that carries the field's own label", () => {
    // The only arm with no FieldLabel above it: the label sits beside the box.
    // Lose it and the question disappears while the tick box remains.
    show({ type: "boolean", label: "Site was made safe" });
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText("Site was made safe")).toBeInTheDocument();
  });
});

describe("what a control reports back", () => {
  it("reports a text edit as the string typed", async () => {
    const onChange = vi.fn();
    show({ type: "text" }, { onChange, value: "" });
    // One keystroke: the field is controlled by the `value` prop, which a test
    // holding it at "" never advances, so a second keystroke would report the
    // second letter alone rather than "ok".
    await userEvent.type(screen.getByRole("textbox"), "o");
    expect(onChange).toHaveBeenLastCalledWith("o");
  });

  it("reports a number as a number, and an emptied one as empty rather than NaN", async () => {
    // `Number("")` is 0, and a 0 stored for a field the viewer cleared is a
    // reading nobody took.
    const onChange = vi.fn();
    const { container } = show({ type: "number" }, { onChange, value: 7 });
    await userEvent.clear(container.querySelector(CONTROL) as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("adds a ticked multiselect option to the array and removes an unticked one", async () => {
    const onChange = vi.fn();
    show(
      { type: "multiselect", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Bravo" }] },
      { onChange, value: ["a"] },
    );
    const [alpha, bravo] = screen.getAllByRole("checkbox");
    await userEvent.click(bravo);
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    await userEvent.click(alpha);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("clears a rating when the star already scored is pressed again", async () => {
    // The only route back to "not answered" on an optional rating.
    const onChange = vi.fn();
    show({ type: "rating" }, { onChange, value: 3 });
    await userEvent.click(screen.getByTitle("3 of 5"));
    expect(onChange).toHaveBeenLastCalledWith(0);
    await userEvent.click(screen.getByTitle("4 of 5"));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });
});

describe("where the error lands", () => {
  it("outlines the control that is in error and prints the message under it", () => {
    const { container } = show({ type: "text" }, { error: "Required" });
    expect(control(container)?.className).toContain("!border-nb-crit");
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("leaves a healthy control unoutlined", () => {
    const { container } = show({ type: "text" });
    expect(control(container)?.className).not.toContain("!border-nb-crit");
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("outlines whichever control the type chose, not only the text one", () => {
    // The class is threaded per arm. An arm that forgets it renders a field that
    // looks fine while its own message says it is not.
    for (const type of ["textarea", "number", "date", "datetime", "file", "email"] as const) {
      const { container, unmount } = show({ type }, { error: "Required" });
      expect(control(container)?.className, type).toContain("!border-nb-crit");
      unmount();
    }
  });

  it("still shows a boolean field's message, which has no outline to carry it", () => {
    show({ type: "boolean" }, { error: "You must confirm this" });
    expect(screen.getByText("You must confirm this")).toBeInTheDocument();
  });

  it("marks a required field and shows help text beside the control", () => {
    show({ type: "text", help_text: "As it appears on the permit", validation: { required: true } });
    expect(screen.getByText("As it appears on the permit")).toBeInTheDocument();
    expect(screen.getByText("*")).toBeInTheDocument();
  });
});
