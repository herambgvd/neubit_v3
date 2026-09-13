/**
 * THE CONTROL AN OPERATOR ACTUALLY TYPES AN INCIDENT INTO.
 *
 * `FormRenderer` is the builder's preview; this is the one in
 * `TransitionFormModal`, where a responder fills a SOP form to move an incident
 * on. The two dispatch over the same `FieldType`, and only this one's output is
 * kept — what it hands to `onChange` becomes the transition's `form_data` and is
 * stored against the incident for as long as the incident exists.
 *
 * Three things here fail silently, which is why they are tested:
 *
 * 1. **`fieldKey`.** It is `id ?? label`, and it is the KEY the answer is stored
 *    under. Get it wrong and the form still submits: the answer just lands under
 *    a name nothing reads, so the field reads back blank forever and the
 *    required-field check on the next transition fails for no visible reason.
 *
 * 2. **A cleared number.** `Number("")` is 0. A 0 stored for a field the
 *    responder emptied is a reading nobody took, on a record that may be read in
 *    an investigation.
 *
 * 3. **Which arm a type gets.** A wrong arm does not throw — the field renders
 *    as a text box and the form still submits. Nothing else in the console
 *    notices, and the author who picked "rating" in the builder never sees it.
 *
 * DELIBERATELY NOT ASSERTED: what `datetime`, `email`, `phone` and `file` render
 * as here. This component has no arm for any of them and they fall through to a
 * plain text box, while `FormRenderer` — the preview the form's author sees —
 * gives all four their own control. That divergence is reported as a bug rather
 * than pinned by a test; asserting today's behaviour would make the bug the
 * contract.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import FormFieldInput, { fieldKey, fieldRequired, readInput } from "./FormFieldInput";
import type { FormFieldSchema, FormFieldValue } from "../../types";

function show(
  field: Partial<FormFieldSchema>,
  props: Partial<{ value: FormFieldValue; error: string; onChange: (v: FormFieldValue) => void }> = {},
) {
  const full = { id: "q", label: "Question", type: "text", ...field } as FormFieldSchema;
  return render(
    <FormFieldInput field={full} value={props.value} error={props.error} onChange={props.onChange ?? (() => {})} />,
  );
}

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
];

describe("the key an answer is stored under", () => {
  it("prefers the field's id, because that is what the backend keyed the schema by", () => {
    expect(fieldKey({ id: "f7", label: "Casualties?", type: "number" } as FormFieldSchema)).toBe("f7");
  });

  it("falls back to the label for a field stored before ids existed", () => {
    // A legacy row with no id must still round-trip. Returning undefined would
    // key every such answer under the string "undefined" — all of them the same.
    expect(fieldKey({ label: "Casualties?", type: "number" } as FormFieldSchema)).toBe("Casualties?");
  });

  it("reads required out of the validation block and not off the field itself", () => {
    // The backend nests it. Read from the wrong level and every field is
    // optional, so a transition that should have been blocked goes through.
    expect(fieldRequired({ label: "x", type: "text", validation: { required: true } } as FormFieldSchema)).toBe(true);
    expect(fieldRequired({ label: "x", type: "text" } as FormFieldSchema)).toBe(false);
  });
});

describe("what a typed control reports back", () => {
  it("keeps an emptied number field empty rather than turning it into zero", () => {
    // `Number("")` is 0. On an incident form that is the difference between
    // "nobody answered" and "they answered zero".
    expect(readInput("number", "")).toBe("");
    expect(readInput("number", "4")).toBe(4);
  });

  it("leaves a text field's value a string, digits included", () => {
    // A door number or a badge id that silently became a number would lose its
    // leading zeros the moment it round-tripped.
    expect(readInput("text", "007")).toBe("007");
  });

  it("reports a cleared number through the rendered control, not only the helper", async () => {
    const onChange = vi.fn();
    const { container } = show({ type: "number" }, { onChange, value: 7 });
    await userEvent.clear(container.querySelector("input") as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("reports a text edit as the string typed", async () => {
    const onChange = vi.fn();
    show({ type: "text" }, { onChange, value: "" });
    // One keystroke: the control is driven by `value`, which a test holding it
    // at "" never advances.
    await userEvent.type(screen.getByRole("textbox"), "o");
    expect(onChange).toHaveBeenLastCalledWith("o");
  });
});

describe("the control each field type renders", () => {
  it("gives a textarea its own element, not a one-line input", () => {
    // "Describe what happened" rendered one line tall is the complaint this
    // arm exists to prevent, and it is invisible in a schema diff.
    const { container } = show({ type: "textarea" });
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("gives number and date the native input types their keypad and picker ride on", () => {
    for (const [type, inputType] of [["number", "number"], ["date", "date"]] as const) {
      const { container, unmount } = show({ type });
      expect(container.querySelector("input")?.getAttribute("type"), type).toBe(inputType);
      unmount();
    }
  });

  it("falls back to a text box for a type it has never heard of", () => {
    // A field stored before a type was retired still has to render rather than
    // landing on whichever arm happened to be last.
    const { container } = show({ type: "signature" as FormFieldSchema["type"] });
    expect(container.querySelector("input")?.getAttribute("type")).toBe("text");
  });

  it("renders a select carrying an empty placeholder option ahead of the real ones", () => {
    // Without the blank first option the first real answer is pre-selected and
    // a responder who never touched the field has silently answered it.
    const { container } = show({ type: "select", options: OPTIONS });
    const opts = Array.from(container.querySelectorAll("option"));
    expect(opts.map((o) => o.getAttribute("value"))).toEqual(["", "a", "b"]);
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("");
  });

  it("renders a radio group as one radio per option with only the chosen one checked", () => {
    show({ type: "radio", options: OPTIONS }, { value: "b" });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
  });

  it("renders a multiselect as one tick box per option, ticking the chosen ones", () => {
    show({ type: "multiselect", options: OPTIONS }, { value: ["b"] });
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
  });

  it("renders a rating as five stars and shows the score beside them", () => {
    show({ type: "rating" }, { value: 3 });
    expect(screen.getAllByTitle(/of 5$/)).toHaveLength(5);
    expect(screen.getByText("3/5")).toBeInTheDocument();
  });

  it("shows a dash rather than 0/5 for a rating nobody has answered", () => {
    // 0 of 5 reads as a scored zero. An unanswered optional rating has no score.
    show({ type: "rating" });
    expect(screen.getByText("—/5")).toBeInTheDocument();
  });

  it("says so rather than rendering an empty box when an option list is empty", () => {
    // An option-driven control with no options is an authoring mistake; a blank
    // bordered rectangle reads as a control that failed to load.
    const { unmount } = show({ type: "multiselect", options: [] });
    expect(screen.getByText("No options")).toBeInTheDocument();
    unmount();

    show({ type: "radio", options: [] });
    expect(screen.getByText("No options")).toBeInTheDocument();
  });

  it("renders a boolean as one checkbox carrying its own affirmative wording", () => {
    show({ type: "boolean", placeholder: "Site was made safe" });
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText("Site was made safe")).toBeInTheDocument();
  });

  it("gives a boolean with no placeholder a default word beside the box", () => {
    // A naked tick box with nothing beside it is a question with no question.
    show({ type: "boolean" });
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });
});

describe("what the option controls report back", () => {
  it("adds a ticked multiselect option to the array and removes an unticked one", async () => {
    const onChange = vi.fn();
    show({ type: "multiselect", options: OPTIONS }, { onChange, value: ["a"] });
    const [alpha, bravo] = screen.getAllByRole("checkbox");
    await userEvent.click(bravo);
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    await userEvent.click(alpha);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("treats a multiselect whose stored value is not an array as nothing chosen", () => {
    // A field whose type was changed in the builder after answers existed
    // arrives holding a string. `.includes` on it would tick every option whose
    // value is a substring, and `.filter` would throw on the next click.
    show({ type: "multiselect", options: OPTIONS }, { value: "a" as unknown as string[] });
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false]);
  });

  it("reports a radio choice as the option's value, not its label", async () => {
    // The label is what a human reads; the value is what the SOP's rules match on.
    const onChange = vi.fn();
    show({ type: "radio", options: OPTIONS }, { onChange });
    await userEvent.click(screen.getByText("Bravo"));
    expect(onChange).toHaveBeenLastCalledWith("b");
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

  it("reports a boolean as true and false rather than as the checkbox's string", async () => {
    const onChange = vi.fn();
    show({ type: "boolean" }, { onChange, value: false });
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("a value of the wrong shape for the control holding it", () => {
  it("renders a text control empty rather than printing true or a joined array", () => {
    // Types are edited in the builder after answers exist. `value={true}` in a
    // text box renders the word "true", which then gets SAVED as the answer on
    // the next submit.
    const { container, unmount } = show({ type: "text" }, { value: true });
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    unmount();

    const second = show({ type: "text" }, { value: ["a", "b"] });
    expect((second.container.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("keeps a number value in a text-ish control", () => {
    const { container } = show({ type: "text" }, { value: 42 });
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("42");
  });
});

describe("the label, the help text and the error", () => {
  it("shows the label, and marks a required field with an asterisk", () => {
    show({ type: "text", label: "Casualties?", validation: { required: true } });
    expect(screen.getByText("Casualties?")).toBeInTheDocument();
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("leaves an optional field unmarked", () => {
    // An asterisk on every field tells a responder nothing about which ones
    // actually block the transition.
    show({ type: "text", label: "Casualties?" });
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("falls back to the field's key when a field was saved with no label", () => {
    // An unlabelled field is an authoring mistake; an unlabelled BLANK is a
    // control a responder cannot answer because nothing says what it asks.
    show({ id: "f7", label: "", type: "text" });
    expect(screen.getByText("f7")).toBeInTheDocument();
  });

  it("prints the help text beside the control", () => {
    show({ type: "text", help_text: "As it appears on the permit" });
    expect(screen.getByText("As it appears on the permit")).toBeInTheDocument();
  });

  it("outlines the control in error and prints the message under it", () => {
    const { container } = show({ type: "text" }, { error: "Required" });
    expect(container.querySelector("input")?.className).toContain("border-red-500");
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("leaves a healthy control unoutlined and silent", () => {
    const { container } = show({ type: "text" });
    expect(container.querySelector("input")?.className).not.toContain("border-red-500");
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("outlines the arm the type chose, not only the plain text one", () => {
    // The error class is threaded per arm. An arm that drops it renders a field
    // that looks fine while its own message below says it is not, and the
    // responder is sent to correct whichever field IS outlined.
    const textarea = show({ type: "textarea" }, { error: "Required" });
    expect(textarea.container.querySelector("textarea")?.className).toContain("border-red-500");
    textarea.unmount();

    const select = show({ type: "select", options: OPTIONS }, { error: "Required" });
    expect(select.container.querySelector("select")?.className).toContain("border-red-500");
  });

  it("still shows a boolean field's message, which has no outline to carry it", () => {
    show({ type: "boolean" }, { error: "You must confirm this" });
    expect(screen.getByText("You must confirm this")).toBeInTheDocument();
  });
});
