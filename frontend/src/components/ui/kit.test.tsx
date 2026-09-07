/**
 * The shared kit primitives. These are the properties a screen relies on without
 * ever restating them: that a button in a form doesn't submit it by accident,
 * that an invalid field says so to assistive tech, that a checkbox hands back a
 * boolean, that a closed modal is really gone, and that cancelling a destructive
 * confirmation destroys nothing.
 *
 * Nothing here asserts a class name or an internal state — a reskin must be free
 * to move every colour in this file without turning a single one of these red.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Drawer,
  Input,
  Modal,
  PasswordInput,
  Select,
  Table,
  Textarea,
} from "./kit";

describe("Button", () => {
  it("does not submit the form it sits in unless it asks to", async () => {
    // The default `type` is the whole guard: a bare <button> inside a <form> is a
    // submit button, so a "Add row" next to a Save would post the half-filled form.
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Add row</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add row" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits when the caller does ask for a submit button", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("is inert while disabled — the double-submit this prevents", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicks normally when idle", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a navigating button as a link, not a button nested in one", () => {
    render(
      <Button as="a" href="/sites">
        Sites
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Sites" });
    expect(link).toHaveAttribute("href", "/sites");
    // `type` is a button-only attribute; on an anchor it is meaningless noise.
    expect(link).not.toHaveAttribute("type");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Input", () => {
  it("shows the error in place of the hint, never both", () => {
    const { rerender } = render(<Input aria-label="Host" hint="IPv4 or hostname" />);
    expect(screen.getByText("IPv4 or hostname")).toBeInTheDocument();

    rerender(<Input aria-label="Host" hint="IPv4 or hostname" error="Unreachable" />);

    expect(screen.getByText("Unreachable")).toBeInTheDocument();
    expect(screen.queryByText("IPv4 or hostname")).toBeNull();
  });

  it("tells assistive tech it is invalid, and only while it is", () => {
    const { rerender } = render(<Input aria-label="Host" />);
    expect(screen.getByLabelText("Host")).not.toHaveAttribute("aria-invalid");

    rerender(<Input aria-label="Host" error="Unreachable" />);

    expect(screen.getByLabelText("Host")).toHaveAttribute("aria-invalid", "true");
  });

  it("marks a required field for sight and for assistive tech", () => {
    render(<Input aria-label="Host" label="Host" required />);

    expect(screen.getByLabelText("Host")).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("does not leak `required` to the DOM, so the browser's own bubble never fights the form", () => {
    render(<Input aria-label="Host" required />);
    expect(screen.getByLabelText("Host")).not.toHaveAttribute("required");
  });

  it("passes the caller's typing through to onChange", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="Host" onChange={onChange} />);

    await userEvent.type(screen.getByLabelText("Host"), "nvr");

    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe("PasswordInput", () => {
  it("hides the password until the operator asks to see it, and says which state it is in", async () => {
    render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);
    const field = screen.getByLabelText("Password");
    expect(field).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field).toHaveAttribute("type", "password");
  });

  it("shows the error in place of the hint", () => {
    render(<PasswordInput aria-label="Password" hint="12+ characters" error="Too short" />);

    expect(screen.getByText("Too short")).toBeInTheDocument();
    expect(screen.queryByText("12+ characters")).toBeNull();
  });
});

describe("Textarea", () => {
  it("marks a required area for assistive tech without setting the DOM attribute", () => {
    render(<Textarea aria-label="Notes" required />);
    const area = screen.getByLabelText("Notes");
    expect(area).toHaveAttribute("aria-required", "true");
    expect(area).not.toHaveAttribute("required");
  });
});

describe("Checkbox", () => {
  it("hands the caller the new boolean, not an event to dig through", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Record audio" checked={false} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Record audio"));

    expect(onChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("reports the state it would move to, not the state it is in", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Record audio" checked onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Record audio"));

    expect(onChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("stays controlled: a click without a state change leaves the box as the caller set it", async () => {
    render(<Checkbox label="Record audio" checked={false} onChange={() => {}} />);
    const box = screen.getByLabelText("Record audio");

    await userEvent.click(box);

    expect(box).not.toBeChecked();
  });

  it("fires nothing while disabled", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Record audio" checked={false} disabled onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Record audio"));

    expect(onChange).not.toHaveBeenCalled();
  });
});

// Toggle's own tests live in ./toggle.test.tsx — it grew a role, a state and a
// naming rule, and those belong next to each other rather than in the kit's
// grab-bag. The two cases that were here (the flipped boolean, and silence while
// disabled) moved there intact.

describe("Modal", () => {
  it("renders nothing at all while closed — its children never mount", () => {
    render(
      <Modal open={false} title="Add camera">
        <p>Body</p>
      </Modal>,
    );

    expect(screen.queryByText("Add camera")).toBeNull();
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("shows its title, body and footer once open", () => {
    render(
      <Modal open title="Add camera" subtitle="RTSP" footer={<Button>Create</Button>}>
        <p>Body</p>
      </Modal>,
    );

    expect(screen.getByText("Add camera")).toBeInTheDocument();
    expect(screen.getByText("RTSP")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("gives its close control an accessible name rather than a bare icon", async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Add camera" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Add camera" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    );

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the TOPMOST overlay on Escape — a nested picker must not take the form with it", async () => {
    const closeForm = vi.fn();
    const closePicker = vi.fn();
    render(
      <>
        <Modal open title="Site" onClose={closeForm}>
          <p>Form</p>
        </Modal>
        <Modal open title="Pick on map" onClose={closePicker}>
          <p>Picker</p>
        </Modal>
      </>,
    );

    await userEvent.keyboard("{Escape}");

    expect(closePicker).toHaveBeenCalledTimes(1);
    expect(closeForm).not.toHaveBeenCalled();
  });

  it("a static backdrop click does not throw the half-filled form away", async () => {
    const onClose = vi.fn();
    const { baseElement } = render(
      <Modal open staticBackdrop title="Site" onClose={onClose}>
        <p>Form</p>
      </Modal>,
    );

    // The dim layer is the first child of the portalled wrapper.
    const backdrop = baseElement.querySelector(".fixed.inset-0 > div");
    await userEvent.click(backdrop as Element);

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Drawer", () => {
  it("renders nothing while closed", () => {
    render(
      <Drawer open={false} title="Person">
        <p>Detail</p>
      </Drawer>,
    );

    expect(screen.queryByText("Person")).toBeNull();
    expect(screen.queryByText("Detail")).toBeNull();
  });

  it("shows its title and body once open", () => {
    render(
      <Drawer open title="Person" subtitle="Visitor">
        <p>Detail</p>
      </Drawer>,
    );

    expect(screen.getByText("Person")).toBeInTheDocument();
    expect(screen.getByText("Detail")).toBeInTheDocument();
  });
});

describe("ConfirmDialog", () => {
  const state = { title: "Delete camera?", message: "Lobby will be removed.", onConfirm: vi.fn() };

  it("is closed when there is no state to confirm", () => {
    render(<ConfirmDialog state={null} />);
    expect(screen.queryByText("Delete camera?")).toBeNull();
  });

  it("destroys nothing on cancel — it closes and the action never runs", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog state={{ ...state, onConfirm }} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("destroys nothing when dismissed by Escape or the X either", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog state={{ ...state, onConfirm }} onClose={onClose} />);

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("runs the action only on the confirm button", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog state={{ ...state, onConfirm, confirmLabel: "Delete" }} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cannot be fired twice while the action is already running", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog state={{ ...state, onConfirm }} onClose={vi.fn()} pending />);

    const confirm = screen.getByRole("button", { name: "Working…" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.click(confirm);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("states the consequence when no message is given, rather than an empty dialog", () => {
    render(<ConfirmDialog state={{ onConfirm: vi.fn() }} onClose={vi.fn()} />);

    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("renders an unknown tone rather than nothing — statuses come off the wire", () => {
    render(<Badge color="not-a-tone">degraded</Badge>);
    expect(screen.getByText("degraded")).toBeInTheDocument();
  });
});

describe("Select", () => {
  it("shows the error in place of the hint", () => {
    render(
      <Select
        label="Site"
        hint="Where the camera lives"
        error="Pick a site"
        options={[{ value: "s1", label: "HQ" }]}
      />,
    );

    expect(screen.getByText("Pick a site")).toBeInTheDocument();
    expect(screen.queryByText("Where the camera lives")).toBeNull();
  });
});

describe("Table", () => {
  interface Row {
    id: string;
    name: string;
    count: number;
  }
  const columns = [
    { key: "name", label: "Name" },
    { key: "count", label: "Count", align: "right" as const },
  ];
  const rows: Row[] = [
    { id: "a", name: "Lobby", count: 2 },
    { id: "b", name: "Dock", count: 7 },
  ];

  it("renders exactly one row per record, plus the header", () => {
    render(<Table columns={columns} rows={rows} />);

    // 2 records + 1 header row.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.getByText("Dock")).toBeInTheDocument();
  });

  it("reads a cell by its column key when the column has no renderer", () => {
    render(<Table columns={columns} rows={rows} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("prefers the column's renderer over the raw field", () => {
    render(
      <Table
        columns={[{ key: "count", label: "Count", render: (r: Row) => `${r.count} cams` }]}
        rows={rows}
      />,
    );

    expect(screen.getByText("2 cams")).toBeInTheDocument();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("renders the caller's own empty node, so `no results` and `load failed` can differ", () => {
    render(<Table columns={columns} rows={[]} empty={<p>Could not reach the recorder</p>} />);

    expect(screen.getByText("Could not reach the recorder")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  it("treats a null row list as empty rather than crashing on it", () => {
    render(<Table columns={columns} rows={null} />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });
});
