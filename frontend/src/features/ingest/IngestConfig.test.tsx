/**
 * The ingest console is a master/detail rail, and three of its properties are
 * the ones that hurt when they are wrong:
 *
 *   1. A FAILED LOAD and an EMPTY ESTATE must not look the same. "No categories
 *      yet" in front of an operator whose categories exist is how a duplicate
 *      gets created — the rail did read that way, and this pins the fix.
 *   2. Selection is derived (`selectedId ?? filtered[0]`), so the first row is
 *      shown without a click AND an explicit choice survives a refetch.
 *   3. Deleting a category takes its webhooks with it. The API must not be
 *      touched until the operator confirms in the dialog.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import IngestConfigPage from "./IngestConfig";
import { ingest as ingestApi } from "./api";
import type { CategoryPublic } from "./types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function cat(id: string, name: string, description: string | null = null): CategoryPublic {
  return {
    id,
    name,
    description,
    target_domain: "vendor",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    webhook_count: 0,
  };
}

const DOORS = cat("c1", "Door vendors", "Access hardware");
const METERS = cat("c2", "Meter vendors", "Energy hardware");

/** The detail pane runs its own webhook query; only the page is under test. */
beforeEach(() => {
  vi.spyOn(ingestApi.webhooks, "list").mockResolvedValue({
    items: [],
    total: 0,
    skip: 0,
    limit: 100,
  });
});

function listReturns(items: CategoryPublic[]) {
  return vi
    .spyOn(ingestApi.categories, "list")
    .mockResolvedValue({ items, total: items.length, skip: 0, limit: 100 });
}

describe("a failed load", () => {
  it("reports the failure instead of an estate with nothing configured", async () => {
    vi.spyOn(ingestApi.categories, "list").mockRejectedValue(new Error("ingest service is down"));

    renderWithProviders(<IngestConfigPage />);

    expect(await screen.findByText(/ingest service is down/i)).toBeInTheDocument();
    expect(screen.queryByText(/no categories yet/i)).not.toBeInTheDocument();
  });

  it("still says there are none when the estate genuinely is empty", async () => {
    listReturns([]);

    renderWithProviders(<IngestConfigPage />);

    expect(await screen.findByText(/no categories yet/i)).toBeInTheDocument();
  });
});

describe("the derived selection", () => {
  it("opens on the first category, so the detail pane is never blank on arrival", async () => {
    listReturns([DOORS, METERS]);

    renderWithProviders(<IngestConfigPage />);

    expect(await screen.findByRole("heading", { name: "Door vendors" })).toBeInTheDocument();
    expect(screen.queryByText(/no category selected/i)).not.toBeInTheDocument();
  });

  it("keeps an explicit choice across a refetch rather than snapping back to the first", async () => {
    listReturns([DOORS, METERS]);
    const { client } = renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("Meter vendors"));
    expect(await screen.findByRole("heading", { name: "Meter vendors" })).toBeInTheDocument();

    await client.invalidateQueries({ queryKey: ["ingest-categories"] });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Meter vendors" })).toBeInTheDocument(),
    );
  });

  it("keeps the open detail while the search narrows the rail beside it", async () => {
    listReturns([DOORS, METERS]);
    renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("Meter vendors"));
    await user.type(screen.getByPlaceholderText(/search categories/i), "Door");

    // The rail is filtered...
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Meter vendors/ })).not.toBeInTheDocument(),
    );
    // ...but what the operator was reading is not yanked out from under them.
    expect(screen.getByRole("heading", { name: "Meter vendors" })).toBeInTheDocument();
  });

  it("says nothing matches the search without claiming the estate is empty", async () => {
    listReturns([DOORS]);
    renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText(/search categories/i), "zzz");

    expect(await screen.findByText(/no categories match your search/i)).toBeInTheDocument();
    expect(screen.queryByText(/no categories yet/i)).not.toBeInTheDocument();
  });
});

describe("deleting a category", () => {
  it("does not call the API until the operator confirms", async () => {
    listReturns([DOORS]);
    const remove = vi.spyOn(ingestApi.categories, "remove").mockResolvedValue(undefined);
    renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTitle("Delete category"));

    // The dialog is open and the estate is untouched.
    expect(await screen.findByText(/delete category\?/i)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("c1"));
  });

  it("leaves the category alone when the operator backs out", async () => {
    listReturns([DOORS]);
    const remove = vi.spyOn(ingestApi.categories, "remove").mockResolvedValue(undefined);
    renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTitle("Delete category"));
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/delete category\?/i)).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  it("names the category and its webhooks in the warning, since both go", async () => {
    listReturns([DOORS]);
    vi.spyOn(ingestApi.categories, "remove").mockResolvedValue(undefined);
    renderWithProviders(<IngestConfigPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTitle("Delete category"));

    expect(
      await screen.findByText(/Delete "Door vendors" and all of its webhooks/i),
    ).toBeInTheDocument();
  });
});
