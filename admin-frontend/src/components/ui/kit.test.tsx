import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, StatCard } from "@/components/ui";

describe("Button", () => {
  it("is not clickable while loading — a double submit is the bug this prevents", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );

    const button = screen.getByRole("button", { name: /save/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicks normally when idle", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Input", () => {
  it("marks itself invalid for assistive tech, and only when invalid", () => {
    const { rerender } = render(<Input aria-label="Email" />);
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid");

    rerender(<Input aria-label="Email" invalid />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Field", () => {
  it("shows the error in place of the hint", () => {
    render(
      <Field label="Email" hint="We never share it" error="Enter a valid email">
        <Input aria-label="Email" />
      </Field>
    );

    expect(screen.getByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.queryByText("We never share it")).not.toBeInTheDocument();
  });

  it("marks a required field", () => {
    render(
      <Field label="Email" required>
        <Input aria-label="Email" />
      </Field>
    );

    expect(screen.getByText("*")).toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("renders a status dot only when asked", () => {
    // The pill itself is rounded-full, so the dot is identified by its tone fill.
    const { container, rerender } = render(<Badge tone="success">Active</Badge>);
    expect(container.querySelector("span.bg-success")).toBeNull();

    rerender(
      <Badge tone="success" dot>
        Active
      </Badge>
    );
    expect(container.querySelector("span.bg-success")).toBeTruthy();
  });
});

describe("StatCard", () => {
  it("renders the label, value and hint", () => {
    render(<StatCard label="Tenants" value={42} hint="3 suspended" tone="warning" />);

    expect(screen.getByText("Tenants")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("3 suspended")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders the action so a zero state is never a dead end", () => {
    render(<EmptyState title="No tenants" action={<Button>Create tenant</Button>} />);

    expect(screen.getByRole("button", { name: /create tenant/i })).toBeInTheDocument();
  });
});

describe("ConfirmDialog", () => {
  it("only fires the destructive action on confirm", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete tenant?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(
      <ConfirmDialog open={false} onOpenChange={() => {}} title="Delete tenant?" onConfirm={vi.fn()} />
    );

    expect(screen.queryByText("Delete tenant?")).not.toBeInTheDocument();
  });
});
