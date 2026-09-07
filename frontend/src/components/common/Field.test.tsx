/**
 * The canonical form field. Its subtle job is the controlled/uncontrolled
 * guard: a form that re-hydrates (switching camera, loading a record) hands this
 * a momentarily-undefined value, and React would warn — and lose the caret —
 * if the input flipped to uncontrolled. Those tests fail on a console.error,
 * which is what React uses to report it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Field } from "./Field";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Field", () => {
  it("shows the error in place of the hint, never both", () => {
    const { rerender } = render(<Field label="Name" hint="As it appears on site" />);
    expect(screen.getByText("As it appears on site")).toBeInTheDocument();

    rerender(<Field label="Name" hint="As it appears on site" error="Name is taken" />);

    expect(screen.getByText("Name is taken")).toBeInTheDocument();
    expect(screen.queryByText("As it appears on site")).toBeNull();
  });

  it("marks a required field visibly", () => {
    render(<Field label="Name" required />);
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("stays a controlled input when the caller's value goes missing mid-form", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<Field aria-label="Name" value="Lobby" onChange={vi.fn()} />);

    rerender(<Field aria-label="Name" value={null} onChange={vi.fn()} />);

    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a checkbox controlled the same way", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Field aria-label="Enabled" type="checkbox" checked={undefined} onChange={vi.fn()} />);

    expect(screen.getByLabelText("Enabled")).not.toBeChecked();
    expect(error).not.toHaveBeenCalled();
  });

  it("renders the control the caller asked for — input, textarea or picker", () => {
    const { rerender, container } = render(<Field aria-label="Notes" as="textarea" onChange={vi.fn()} />);
    expect(container.querySelector("textarea")).toBeTruthy();

    rerender(
      <Field
        label="Priority"
        as="select"
        value="high"
        options={[{ value: "high", label: "High" }]}
        onChange={vi.fn()}
      />,
    );

    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.getByRole("button")).toHaveTextContent("High");
  });

  it("gives a select-typed Field the same `e.target.value` shape as a text one", async () => {
    const onChange = vi.fn();
    render(
      <Field
        label="Priority"
        as="select"
        value=""
        options={[{ value: "high", label: "High" }]}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByRole("option", { name: "High" }));

    expect(onChange.mock.calls[0]?.[0]).toEqual({ target: { value: "high" } });
  });
});
