/**
 * THE PICKER THAT USED TO EXIST TWICE.
 *
 * TriggerForm and TransitionModal each carried their own copy, each with a
 * comment saying the other one was "also mirrored" — which is a note, not a
 * control. They are one component now, and this is what keeps the behaviour from
 * quietly changing under whichever caller nobody opened this month:
 *
 *   * SEARCH MATCHES THE EMAIL TOO. An invited account has an address and no name
 *     yet, so a picker that searches names only cannot find the people who most
 *     need assigning.
 *   * A SELECTED USER IS STILL IN THE LIST, checked — not moved to the chips and
 *     removed from where the operator was looking.
 *   * TOGGLE AND CLEAR REPORT UPWARD. This component holds no selection of its
 *     own; the two callers own it, and a selection kept here would be a second
 *     answer to the same question.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import UserMultiSelect from "./UserMultiSelect";

// Anita has a name; the second account is an invite that has not been accepted,
// so all it has is an address. Both have to be findable.
const USERS = [
  { id: "u1", full_name: "Anita Rao", email: "anita@example.com" },
  { id: "u2", full_name: "", email: "newjoiner@example.com" },
];

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

function show(props: Partial<React.ComponentProps<typeof UserMultiSelect>> = {}) {
  const onToggle = vi.fn();
  const onClear = vi.fn();
  render(
    <UserMultiSelect label="Assign to" selectedIds={[]} onToggle={onToggle} onClear={onClear} {...props} />,
    { wrapper },
  );
  return { onToggle, onClear };
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: { items: USERS } });
});

describe("UserMultiSelect", () => {
  it("shows a user by name, and an un-named invite by its address", async () => {
    show();
    expect(await screen.findByText("Anita Rao")).toBeInTheDocument();
    expect(screen.getByText("newjoiner@example.com")).toBeInTheDocument();
  });

  it("searches the email as well as the name", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Anita Rao");

    // "newjoiner" appears in no full_name anywhere. A name-only search finds
    // nobody here, which is exactly the account somebody is trying to assign.
    await user.type(screen.getByRole("textbox"), "newjoiner");
    expect(screen.getByText("newjoiner@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Anita Rao")).not.toBeInTheDocument();
  });

  it("says what matched nothing rather than showing an empty box", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Anita Rao");
    await user.type(screen.getByRole("textbox"), "zzz");
    expect(screen.getByText(/No users match/)).toBeInTheDocument();
  });

  it("reports a tick upward and keeps the row where it was", async () => {
    const user = userEvent.setup();
    const { onToggle } = show();
    await screen.findByText("Anita Rao");

    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(onToggle).toHaveBeenCalledWith("u1");
    // Nothing moved: the component holds no selection, so the list is unchanged
    // until the caller hands back a new `selectedIds`.
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
  });

  it("shows a selected user as a chip AND as a ticked row", async () => {
    show({ selectedIds: ["u1"] });
    await screen.findByLabelText("Remove Anita Rao");
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("removes from the chip, and clears the lot from the header", async () => {
    const user = userEvent.setup();
    const { onToggle, onClear } = show({ selectedIds: ["u1", "u2"] });

    await user.click(await screen.findByLabelText("Remove Anita Rao"));
    expect(onToggle).toHaveBeenCalledWith("u1");

    await user.click(screen.getByRole("button", { name: "clear" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("offers no clear button when nothing is selected", async () => {
    show();
    await screen.findByText("Anita Rao");
    expect(screen.queryByRole("button", { name: "clear" })).not.toBeInTheDocument();
  });
});
