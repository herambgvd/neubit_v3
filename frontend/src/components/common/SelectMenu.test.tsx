/**
 * The picker that replaced the native <select>. The contract it has to keep is
 * that it stays DROP-IN COMPATIBLE with the thing it replaced: a handler written
 * for `<select onChange={e => setX(e.target.value)}>` must keep working, which
 * means the emitted event carries the OPTION'S VALUE and not its label, its
 * index, or a DOM event.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import SelectMenu from "./SelectMenu";

const OPTIONS = [
  { value: "s1", label: "HQ — Pune" },
  { value: "s2", label: "Warehouse" },
  { value: "s3", label: "Roof" },
];

describe("SelectMenu", () => {
  it("emits the option's value, in the shape a native-select handler expects", async () => {
    const onChange = vi.fn();
    render(<SelectMenu options={OPTIONS} value="s1" onChange={onChange} />);

    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByRole("option", { name: "Warehouse" }));

    expect(onChange).toHaveBeenCalledWith({ target: { value: "s2" } });
  });

  it("keeps the options out of the document until it is opened", async () => {
    render(<SelectMenu options={OPTIONS} value="s1" onChange={vi.fn()} />);

    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("closes again once a choice is made, so the panel never sits over the form", async () => {
    render(<SelectMenu options={OPTIONS} value="s1" onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByRole("option", { name: "Roof" }));

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the selected option's label, and the placeholder when nothing is selected", () => {
    const { rerender } = render(
      <SelectMenu options={OPTIONS} value="s2" onChange={vi.fn()} placeholder="Pick a site" />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Warehouse");

    rerender(<SelectMenu options={OPTIONS} value={null} onChange={vi.fn()} placeholder="Pick a site" />);

    expect(screen.getByRole("button")).toHaveTextContent("Pick a site");
  });

  it("matches the current value across the string/number divide the wire introduces", () => {
    render(<SelectMenu options={[{ value: "7", label: "Channel 7" }]} value={7} onChange={vi.fn()} />);

    expect(screen.getByRole("button")).toHaveTextContent("Channel 7");
  });

  it("announces which option is the current one to assistive tech", async () => {
    render(<SelectMenu options={OPTIONS} value="s2" onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("option", { name: "Warehouse" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Roof" })).toHaveAttribute("aria-selected", "false");
  });

  it("is operable from the keyboard alone, and picks by value there too", async () => {
    const onChange = vi.fn();
    render(<SelectMenu options={OPTIONS} value="s1" onChange={onChange} />);

    screen.getByRole("button").focus();
    await userEvent.keyboard("{ArrowDown}"); // opens, active = current (s1)
    await userEvent.keyboard("{ArrowDown}"); // → s2
    await userEvent.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith({ target: { value: "s2" } });
  });

  it("closes on Escape without choosing anything", async () => {
    const onChange = vi.fn();
    render(<SelectMenu options={OPTIONS} value="s1" onChange={onChange} />);

    await userEvent.click(screen.getByRole("button"));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open while disabled", async () => {
    render(<SelectMenu options={OPTIONS} value="s1" disabled onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button"));

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says an empty option list is empty instead of opening a blank panel", async () => {
    render(<SelectMenu options={[]} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByText("No options")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("closes when the operator clicks away", async () => {
    render(
      <div>
        <SelectMenu options={OPTIONS} value="s1" onChange={vi.fn()} />
        <p>elsewhere</p>
      </div>,
    );

    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByText("elsewhere"));

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
